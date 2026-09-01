/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// End-to-end test of the hive-mcp shim as FOREIGN agents use it: two shim
// processes (spawned from bundle/hive-mcp.js, isolated HOME) join a REAL
// hub at runtime via hive_connect, get distinct identities, exchange a
// message with wait_for_reply_sec, survive a respawn on persisted
// credentials, and a same-instance collision falls through to `<key>_2`.
//
// Skipped when bundle/hive-mcp.js has not been built (npm run bundle).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { startHiveHub, type HiveHubHandle } from './HiveHub.js';
import { shimInstancePaths } from './hiveShim.js';

const bundlePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../bundle/hive-mcp.js',
);
const hasBundle = fs.existsSync(bundlePath);

const PASSPHRASE = 'pw-shim-e2e';

/** Minimal newline-delimited JSON-RPC client over a shim child's stdio. */
class ShimClient {
  private child: ChildProcess;
  private nextId = 1;
  private buf = '';
  private pending = new Map<number, (msg: unknown) => void>();
  stderrLines: string[] = [];

  constructor(homeDir: string, cwd: string, extraArgs: string[]) {
    this.child = spawn(process.execPath, [bundlePath, ...extraArgs], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        AUDITARIA_HIVE_PASSPHRASE: '',
        HIVE_PASS: '',
        AUDITARIA_HIVE_INSTANCE: '',
      },
    });
    this.child.stderr!.on('data', (d: Buffer) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) this.stderrLines.push(line.trim());
      }
    });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          if (msg.id !== undefined && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch {
          /* non-JSON stdout noise */
        }
      }
    });
  }

  private rpc(
    method: string,
    params: unknown,
    timeoutMs = 45_000,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`rpc timeout: ${method}`)),
        timeoutMs,
      );
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin!.write(
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      );
    });
  }

  /** Instructions served by the shim at initialize-time. */
  serverInstructions = '';

  async initialize(): Promise<void> {
    const res = (await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '0' },
    })) as { result?: { instructions?: string } };
    this.serverInstructions = res.result?.instructions ?? '';
    this.child.stdin!.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
        '\n',
    );
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = 45_000,
  ): Promise<{ text: string; isError: boolean }> {
    const res = (await this.rpc(
      'tools/call',
      { name, arguments: args },
      timeoutMs,
    )) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    };
    return {
      text: res.result?.content?.[0]?.text ?? '',
      isError: !!res.result?.isError,
    };
  }

  kill(): void {
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
  }
}

