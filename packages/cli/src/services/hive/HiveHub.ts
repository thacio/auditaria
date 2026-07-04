/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Mode-A embedded relay (§3): roster registry, disk-persisted per-peer
// queues (restored on restart), fan-out, relay-side rate limits, TOFU
// identity binding and invite-token enrollment. Runs in-process on one
// Auditaria node, fronted by a cloudflared quick tunnel. The hub machine is
// also a normal peer: its own HiveService connects over loopback.
//
// Reliability rules implemented here (§5.2):
//  - a message is durably queued (fsync) BEFORE the sender sees 'queued'/'delivered'
//  - the queue entry is deleted only on the receiver's 'delivered' ack
//  - acks are idempotent — re-acking an already-deleted entry is a no-op
//  - TTL is enforced on the relay's clock; expiry produces a receipt to the sender
//  - per-peer queue depth cap; overflow is reported to the sender, never silent

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AUTH_TIMEOUT_MS,
  AUTH_FAIL_WINDOW_MS,
  DEFAULT_TTL_SEC,
  HIVE_PROTOCOL_VERSION,
  INVITE_TTL_MS,
  MAX_AUTH_FAILS,
  MAX_MESSAGE_BYTES,
  QUEUE_DEPTH_CAP,
  RATE_LIMIT_PER_MIN,
  type AckMsg,
  type AdminMsg,
  type AdminResultMsg,
  type AgentCard,
  type AuthMsg,
  type CardMsg,
  type ClientToHubMsg,
  type EventMsg,
  type HiveEnvelope,
  type HubToClientMsg,
  type RosterEntry,
  type SendMsg,
  type SendState,
  type TrustLevel,
  type TrustPolicy,
} from './types.js';
import {
  CHALLENGE_LEN,
  PBKDF2_ITERATIONS,
  SALT_LEN,
  deriveAuthKey,
  deriveMaster,
  fingerprintOfPublicKey,
  fromB64,
  generateIdentityKeyPair,
  makeAuthProof,
  makeInviteTokenId,
  makeUrlToken,
  normalizeNickname,
  randomBytes,
  sanitizeExternalText,
  sanitizeInline,
  signChallenge,
  toB64,
  verifyAuthResponse,
  verifyChallengeSignature,
} from './HiveCrypto.js';
import { JsonlQueueStore, readJsonFile, writeJsonFile } from './HiveStore.js';

// -------------------------------------------------------------------
// Persisted hub state
// -------------------------------------------------------------------

interface Enrollment {
  fingerprint: string;
  nickname: string;
  trust: TrustLevel;
  blocked?: boolean;
  enrolledAt: number;
}

interface InviteRecord {
  trust: TrustLevel;
  expiresAt: number;
  used?: boolean;
}

interface HubState {
  urlToken: string;
  saltB64: string;
  hubPublicKeyPem: string;
  hubPrivateKeyPem: string;
  enrollments: Record<string, Enrollment>;
  invites: Record<string, InviteRecord>;
}

interface QueuedEnvelope {
  env: HiveEnvelope;
  /** Relay-clock enqueue time — TTL is measured from here (§5.2). */
  enqueuedAt: number;
  /** Sender requested an end-to-end processed receipt. */
  wantsReceipt: boolean;
}

export interface HiveHubOptions {
  passphrase: string;
  port?: number;
  /** New-enrollment posture. Default 'open' — see TrustPolicy in types.ts. */
  trustPolicy?: TrustPolicy;
  dataDir?: string;
  /** Called for operational notices (shown as dim UI lines). */
  onLog?: (text: string) => void;
}

export interface HiveHubHandle {
  port: number;
  urlToken: string;
  hubFingerprint: string;
  /** Mint a single-use invite token with an embedded trust level. */
  mintInvite(trust: TrustLevel): string;
  listRoster(): RosterEntry[];
  close(): Promise<void>;
}

interface PeerConn {
  ws: WebSocket;
  nodeId: string;
  card: AgentCard;
  trust: TrustLevel;
  /** Token bucket for the relay-side rate limit. */
  tokens: number;
  lastRefill: number;
  /** seq of entries delivered but not yet 'delivered'-acked. */
  inFlight: Set<number>;
}

