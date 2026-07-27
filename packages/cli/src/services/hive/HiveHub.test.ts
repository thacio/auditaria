/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE
//
// Integration tests: a real HiveHub on a loopback port + real HiveWireClient
// connections exercising the full handshake, TOFU binding, routing, acks,
// queue persistence and admin ops. PBKDF2 runs at full cost once per
// passphrase+salt (cached), so the suite stays fast enough.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startHiveHub, type HiveHubHandle } from './HiveHub.js';
import { HiveWireClient } from './HiveWireClient.js';
import { generateIdentityKeyPair, makeNodeId, makeUlid } from './HiveCrypto.js';
import type {
  AgentCard,
  DeliverMsg,
  HiveEnvelope,
  TrustPolicy,
} from './types.js';

const PASS = 'test-pass-phrase';

let dir: string;
let hub: HiveHubHandle | undefined;
const clients: HiveWireClient[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-hub-test-'));
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop();
  if (hub) {
    await hub.close();
    hub = undefined;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
});

function makeCard(nickname: string, nodeId: string): AgentCard {
  return {
    nodeId,
    nickname,
    machine: 'test-machine',
    platform: 'test',
    cwdName: 'proj',
    provider: 'test-model',
    clientKind: 'auditaria',
    capabilities: [],
    selfDescription: `${nickname} test node`,
    status: 'idle',
    exposesSubAgents: false,
    lastSeen: Date.now(),
  };
}

interface TestClient {
  client: HiveWireClient;
  nodeId: string;
  delivered: DeliverMsg[];
}

async function connectClient(
  hubHandle: HiveHubHandle,
  nickname: string,
  opts: {
    passphrase?: string;
    inviteToken?: string;
    identity?: ReturnType<typeof generateIdentityKeyPair> & { nodeId: string };
    autoAck?: boolean;
  } = {},
): Promise<TestClient> {
  const keys = opts.identity ?? {
    ...generateIdentityKeyPair(),
    nodeId: makeNodeId(),
  };
  const delivered: DeliverMsg[] = [];
  const client = new HiveWireClient({
    url: `http://127.0.0.1:${hubHandle.port}/${hubHandle.urlToken}`,
    passphrase: opts.passphrase ?? PASS,
    identity: {
      nodeId: keys.nodeId,
      publicKeyPem: keys.publicKeyPem,
      privateKeyPem: keys.privateKeyPem,
    },
    inviteToken: opts.inviteToken,
    getCard: () => makeCard(nickname, keys.nodeId),
  });
  clients.push(client);
  client.on('deliver', (msg: DeliverMsg) => {
    delivered.push(msg);
    if (opts.autoAck !== false) client.ack(msg.env.id, 'delivered');
  });
  const welcome = new Promise<void>((resolve, reject) => {
    client.once('welcome', () => resolve());
    client.once('authfail', (reason: string) =>
      reject(new Error(`authfail: ${reason}`)),
    );
    setTimeout(() => reject(new Error('welcome timeout')), 20_000);
  });
  client.start();
  await welcome;
  return { client, nodeId: keys.nodeId, delivered };
}

function envTo(from: string, to: string, body: string): HiveEnvelope {
  return {
    id: makeUlid(),
    thread: `t_test`,
    from,
    to,
    kind: 'chat',
    body,
    hops: 0,
    ttlSec: 3_600,
    ts: Date.now(),
  };
}