async function pollUntil(
  fn: () => Promise<boolean>,
  attempts = 20,
  delayMs = 500,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

describe.skipIf(!hasBundle)('hive-mcp shim e2e (real hub, real spawns)', () => {
  let dir: string;
  let hub: HiveHubHandle;
  let inviteUrl: string;
  const clients: ShimClient[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-shim-e2e-'));
    hub = await startHiveHub({
      passphrase: PASSPHRASE,
      dataDir: path.join(dir, 'hub'),
      trustPolicy: 'open',
    });
    inviteUrl = `http://127.0.0.1:${hub.port}/${hub.urlToken}`;
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) c.kill();
    await hub?.close();
    // Windows: child teardown may briefly hold cwd/file handles.
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spawnShim = (home: string, cwd: string, args: string[]): ShimClient => {
    fs.mkdirSync(cwd, { recursive: true });
    const c = new ShimClient(home, cwd, args);
    clients.push(c);
    return c;
  };

  it('two shims join at runtime, message each other, persist, and never collide', async () => {
    const homeA = path.join(dir, 'homeA');
    const homeB = path.join(dir, 'homeB');
    const cwdA = path.join(dir, 'projA');
    const cwdB = path.join(dir, 'projB');

    // --- runtime join via hive_connect (registration had NO hive args) ---
    const a = spawnShim(homeA, cwdA, ['--instance', 'a']);
    await a.initialize();
    // MCP instructions teach the agent to set up its own mail watcher.
    expect(a.serverInstructions).toContain('--watch --instance a');
    expect(a.serverInstructions).toContain('hive_connect');
    const joinA = await a.call('hive_connect', {
      invite: `${inviteUrl}#${PASSPHRASE}`,
      nickname: 'alpha',
      description: 'e2e tester A',
    });
    expect(joinA.isError).toBe(false);
    expect(joinA.text).toContain('Joined the hive as "alpha"');
    expect(joinA.text).toContain('trust: full'); // open policy

    const b = spawnShim(homeB, cwdB, ['--instance', 'b']);
    await b.initialize();
    const joinB = await b.call('hive_connect', {
      invite: `/hive join ${inviteUrl}#${PASSPHRASE}`, // pasted-line form
      nickname: 'bravo',
      description: 'e2e tester B',
    });
    expect(joinB.isError).toBe(false);
    expect(joinB.text).toContain('Joined the hive as "bravo"');

    // --- rosters see each other, with self-descriptions ---
    const statusA = await a.call('hive_status');
    expect(statusA.text).toContain('You are "alpha"');
    expect(statusA.text).toContain('bravo');
    expect(statusA.text).toContain('e2e tester B');

    // --- A asks B and parks; B drains, replies on the thread; A gets it ---
    const sendPromise = a.call(
      'hive_send',
      { to: 'bravo', body: 'ping from alpha?', wait_for_reply_sec: 30 },
      60_000,
    );
    let thread = '';
    const gotIt = await pollUntil(async () => {
      const check = await b.call('hive_check');
      const m = /thread="([^"]+)"/.exec(check.text);
      if (m && check.text.includes('ping from alpha?')) {
        thread = m[1];
        return true;
      }
      return false;
    });
    expect(gotIt).toBe(true);
    const replyRes = await b.call('hive_send', {
      to: 'alpha',
      body: 'pong from bravo!',
      thread,
      kind: 'response',
    });
    expect(replyRes.isError).toBe(false);
    const sendRes = await sendPromise;
    expect(sendRes.isError).toBe(false);
    expect(sendRes.text).toContain('Reply received');
    expect(sendRes.text).toContain('pong from bravo!');
    expect(sendRes.text).toContain('from="bravo"');

    // --- hive objects: A creates the GPU record, B updates it, A audits ---
    const created = await a.call('hive_object', {
      action: 'create',
      name: 'RTX4090',
      type: 'resource',
      status: 'in-use',
      attributes: { vram_gb: 16, holder: 'alpha' },
      note: 'training run',
    });
    expect(created.isError).toBe(false);
    const objId = /\(obj_[a-z0-9]+\)/.exec(created.text)?.[0]?.slice(1, -1);
    expect(objId).toBeTruthy();

    const listB = await b.call('hive_object', { action: 'list' });
    expect(listB.text).toContain('[resource] "RTX4090"');
    expect(listB.text).toContain('status=in-use');
    expect(listB.text).toContain('owner alpha');

    const updB = await b.call('hive_object', {
      action: 'update',
      id: objId,
      status: 'available',
      attributes: { holder: null },
      note: 'freeing for bravo',
    });
    expect(updB.isError).toBe(false);
    expect(updB.text).toContain('status=available');

    const histA = await a.call('hive_object', {
      action: 'history',
      id: objId,
    });
    expect(histA.text).toContain('v1');
    expect(histA.text).toContain('v2');
    expect(histA.text).toContain('by bravo');
    expect(histA.text).toContain('note: "freeing for bravo"');

    // --- same-instance collision falls through to a_2 (own identity) ---
    const a2 = spawnShim(homeA, cwdA, ['--instance', 'a']);
    await a2.initialize();
    const fellBack = await pollUntil(async () =>
      a2.stderrLines.some((l) => l.includes('running as "a_2"')),
    );
    expect(fellBack).toBe(true);
    a2.kill();

    // --- credentials persist: respawn A with no args → auto-rejoin ---
    a.kill();
    await new Promise((r) => setTimeout(r, 500));
    const a3 = spawnShim(homeA, cwdA, ['--instance', 'a']);
    await a3.initialize();
    const rejoined = await pollUntil(async () => {
      const st = await a3.call('hive_status');
      return st.text.includes('You are "alpha"');
    });
    expect(rejoined).toBe(true);
  }, 120_000);

  /** Spawn a raw shim process (non-MCP mode) and collect stdout until exit. */
  const runShim = (
    home: string,
    args: string[],
  ): {
    child: ChildProcess;
    done: Promise<{ code: number; stdout: string }>;
  } => {
    const child = spawn(process.execPath, [bundlePath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: dir,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        AUDITARIA_HIVE_PASSPHRASE: '',
        HIVE_PASS: '',
        AUDITARIA_HIVE_INSTANCE: '',
      },
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    const done = new Promise<{ code: number; stdout: string }>((resolve) => {
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    });
    return { child, done };
  };

  it('--watch exits with the unread summary the moment mail lands (incl. kind tag)', async () => {
    const home = path.join(dir, 'homeW');
    const paths = shimInstancePaths('w', home);
    fs.mkdirSync(paths.dir, { recursive: true });

    // A live "MCP session" holding the instance (mail lands in its inbox).
    const holder = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { stdio: 'ignore' },
    );
    try {
      fs.writeFileSync(
        paths.lockPath,
        JSON.stringify({ pid: holder.pid }),
        'utf-8',
      );

      const watcher = runShim(home, ['--watch', '--instance', 'w']);
      // Let it settle into silent polling. A status NOTICE must NOT wake it —
      // only actionable mail does.
      await new Promise((r) => setTimeout(r, 1_000));
      const notice = {
        env: {
          id: 'e2e-notice',
          thread: 't_w',
          from: 'n_peer',
          to: 'n_w',
          kind: 'status',
          body: 'Delivery notice: something was dead-lettered.',
          hops: 0,
          ttlSec: 86_400,
          ts: Date.now(),
        },
        seq: 0,
        receivedAt: Date.now(),
        fromNickname: 'alpha',
        fromTrust: 'full',
      };
      fs.appendFileSync(
        paths.inboxPath,
        JSON.stringify({ op: 'enq', seq: 99, v: notice }) + '\n',
        'utf-8',
      );
      await new Promise((r) => setTimeout(r, 4_500));
      expect(watcher.child.exitCode).toBeNull(); // still watching
      const entry = {
        env: {
          id: 'e2e-1',
          thread: 't_w',
          from: 'n_peer',
          to: 'n_w',
          kind: 'vote',
          body: 'choose: A or B?',
          hops: 0,
          ttlSec: 86_400,
          ts: Date.now(),
        },
        seq: 0,
        receivedAt: Date.now(),
        fromNickname: 'alpha',
        fromTrust: 'full',
      };
      fs.appendFileSync(
        paths.inboxPath,
        JSON.stringify({ op: 'enq', seq: 1, v: entry }) + '\n',
        'utf-8',
      );

      const res = await watcher.done;
      expect(res.code).toBe(0);
      expect(res.stdout).toContain('HIVE: 1 unread');
      expect(res.stdout).toContain('+1 notice'); // status notice counted, not woken on
      expect(res.stdout).toContain('alpha [vote]');
      expect(res.stdout).toContain('choose: A or B?');
      expect(res.stdout).toContain('hive_check');
    } finally {
      holder.kill();
    }
  }, 30_000);

  it('hive_join_local joins with ZERO configuration from a local Auditaria connection', async () => {
    const home = path.join(dir, 'homeL');
    // A local Auditaria peer already joined this hive — its saved connection
    // is what hive_join_local discovers (no invite, no passphrase given).
    const seedCfg = path.join(
      home,
      '.auditaria',
      'hive',
      'instances',
      'p_seed',
      'config.json',
    );
    fs.mkdirSync(path.dirname(seedCfg), { recursive: true });
    fs.writeFileSync(
      seedCfg,
      JSON.stringify({ url: inviteUrl, passphrase: PASSPHRASE }),
      'utf-8',
    );

    const g = spawnShim(home, path.join(dir, 'projL'), ['--instance', 'l']);
    await g.initialize();
    const joined = await g.call('hive_join_local', { nickname: 'ghost' });
    expect(joined.isError).toBe(false);
    expect(joined.text).toContain('Joined the hive as "ghost"');
    expect(joined.text).toContain('Credentials discovered from');
    g.kill();
  }, 60_000);

  it('hive_join_local reports clearly when no local hive exists', async () => {
    const home = path.join(dir, 'homeEmpty');
    const g = spawnShim(home, path.join(dir, 'projEmpty'), ['--instance', 'e']);
    await g.initialize();
    const res = await g.call('hive_join_local', {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain('No hive found on this machine');
    expect(res.text).toContain('/hive start');
    g.kill();
  }, 60_000);

  it('--watch ends itself when no live shim holds the instance', async () => {
    const home = path.join(dir, 'homeW2');
    const res = await runShim(home, ['--watch', '--instance', 'ghost']).done;
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('watch ended');
    expect(res.stdout).toContain('"ghost"');
  }, 30_000);
});