function defaultDataDir(): string {
  return path.join(os.homedir(), '.auditaria', 'hive', 'hub');
}

export async function startHiveHub(
  options: HiveHubOptions,
): Promise<HiveHubHandle> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const statePath = path.join(dataDir, 'hub.json');
  const trustPolicy: TrustPolicy = options.trustPolicy ?? 'open';
  const log = options.onLog ?? (() => {});

  // ---------------- persisted state ----------------
  let state = readJsonFile<HubState>(statePath);
  if (!state) {
    const keys = generateIdentityKeyPair();
    state = {
      urlToken: makeUrlToken(),
      saltB64: toB64(randomBytes(SALT_LEN)),
      hubPublicKeyPem: keys.publicKeyPem,
      hubPrivateKeyPem: keys.privateKeyPem,
      enrollments: {},
      invites: {},
    };
    writeJsonFile(statePath, state);
  }
  const saveState = () => writeJsonFile(statePath, state);

  // Prune expired invites on start.
  const nowMs = Date.now();
  for (const [id, inv] of Object.entries(state.invites)) {
    if (inv.used || inv.expiresAt < nowMs) delete state.invites[id];
  }
  saveState();

  // KDF cost control (§7.1): static per-hive salt → derive once, cache.
  const salt = fromB64(state.saltB64);
  const master = await deriveMaster(
    options.passphrase,
    salt,
    PBKDF2_ITERATIONS,
  );
  const hubFingerprint = fingerprintOfPublicKey(state.hubPublicKeyPem);

  // ---------------- per-peer durable queues ----------------
  const queues = new Map<string, JsonlQueueStore<QueuedEnvelope>>();
  const dlq = new JsonlQueueStore<QueuedEnvelope>(
    path.join(dataDir, 'dlq.jsonl'),
  );
  dlq.load();

  const queueFor = (nodeId: string): JsonlQueueStore<QueuedEnvelope> => {
    let q = queues.get(nodeId);
    if (!q) {
      q = new JsonlQueueStore<QueuedEnvelope>(
        path.join(dataDir, 'queue', `${sanitizeFileName(nodeId)}.jsonl`),
      );
      q.load();
      queues.set(nodeId, q);
    }
    return q;
  };

  // Restore queues for all enrolled peers so counts are right immediately.
  for (const nodeId of Object.keys(state.enrollments)) {
    queueFor(nodeId);
  }

  // ---------------- runtime state ----------------
  const conns = new Map<string, PeerConn>(); // nodeId -> live connection
  const fails = new Map<string, { count: number; first: number }>();
  let unauthedCount = 0;
  const MAX_UNAUTHED = 16;

  // ---------------- helpers ----------------

  function sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function send(ws: WebSocket, msg: HubToClientMsg): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      /* connection died mid-send; reconnect logic recovers */
      return false;
    }
  }

  function isLoopbackAddr(ip: string | undefined): boolean {
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  }

  /**
   * The lockout bucket key. Behind the tunnel every connection's socket
   * address is the Cloudflare edge (shared by all users — useless as a key),
   * so we bucket on cf-connecting-ip when present. This header is set by
   * Cloudflare and cannot be forged by a client going through the tunnel.
   * Direct connections (loopback peer, LAN) fall back to the socket address.
   */
  function lockoutKey(req: IncomingMessage): string {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return `cf:${cf}`;
    return `sock:${req.socket.remoteAddress ?? 'unknown'}`;
  }

  /**
   * Loopback exemption keys on the REAL TCP peer address, never a header —
   * a client-supplied `cf-connecting-ip: 127.0.0.1` must not exempt itself
   * from lockout. Only a genuine loopback socket (the hub's own peer) is
   * exempt.
   */
  function isLoopbackConn(req: IncomingMessage): boolean {
    return isLoopbackAddr(req.socket.remoteAddress);
  }

  function isLockedOut(req: IncomingMessage): boolean {
    if (isLoopbackConn(req)) return false;
    const key = lockoutKey(req);
    const rec = fails.get(key);
    if (!rec) return false;
    if (Date.now() - rec.first > AUTH_FAIL_WINDOW_MS) {
      fails.delete(key);
      return false;
    }
    return rec.count >= MAX_AUTH_FAILS;
  }

  function noteFail(req: IncomingMessage): void {
    if (isLoopbackConn(req)) return;
    const key = lockoutKey(req);
    const rec = fails.get(key);
    if (!rec || Date.now() - rec.first > AUTH_FAIL_WINDOW_MS) {
      fails.set(key, { count: 1, first: Date.now() });
    } else {
      rec.count += 1;
    }
  }

  function rosterEntryFor(nodeId: string): RosterEntry | undefined {
    const enr = state!.enrollments[nodeId];
    if (!enr || enr.blocked) return undefined;
    const live = conns.get(nodeId);
    const card: AgentCard = live
      ? live.card
      : {
          nodeId,
          nickname: enr.nickname,
          machine: '',
          platform: '',
          cwdName: '',
          provider: '',
          clientKind: 'auditaria',
          capabilities: [],
          selfDescription: '',
          status: 'offline',
          exposesSubAgents: false,
          lastSeen: 0,
          deliveryMode: 'auto', // AUDITARIA_HIVE_FEATURE
          lastConsumedTs: 0, // AUDITARIA_HIVE_FEATURE
        };
    return {
      card,
      trust: enr.trust,
      online: !!live,
      queued: queueFor(nodeId).size,
    };
  }

  function fullRoster(): RosterEntry[] {
    return Object.keys(state!.enrollments)
      .map((id) => rosterEntryFor(id))
      .filter((e): e is RosterEntry => !!e);
  }

  function broadcastEvent(ev: EventMsg, exceptNodeId?: string): void {
    for (const [nodeId, conn] of conns) {
      if (nodeId === exceptNodeId) continue;
      send(conn.ws, ev);
    }
  }

  /** Sanitize every externally-authored card field before it goes anywhere. */
  function sanitizeCard(
    card: Partial<AgentCard> | undefined,
    nodeId: string,
  ): AgentCard {
    card = card ?? {};
    return {
      nodeId,
      // Single-line fields use the stricter inline sanitizer (no newlines /
      // quotes / angle brackets) so they can't inject adjacent lines into a
      // fence attribute or spoof a roster/feed row.
      nickname: sanitizeInline(String(card.nickname ?? ''), 60),
      machine: sanitizeInline(String(card.machine ?? ''), 80),
      platform: sanitizeInline(String(card.platform ?? ''), 20),
      cwdName: sanitizeInline(String(card.cwdName ?? ''), 80),
      provider: sanitizeInline(String(card.provider ?? ''), 80),
      clientKind: card.clientKind === 'mcp-shim' ? 'mcp-shim' : 'auditaria',
      capabilities: Array.isArray(card.capabilities)
        ? card.capabilities
            .slice(0, 20)
            .map((c) => sanitizeInline(String(c), 60))
        : [],
      // selfDescription may span two sentences — keep newlines but it's only
      // ever rendered inside the fenced block / an indented quote line.
      selfDescription: sanitizeExternalText(
        String(card.selfDescription ?? ''),
        400,
      ),
      status:
        card.status === 'in-turn' || card.status === 'waiting-on-user'
          ? card.status
          : 'idle',
      exposesSubAgents: !!card.exposesSubAgents,
      lastSeen: Date.now(),
      // AUDITARIA_HIVE_FEATURE: whitelist the advisory presence fields
      // (validated) — the hub rebuilds the card field-by-field and drops
      // anything not listed here.
      deliveryMode: card.deliveryMode === 'manual' ? 'manual' : 'auto',
      lastConsumedTs:
        typeof card.lastConsumedTs === 'number' &&
        Number.isFinite(card.lastConsumedTs)
          ? card.lastConsumedTs
          : 0,
    };
  }

  /** Suffix visually-colliding nicknames, not just exact duplicates (§4.2). */
  function resolveNicknameCollision(nickname: string, nodeId: string): string {
    const base = nickname || 'peer';
    const taken = new Set(
      Object.entries(state!.enrollments)
        .filter(([id]) => id !== nodeId)
        .map(([, e]) => normalizeNickname(e.nickname)),
    );
    if (!taken.has(normalizeNickname(base))) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(normalizeNickname(candidate))) return candidate;
    }
    return `${base}-${nodeId.slice(-4)}`;
  }

  function nodeIdByNickname(nickname: string): string | undefined {
    const norm = normalizeNickname(nickname);
    for (const [id, enr] of Object.entries(state!.enrollments)) {
      if (normalizeNickname(enr.nickname) === norm) return id;
    }
    return undefined;
  }

  // ---------------- TTL sweep (relay clock) ----------------

  function sweepExpired(): void {
    const now = Date.now();
    for (const [nodeId, q] of queues) {
      const conn = conns.get(nodeId);
      for (const { seq, value } of q.entries()) {
        const ttlMs = (value.env.ttlSec || DEFAULT_TTL_SEC) * 1000;
        if (now - value.enqueuedAt > ttlMs) {
          // Don't expire a frame already delivered and awaiting its ack — the
          // receiver may still complete it, which would make an 'expired'
          // receipt to the sender a false custody signal.
          if (conn?.inFlight.has(seq)) continue;
          q.ack(seq);
          dlq.enqueue(value, false);
          const senderConn = conns.get(value.env.from);
          if (senderConn) {
            send(senderConn.ws, {
              t: 'receipt',
              id: value.env.id,
              by: nodeId,
              level: 'expired',
              note: 'message expired in the relay queue before delivery',
            });
          }
        }
      }
    }
    // DLQ pruned on its own TTL (keep 7 days).
    for (const { seq, value } of dlq.entries()) {
      if (now - value.enqueuedAt > 7 * 24 * 3_600_000) dlq.ack(seq);
    }
  }
  const sweepTimer = setInterval(sweepExpired, 60_000);
  sweepTimer.unref?.();

  // ---------------- delivery ----------------

  function tryDeliver(nodeId: string): void {
    const conn = conns.get(nodeId);
    if (!conn) return;
    const q = queueFor(nodeId);
    for (const { seq, value } of q.entries()) {
      if (conn.inFlight.has(seq)) continue;
      // Mark in-flight only if the frame actually went out. A failed write
      // (e.g. backpressure) otherwise strands the entry — skipped forever on
      // this connection until it reconnects.
      if (send(conn.ws, { t: 'deliver', env: value.env, seq })) {
        conn.inFlight.add(seq);
      }
    }
  }

  /**
   * Queue an envelope for one recipient. Returns the sender-visible state.
   * The entry is fsynced before we report anything (custody chain).
   */
  function routeToPeer(env: HiveEnvelope, recipient: string): SendState {
    const enr = state!.enrollments[recipient];
    if (!enr || enr.blocked) return 'unknown-peer';
    const q = queueFor(recipient);
    if (q.size >= QUEUE_DEPTH_CAP) {
      dlq.enqueue(
        { env, enqueuedAt: Date.now(), wantsReceipt: env.ack === 'processed' },
        false,
      );
      return 'queue-full';
    }
    q.enqueue({
      env,
      enqueuedAt: Date.now(),
      wantsReceipt: env.ack === 'processed',
    });
    const online = conns.has(recipient);
    if (online) tryDeliver(recipient);
    return online ? 'delivered' : 'queued';
  }

  // ---------------- rate limiting ----------------

  function takeTokens(conn: PeerConn, n: number): boolean {
    const now = Date.now();
    const elapsedMin = (now - conn.lastRefill) / 60_000;
    conn.tokens = Math.min(
      RATE_LIMIT_PER_MIN,
      conn.tokens + elapsedMin * RATE_LIMIT_PER_MIN,
    );
    conn.lastRefill = now;
    if (conn.tokens < n) return false;
    conn.tokens -= n;
    return true;
  }

  // ---------------- message handlers (post-auth) ----------------

  function handleSend(conn: PeerConn, msg: SendMsg): void {
    const raw = JSON.stringify(msg.env ?? {});
    if (raw.length > MAX_MESSAGE_BYTES) {
      send(conn.ws, {
        t: 'send-state',
        ref: msg.ref,
        states: {},
        error: `message exceeds the ${Math.floor(MAX_MESSAGE_BYTES / 1024)}KB cap — reference large artifacts by path instead of embedding them`,
      });
      return;
    }
    const env: HiveEnvelope = {
      ...msg.env,
      from: conn.nodeId, // never trust the sender-claimed origin
      hops: Math.min(Number(msg.env.hops ?? 0), 1),
      ttlSec: Math.min(Number(msg.env.ttlSec) || DEFAULT_TTL_SEC, 7 * 86_400),
      ts: Number(msg.env.ts) || Date.now(),
    };

    const recipients =
      env.to === '*'
        ? Object.keys(state!.enrollments).filter(
            (id) => id !== conn.nodeId && !state!.enrollments[id].blocked,
          )
        : [env.to];

    // Broadcasts count as N sends against the rate limit (§5.4).
    if (!takeTokens(conn, Math.max(1, recipients.length))) {
      send(conn.ws, {
        t: 'send-state',
        ref: msg.ref,
        states: Object.fromEntries(
          recipients.map((r) => [r, 'rate-limited' as SendState]),
        ),
        error: `rate limit reached (${RATE_LIMIT_PER_MIN}/min) — pace messages, or address peers directly instead of broadcasting`,
      });
      return;
    }

    const states: Record<string, SendState> = {};
    for (const recipient of recipients) {
      states[recipient] = routeToPeer(env, recipient);
    }
    send(conn.ws, { t: 'send-state', ref: msg.ref, states });
  }

  function handleAck(conn: PeerConn, msg: AckMsg): void {
    const q = queueFor(conn.nodeId);
    if (msg.level === 'delivered') {
      // Find the queue entry by envelope id (idempotent — a repeat ack for
      // an already-deleted entry is a no-op).
      for (const { seq, value } of q.entries()) {
        if (value.env.id === msg.id) {
          q.ack(seq);
          conn.inFlight.delete(seq);
          break;
        }
      }
    } else if (msg.level === 'processed') {
      // Forward the end-to-end receipt to the sender when one was requested.
      // The queue entry is usually gone by now (deleted at 'delivered') —
      // receipts route on the envelope's from field carried by the acker.
      // We look the original sender up from a small receipt index kept on
      // the queue entry when still present, else broadcast the receipt to
      // the sender if connected.
      for (const { value } of q.entries()) {
        if (value.env.id === msg.id) {
          // Still in queue (processed can arrive before delivered on
          // hive_check drains) — treat as delivered too.
          handleAck(conn, { t: 'ack', id: msg.id, level: 'delivered' });
          break;
        }
      }
      const origin = receiptIndex.get(msg.id);
      if (origin) {
        const senderConn = conns.get(origin);
        if (senderConn) {
          send(senderConn.ws, {
            t: 'receipt',
            id: msg.id,
            by: conn.nodeId,
            level: 'processed',
          });
        }
        // Do NOT delete the index here: a broadcast is processed by many
        // peers, each sending its own processed ack, and the sender wants a
        // receipt per peer. The size-bound + TTL pruner reclaims the entry.
      }
    }
  }

  // envelope id -> origin nodeId, for routing processed receipts after the
  // queue entry is gone. Bounded LRU-ish: pruned with the TTL sweep.
  const receiptIndex = new Map<string, string>();
  const receiptIndexTimes = new Map<string, number>();
  function indexReceipt(env: HiveEnvelope): void {
    if (env.ack !== 'processed') return;
    receiptIndex.set(env.id, env.from);
    receiptIndexTimes.set(env.id, Date.now());
    if (receiptIndex.size > 5_000) {
      // Drop the oldest half to bound memory.
      const sorted = [...receiptIndexTimes.entries()].sort(
        (a, b) => a[1] - b[1],
      );
      for (const [id] of sorted.slice(0, Math.floor(sorted.length / 2))) {
        receiptIndex.delete(id);
        receiptIndexTimes.delete(id);
      }
    }
  }

  function handleCard(conn: PeerConn, msg: CardMsg): void {
    const patch = msg.patch ?? {};
    const merged = sanitizeCard({ ...conn.card, ...patch }, conn.nodeId);
    // Nickname changes go through enrollment (collision handling), not here.
    merged.nickname =
      state!.enrollments[conn.nodeId]?.nickname ?? merged.nickname;
    conn.card = merged;
    const entry = rosterEntryFor(conn.nodeId);
    if (entry) {
      broadcastEvent(
        {
          t: 'event',
          kind: patch.status ? 'status_changed' : 'card_updated',
          entry,
        },
        conn.nodeId,
      );
    }
  }

  function handleAdmin(conn: PeerConn, msg: AdminMsg): void {
    const reply = (res: Omit<AdminResultMsg, 't' | 'ref'>) =>
      send(conn.ws, { t: 'admin-result', ref: msg.ref, ...res });

    // Hive-wide administration is honored only from trusted peers (§6.1).
    if (conn.trust !== 'full') {
      reply({ ok: false, error: 'not permitted — this peer is not trusted' });
      return;
    }

    switch (msg.op) {
      case 'invite': {
        const trust: TrustLevel = msg.trust === 'consult' ? 'consult' : 'full';
        const tokenId = makeInviteTokenId();
        state!.invites[tokenId] = {
          trust,
          expiresAt: Date.now() + INVITE_TTL_MS,
        };
        saveState();
        reply({ ok: true, data: { token: tokenId, trust } });
        return;
      }
      case 'trust':
      case 'untrust': {
        const target = msg.nickname
          ? nodeIdByNickname(msg.nickname)
          : undefined;
        if (!target || !state!.enrollments[target]) {
          reply({ ok: false, error: `unknown peer: ${msg.nickname}` });
          return;
        }
        state!.enrollments[target].trust =
          msg.op === 'trust' ? 'full' : 'consult';
        saveState();
        const liveTarget = conns.get(target);
        if (liveTarget) liveTarget.trust = state!.enrollments[target].trust;
        const entry = rosterEntryFor(target);
        if (entry) broadcastEvent({ t: 'event', kind: 'trust_changed', entry });
        reply({
          ok: true,
          data: { nodeId: target, trust: state!.enrollments[target].trust },
        });
        return;
      }
      case 'remove': {
        const target = msg.nickname
          ? nodeIdByNickname(msg.nickname)
          : undefined;
        if (!target || !state!.enrollments[target]) {
          reply({ ok: false, error: `unknown peer: ${msg.nickname}` });
          return;
        }
        // Revocation for a lost machine: delete the binding and block the
        // fingerprint by keeping a tombstone (§4.1).
        state!.enrollments[target].blocked = true;
        saveState();
        const liveTarget = conns.get(target);
        if (liveTarget) {
          send(liveTarget.ws, {
            t: 'authfail',
            reason: 'this node was removed from the hive',
          });
          try {
            liveTarget.ws.close();
          } catch {
            /* ignore */
          }
        }
        broadcastEvent({ t: 'event', kind: 'removed', nodeId: target });
        reply({ ok: true, data: { nodeId: target } });
        return;
      }
      default:
        reply({ ok: false, error: `unknown admin op` });
    }
  }

  // ---------------- connection lifecycle ----------------

  function handleConnection(ws: WebSocket, req: IncomingMessage): void {
    if (isLockedOut(req)) {
      send(ws, { t: 'authfail', reason: 'locked out — too many attempts' });
      ws.close();
      return;
    }
    if (unauthedCount >= MAX_UNAUTHED) {
      // Cap concurrent unauthenticated connections (§7.1).
      ws.close();
      return;
    }
    unauthedCount++;

    const hkdfSalt = randomBytes(SALT_LEN);
    const challenge = randomBytes(CHALLENGE_LEN);
    let authed = false;
    let settledUnauth = false;
    const releaseUnauth = () => {
      if (!settledUnauth) {
        settledUnauth = true;
        unauthedCount--;
      }
    };

    const authTimer = setTimeout(() => {
      if (!authed) {
        send(ws, { t: 'authfail', reason: 'auth timeout' });
        ws.close();
      }
    }, AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    send(ws, {
      t: 'hello',
      v: HIVE_PROTOCOL_VERSION,
      salt: state!.saltB64,
      hkdfSalt: toB64(hkdfSalt),
      challenge: toB64(challenge),
      iterations: PBKDF2_ITERATIONS,
      hubKey: state!.hubPublicKeyPem,
    });

    const onMessage = async (data: Buffer, isBinary: boolean) => {
      if (authed || isBinary) return;
      let msg: AuthMsg;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        msg = JSON.parse(data.toString('utf8')) as AuthMsg;
      } catch {
        return;
      }
      if (msg.t !== 'auth') return;

      const failAuth = (reason: string) => {
        noteFail(req);
        send(ws, { t: 'authfail', reason });
        ws.close();
      };

      try {
        // Layer 2: passphrase challenge-response (cached master key).
        const authKey = await deriveAuthKey(master, hkdfSalt);
        const passOk = await verifyAuthResponse(
          authKey,
          msg.response,
          challenge,
        );
        if (authed) return; // concurrent auth already completed
        if (!passOk) {
          failAuth('invalid passphrase');
          return;
        }

        // Layer 3: node identity. The signature proves possession of the
        // private key matching the presented public key, for THIS challenge.
        const nodeId = String(msg.nodeId ?? '');
        const nodePub = String(msg.nodePub ?? '');
        if (!nodeId || !nodePub) {
          failAuth('missing node identity');
          return;
        }
        if (!verifyChallengeSignature(nodePub, challenge, msg.nodeSig)) {
          failAuth('invalid node key signature');
          return;
        }
        const fingerprint = fingerprintOfPublicKey(nodePub);

        const existing = state!.enrollments[nodeId];
        if (existing?.blocked) {
          failAuth('this node was removed from the hive');
          return;
        }
        if (existing && existing.fingerprint !== fingerprint) {
          // TOFU: an enrolled identity stays bound to the key that enrolled it.
          failAuth(
            'node identity mismatch — this nodeId is bound to a different key',
          );
          return;
        }

        let trust: TrustLevel;
        let nickname: string;
        if (existing) {
          trust = existing.trust;
          nickname = existing.nickname;
        } else {
          // New enrollment — trust assignment per policy (§6.1).
          const invite = msg.inviteToken
            ? state!.invites[msg.inviteToken]
            : undefined;
          const inviteValid =
            invite && !invite.used && invite.expiresAt > Date.now();
          if (inviteValid) {
            trust = invite.trust;
            invite.used = true;
            delete state!.invites[msg.inviteToken!];
          } else if (trustPolicy === 'open') {
            // Passphrase possession grants full trust — the configured
            // posture for private, same-user setups (e.g. local testing).
            trust = 'full';
          } else if (trustPolicy === 'invite' && msg.inviteToken) {
            failAuth('invite token invalid, expired, or already used');
            return;
          } else if (trustPolicy === 'invite') {
            failAuth(
              'this hive enrolls new nodes by invite — mint one with /hive invite',
            );
            return;
          } else {
            // 'manual': join gated; a trusted machine can /hive trust later.
            trust = 'consult';
          }
          const requested = sanitizeInline(
            String(msg.card?.nickname ?? ''),
            60,
          );
          nickname = resolveNicknameCollision(requested, nodeId);
          state!.enrollments[nodeId] = {
            fingerprint,
            nickname,
            trust,
            enrolledAt: Date.now(),
          };
        }
        saveState();

        authed = true;
        clearTimeout(authTimer);
        releaseUnauth();
        fails.delete(lockoutKey(req));
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        ws.off('message', onMessage as never);

        const proof = await makeAuthProof(authKey, challenge);
        const clientChallenge = fromB64(String(msg.clientChallenge ?? ''));
        const hubSig = signChallenge(state!.hubPrivateKeyPem, clientChallenge);

        // Displace any previous connection for this node (reconnect).
        const prev = conns.get(nodeId);
        if (prev) {
          try {
            prev.ws.close();
          } catch {
            /* ignore */
          }
          conns.delete(nodeId);
        }

        const card = sanitizeCard(msg.card, nodeId);
        card.nickname = nickname;
        const conn: PeerConn = {
          ws,
          nodeId,
          card,
          trust,
          tokens: RATE_LIMIT_PER_MIN,
          lastRefill: Date.now(),
          inFlight: new Set(),
        };
        conns.set(nodeId, conn);

        send(ws, {
          t: 'authok',
          proof,
          hubSig,
          nickname,
          trust,
          roster: fullRoster(),
        });

        const entry = rosterEntryFor(nodeId);
        if (entry) {
          broadcastEvent({ t: 'event', kind: 'peer_joined', entry }, nodeId);
        }
        log(`hive: ${nickname} connected (${trust})`);

        // Post-auth message pump for this connection.
        ws.on('message', (raw: Buffer, bin: boolean) => {
          if (bin) return;
          let m: ClientToHubMsg;
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
            m = JSON.parse(raw.toString('utf8')) as ClientToHubMsg;
          } catch {
            return;
          }
          try {
            switch (m.t) {
              case 'ping':
                send(ws, { t: 'pong' });
                return;
              case 'msg':
                indexReceipt({ ...m.env, from: nodeId });
                handleSend(conn, m);
                return;
              case 'ack':
                handleAck(conn, m);
                return;
              case 'card':
                handleCard(conn, m);
                return;
              case 'admin':
                handleAdmin(conn, m);
                return;
              default:
                return;
            }
          } catch (e) {
            log(
              `hive: error handling ${String((m as { t?: string }).t)} from ${nickname}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        });

        // Replay everything already queued for this peer.
        tryDeliver(nodeId);

        ws.on('close', () => {
          if (conns.get(nodeId) === conn) {
            conns.delete(nodeId);
            const offEntry = rosterEntryFor(nodeId);
            broadcastEvent({
              t: 'event',
              kind: 'peer_left',
              entry: offEntry,
              nodeId,
            });
            log(`hive: ${nickname} disconnected`);
          }
        });
      } catch (e) {
        failAuth(`auth error: ${e instanceof Error ? e.message : String(e)}`);
      }
    };

    ws.on('message', onMessage);
    ws.on('close', () => {
      clearTimeout(authTimer);
      releaseUnauth();
    });
    ws.on('error', () => {
      /* handled by close */
    });
  }

  // ---------------- HTTP + WS server ----------------

  const wsPath = `/${state.urlToken}/ws`;
  const http = createServer((req, res) => {
    // Zero pre-auth metadata: anything that isn't the exact WS path 404s.
    res.writeHead(404).end('Not found');
  });

  // Cap frame size at the server so an unauthenticated peer can't push
  // oversized frames (the 64KB message cap is only enforced post-auth in
  // handleSend). Leaves generous headroom over MAX_MESSAGE_BYTES for the
  // JSON envelope + auth card/keys.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES * 2,
  });
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== wsPath) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req));
  });

  const port = await listenWithFallback(http, options.port ?? 0);
  log(`hive: hub listening on 127.0.0.1:${port}`);

  return {
    port,
    urlToken: state.urlToken,
    hubFingerprint,
    mintInvite(trust: TrustLevel): string {
      const tokenId = makeInviteTokenId();
      state.invites[tokenId] = {
        trust,
        expiresAt: Date.now() + INVITE_TTL_MS,
      };
      saveState();
      return tokenId;
    },
    listRoster: fullRoster,
    async close(): Promise<void> {
      clearInterval(sweepTimer);
      for (const conn of conns.values()) {
        try {
          conn.ws.close();
        } catch {
          /* ignore */
        }
      }
      conns.clear();
      for (const q of queues.values()) q.dispose();
      dlq.dispose();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          http.close(() => resolve());
        });
        // Don't hang shutdown on lingering sockets.
        setTimeout(resolve, 2_000).unref?.();
      });
    },
  };
}

async function listenWithFallback(
  server: Server,
  requestedPort: number,
): Promise<number> {
  const tryPort = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('error', onError);
        reject(err);
      };
      server.on('error', onError);
      // Bind loopback ONLY. The relay is meant to be reachable exclusively
      // through the cloudflared tunnel (which connects to localhost) or by
      // the hub's own loopback peer — never directly on the LAN/WAN. Passing
      // no host would bind 0.0.0.0/:: and expose it on all interfaces.
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        const addr = server.address();
        if (addr && typeof addr !== 'string') resolve(addr.port);
        else reject(new Error('could not determine hub port'));
      });
    });

  if (requestedPort === 0) return tryPort(0);
  const candidates = [
    requestedPort,
    requestedPort + 1,
    requestedPort + 2,
    requestedPort + 3,
    requestedPort + 4,
  ];
  for (const p of candidates) {
    try {
      return await tryPort(p);
    } catch (e) {
      const isAddrInUse =
        e != null &&
        typeof e === 'object' &&
        'code' in e &&
        e.code === 'EADDRINUSE';
      if (!isAddrInUse) throw e;
    }
  }
  return tryPort(0);
}