async function startHub(trustPolicy: TrustPolicy = 'open') {
  hub = await startHiveHub({
    passphrase: PASS,
    port: 0,
    trustPolicy,
    dataDir: dir,
  });
  return hub;
}

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('HiveHub', () => {
  it('authenticates with the right passphrase and rejects the wrong one', async () => {
    const h = await startHub();
    const a = await connectClient(h, 'alpha');
    expect(a.client.getNickname()).toBe('alpha');
    expect(a.client.getTrust()).toBe('full'); // trustPolicy 'open'

    const bad = new HiveWireClient({
      url: `http://127.0.0.1:${h.port}/${h.urlToken}`,
      passphrase: 'wrong-pass',
      identity: { ...generateIdentityKeyPair(), nodeId: makeNodeId() },
      getCard: () => makeCard('bad', 'n_bad'),
    });
    clients.push(bad);
    const failReason = await new Promise<string>((resolve) => {
      bad.once('authfail', (reason: string) => resolve(reason));
      bad.start();
      setTimeout(() => resolve('no authfail received'), 20_000);
    });
    expect(failReason).toContain('invalid passphrase');
  }, 40_000);

  it('heals a rotated hub address via getFallbackUrls and reports the switch', async () => {
    const h = await startHub();
    const liveUrl = `http://127.0.0.1:${h.port}/${h.urlToken}`;
    // Primary URL is dead (nothing listens on port 1) — simulates the saved
    // quick-tunnel hostname after a hub restart rotated it.
    const switched: string[] = [];
    const keys = { ...generateIdentityKeyPair(), nodeId: makeNodeId() };
    const client = new HiveWireClient({
      url: 'http://127.0.0.1:1/stale-token',
      passphrase: PASS,
      identity: {
        nodeId: keys.nodeId,
        publicKeyPem: keys.publicKeyPem,
        privateKeyPem: keys.privateKeyPem,
      },
      getCard: () => makeCard('healer', keys.nodeId),
      getFallbackUrls: () => [liveUrl],
      onUrlSwitched: (url) => switched.push(url),
    });
    clients.push(client);
    const welcome = new Promise<void>((resolve, reject) => {
      client.once('welcome', () => resolve());
      client.once('authfail', (reason: string) =>
        reject(new Error(`authfail: ${reason}`)),
      );
      setTimeout(() => reject(new Error('welcome timeout')), 20_000);
    });
    client.start();
    await welcome;
    expect(switched).toEqual([liveUrl]);
    expect(client.getNickname()).toBe('healer');
  }, 40_000);

  it('routes a direct message, deletes it on delivered-ack, forwards processed receipts', async () => {
    const h = await startHub();
    const a = await connectClient(h, 'alpha');
    const b = await connectClient(h, 'beta');

    const receipts: Array<{ id: string; level: string }> = [];
    a.client.on('receipt', (r: { id: string; level: string }) =>
      receipts.push(r),
    );

    const env = envTo(a.nodeId, b.nodeId, 'hello beta');
    env.ack = 'processed';
    const res = await a.client.sendEnvelope(env);
    expect(res.states[b.nodeId]).toBe('delivered');

    await waitFor(() => b.delivered.length === 1);
    expect(b.delivered[0].env.body).toBe('hello beta');
    expect(b.delivered[0].env.from).toBe(a.nodeId);

    b.client.ack(env.id, 'processed');
    await waitFor(() => receipts.length === 1);
    expect(receipts[0]).toMatchObject({ id: env.id, level: 'processed' });
  }, 40_000);

  it('queues for offline peers and replays on reconnect (dedup holds)', async () => {
    const h = await startHub();
    const a = await connectClient(h, 'alpha');
    const bIdentity = { ...generateIdentityKeyPair(), nodeId: makeNodeId() };
    // Enroll beta, then take it offline.
    const b1 = await connectClient(h, 'beta', { identity: bIdentity });
    b1.client.stop();
    await waitFor(() =>
      h.listRoster().every((e) => e.card.nickname !== 'beta' || !e.online),
    );

    const env = envTo(a.nodeId, bIdentity.nodeId, 'while you were away');
    const res = await a.client.sendEnvelope(env);
    expect(res.states[bIdentity.nodeId]).toBe('queued');

    // Reconnect: the queued envelope replays.
    const b2 = await connectClient(h, 'beta', { identity: bIdentity });
    await waitFor(() => b2.delivered.length === 1);
    expect(b2.delivered[0].env.body).toBe('while you were away');
  }, 40_000);

  it('restores undelivered queues across a hub restart (custody chain)', async () => {
    const h1 = await startHub();
    const a = await connectClient(h1, 'alpha');
    const bIdentity = { ...generateIdentityKeyPair(), nodeId: makeNodeId() };
    const b1 = await connectClient(h1, 'beta', { identity: bIdentity });
    b1.client.stop();
    await new Promise((r) => setTimeout(r, 100));

    const env = envTo(a.nodeId, bIdentity.nodeId, 'survive the crash');
    await a.client.sendEnvelope(env);

    // Hub dies and comes back with the same dataDir.
    a.client.stop();
    await h1.close();
    hub = undefined;
    const h2 = await startHub();

    const b2 = await connectClient(h2, 'beta', { identity: bIdentity });
    await waitFor(() => b2.delivered.length === 1);
    expect(b2.delivered[0].env.body).toBe('survive the crash');
  }, 40_000);

  it('broadcast fans out to everyone except the sender with a per-peer state map', async () => {
    const h = await startHub();
    const a = await connectClient(h, 'alpha');
    const b = await connectClient(h, 'beta');
    const c = await connectClient(h, 'gamma');

    const env = envTo(a.nodeId, '*', 'hello everyone');
    const res = await a.client.sendEnvelope(env);
    expect(Object.keys(res.states).sort()).toEqual([b.nodeId, c.nodeId].sort());
    await waitFor(() => b.delivered.length === 1 && c.delivered.length === 1);
    expect(a.delivered.length).toBe(0);
  }, 40_000);

  it('a broadcast with ack=processed yields one processed receipt PER peer', async () => {
    const h = await startHub();
    const a = await connectClient(h, 'alpha');
    const b = await connectClient(h, 'beta');
    const c = await connectClient(h, 'gamma');

    const receipts: Array<{ by: string; level: string }> = [];
    a.client.on('receipt', (r: { by: string; level: string }) =>
      receipts.push(r),
    );

    const env = envTo(a.nodeId, '*', 'all hands');
    env.ack = 'processed';
    await a.client.sendEnvelope(env);
    await waitFor(() => b.delivered.length === 1 && c.delivered.length === 1);

    // Both recipients process it and ack processed.
    b.client.ack(env.id, 'processed');
    c.client.ack(env.id, 'processed');

    await waitFor(
      () => receipts.filter((r) => r.level === 'processed').length === 2,
    );
    const processedBy = receipts
      .filter((r) => r.level === 'processed')
      .map((r) => r.by)
      .sort();
    expect(processedBy).toEqual([b.nodeId, c.nodeId].sort());
  }, 40_000);

  it('TOFU: rejects a connection claiming an enrolled nodeId with a different key', async () => {
    const h = await startHub();
    const original = await connectClient(h, 'alpha');

    const impostorKeys = generateIdentityKeyPair();
    const impostor = new HiveWireClient({
      url: `http://127.0.0.1:${h.port}/${h.urlToken}`,
      passphrase: PASS,
      identity: {
        nodeId: original.nodeId, // claims alpha's id…
        publicKeyPem: impostorKeys.publicKeyPem, // …with a different key
        privateKeyPem: impostorKeys.privateKeyPem,
      },
      getCard: () => makeCard('alpha', original.nodeId),
    });
    clients.push(impostor);
    const reason = await new Promise<string>((resolve) => {
      impostor.once('authfail', (r: string) => resolve(r));
      impostor.start();
      setTimeout(() => resolve('no authfail'), 20_000);
    });
    expect(reason).toContain('bound to a different key');
  }, 40_000);

  it('invite policy: enrollment without a token is refused; a token carries its trust level', async () => {
    const h = await startHub('invite');
    // No token → refused.
    const noToken = new HiveWireClient({
      url: `http://127.0.0.1:${h.port}/${h.urlToken}`,
      passphrase: PASS,
      identity: { ...generateIdentityKeyPair(), nodeId: makeNodeId() },
      getCard: () => makeCard('lonely', 'n_x'),
    });
    clients.push(noToken);
    const reason = await new Promise<string>((resolve) => {
      noToken.once('authfail', (r: string) => resolve(r));
      noToken.start();
      setTimeout(() => resolve('no authfail'), 20_000);
    });
    expect(reason).toContain('invite');

    // Consult token → enrolled at consult level.
    const token = h.mintInvite('consult');
    const gated = await connectClient(h, 'gated', { inviteToken: token });
    expect(gated.client.getTrust()).toBe('consult');

    // The token is single-use.
    const reuse = new HiveWireClient({
      url: `http://127.0.0.1:${h.port}/${h.urlToken}`,
      passphrase: PASS,
      identity: { ...generateIdentityKeyPair(), nodeId: makeNodeId() },
      inviteToken: token,
      getCard: () => makeCard('reuser', 'n_y'),
    });
    clients.push(reuse);
    const reuseReason = await new Promise<string>((resolve) => {
      reuse.once('authfail', (r: string) => resolve(r));
      reuse.start();
      setTimeout(() => resolve('no authfail'), 20_000);
    });
    expect(reuseReason).toContain('invite');
  }, 60_000);

  it('admin trust/untrust changes a peer hive-wide; consult peers cannot administer', async () => {
    const h = await startHub();
    const a = await connectClient(h, 'alpha');
    const consultToken = h.mintInvite('consult');
    const b = await connectClient(h, 'beta', { inviteToken: consultToken });
    expect(b.client.getTrust()).toBe('consult');

    // Consult peer cannot administer.
    const denied = await b.client.admin('trust', { nickname: 'alpha' });
    expect(denied.ok).toBe(false);

    // Trusted peer promotes beta.
    const promoted = await a.client.admin('trust', { nickname: 'beta' });
    expect(promoted.ok).toBe(true);
    await waitFor(
      () =>
        a.client.getRoster().find((e) => e.card.nickname === 'beta')?.trust ===
        'full',
    );
  }, 60_000);

  it('suffixes visually-colliding nicknames', async () => {
    const h = await startHub();
    await connectClient(h, 'amber-falcon');
    const second = await connectClient(h, 'Amber-Falcon');
    expect(second.client.getNickname()).not.toBe('Amber-Falcon');
    expect(second.client.getNickname()).toMatch(/-2$/);
  }, 40_000);

  it('nicknames with hostile card fields are sanitized', async () => {
    const h = await startHub();
    const keys = { ...generateIdentityKeyPair(), nodeId: makeNodeId() };
    const evilDesc = 'desc' + String.fromCharCode(27) + '[2Jwiped';
    const client = new HiveWireClient({
      url: `http://127.0.0.1:${h.port}/${h.urlToken}`,
      passphrase: PASS,
      identity: {
        nodeId: keys.nodeId,
        publicKeyPem: keys.publicKeyPem,
        privateKeyPem: keys.privateKeyPem,
      },
      getCard: () => ({
        ...makeCard('clean', keys.nodeId),
        selfDescription: evilDesc,
      }),
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('welcome', () => resolve());
      client.once('authfail', (r: string) => reject(new Error(r)));
      client.start();
      setTimeout(() => reject(new Error('timeout')), 20_000);
    });
    const entry = hub!.listRoster().find((e) => e.card.nodeId === keys.nodeId);
    expect(entry?.card.selfDescription).not.toContain(String.fromCharCode(27));
  }, 40_000);

  // AUDITARIA_HIVE_FEATURE: guards the sanitizeCard drop-bug (the hub rebuilds
  // the card field-by-field) + the CardMsg.patch Pick — advisory delivery
  // presence must survive BOTH the auth card and a live updateCard patch.
  it('propagates advisory delivery presence (deliveryMode + lastConsumedTs)', async () => {
    const h = await startHub();
    const keys = { ...generateIdentityKeyPair(), nodeId: makeNodeId() };
    const consumedAt = Date.now() - 1_000;
    const client = new HiveWireClient({
      url: `http://127.0.0.1:${h.port}/${h.urlToken}`,
      passphrase: PASS,
      identity: {
        nodeId: keys.nodeId,
        publicKeyPem: keys.publicKeyPem,
        privateKeyPem: keys.privateKeyPem,
      },
      getCard: () => ({
        ...makeCard('router', keys.nodeId),
        deliveryMode: 'manual',
        lastConsumedTs: consumedAt,
      }),
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('welcome', () => resolve());
      client.once('authfail', (r: string) => reject(new Error(r)));
      client.start();
      setTimeout(() => reject(new Error('timeout')), 20_000);
    });
    // Auth-card path: the fields survive the hub's sanitizeCard rebuild.
    const entry = hub!.listRoster().find((e) => e.card.nodeId === keys.nodeId);
    expect(entry?.card.deliveryMode).toBe('manual');
    expect(entry?.card.lastConsumedTs).toBe(consumedAt);

    // Live-patch path: updateCard({ deliveryMode, lastConsumedTs }) reaches an
    // observing peer's roster (exercises the CardMsg.patch Pick extension).
    const observer = await connectClient(h, 'observer');
    client.updateCard({ deliveryMode: 'auto', lastConsumedTs: consumedAt + 5 });
    await waitFor(() => {
      const c = observer.client
        .getRoster()
        .find((e) => e.card.nodeId === keys.nodeId)?.card;
      return c?.deliveryMode === 'auto' && c?.lastConsumedTs === consumedAt + 5;
    });
  }, 40_000);
});
