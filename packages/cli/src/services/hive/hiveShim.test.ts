/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  acquireShimInstance,
  discoverLocalHive,
  envPassphrase,
  legacyShimNotice,
  loadShimConfig,
  peekJsonlPending,
  resolveShimConnection,
  saveShimConfig,
  shimInstanceKey,
  shimInstancePaths,
} from './hiveShim.js';
import { acquirePidLock, checkPidLock, releasePidLock } from './hivePaths.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-shim-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shimInstanceKey', () => {
  it('sanitizes and caps an explicit --instance name', () => {
    expect(shimInstanceKey('my agent!/one')).toBe('my_agent__one');
    expect(shimInstanceKey('x'.repeat(80)).length).toBe(40);
  });

  it('derives a cwd-keyed instance when no explicit name is given', () => {
    const prev = process.env['AUDITARIA_HIVE_INSTANCE'];
    delete process.env['AUDITARIA_HIVE_INSTANCE'];
    try {
      const a = shimInstanceKey(undefined, '/some/project');
      const b = shimInstanceKey(undefined, '/some/project');
      const c = shimInstanceKey(undefined, '/other/project');
      expect(a).toMatch(/^p_/);
      expect(a).toBe(b);
      expect(a).not.toBe(c);
    } finally {
      if (prev !== undefined) process.env['AUDITARIA_HIVE_INSTANCE'] = prev;
    }
  });
});

describe('pid locks (hivePaths)', () => {
  it('acquires, reports the holder, and is re-entrant for the same pid', () => {
    const lockPath = path.join(dir, 'a', 'instance.lock');
    expect(acquirePidLock(lockPath)).toBe(true);
    expect(checkPidLock(lockPath)).toBe(process.pid);
    expect(acquirePidLock(lockPath)).toBe(true); // own pid → still ours
    releasePidLock(lockPath);
    expect(checkPidLock(lockPath)).toBeUndefined();
  });

  it('prunes a stale lock left by a dead process', () => {
    const lockPath = path.join(dir, 'stale.lock');
    // A pid that certainly exited: spawn-and-wait a trivial node child.
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const deadPid = child.pid!;
    return new Promise<void>((resolve) => {
      child.on('exit', () => {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid }), 'utf-8');
        expect(checkPidLock(lockPath)).toBeUndefined();
        expect(acquirePidLock(lockPath)).toBe(true);
        releasePidLock(lockPath);
        resolve();
      });
    });
  });
});

describe('acquireShimInstance', () => {
  it('claims the base key when free', () => {
    const inst = acquireShimInstance('p_test', 9, dir);
    expect(inst?.key).toBe('p_test');
    releasePidLock(inst!.lockPath);
  });

  it('falls through to <key>_2 when the base key is held by a live process', async () => {
    // Keep a real foreign process alive to hold the base lock.
    const holder: ChildProcess = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      { stdio: 'ignore' },
    );
    try {
      const base = shimInstancePaths('p_test', dir);
      fs.mkdirSync(path.dirname(base.lockPath), { recursive: true });
      fs.writeFileSync(
        base.lockPath,
        JSON.stringify({ pid: holder.pid }),
        'utf-8',
      );
      const inst = acquireShimInstance('p_test', 9, dir);
      expect(inst?.key).toBe('p_test_2');
      expect(inst?.dir).not.toBe(base.dir);
      releasePidLock(inst!.lockPath);
    } finally {
      holder.kill();
    }
  });
});

describe('shim config persistence', () => {
  it('round-trips the per-instance config', () => {
    const inst = shimInstancePaths('p_cfg', dir);
    expect(loadShimConfig(inst)).toEqual({});
    saveShimConfig(inst, { nodeId: 'n_1', nickname: 'tester', autojoin: true });
    expect(loadShimConfig(inst)).toEqual({
      nodeId: 'n_1',
      nickname: 'tester',
      autojoin: true,
    });
  });
});

describe('resolveShimConnection', () => {
  it('returns undefined without a complete url + passphrase pair', () => {
    expect(resolveShimConnection({ cfg: {} })).toBeUndefined();
    expect(
      resolveShimConnection({ cfg: { url: 'https://x/t' } }),
    ).toBeUndefined();
    expect(resolveShimConnection({ cfg: { passphrase: 'p' } })).toBeUndefined();
  });

  it('prefers args over saved config over hub discovery', () => {
    const conn = resolveShimConnection({
      argUrl: 'https://arg/t',
      argPassphrase: 'arg-pass',
      cfg: { url: 'https://saved/t', passphrase: 'saved-pass' },
      hubInfo: { loopbackUrl: 'http://127.0.0.1:1/t' },
    });
    expect(conn).toMatchObject({
      url: 'https://arg/t',
      passphrase: 'arg-pass',
      persistPassphrase: true, // literal --passphrase may be persisted
    });

    const saved = resolveShimConnection({
      cfg: { url: 'https://saved/t', passphrase: 'saved-pass' },
      hubInfo: { loopbackUrl: 'http://127.0.0.1:1/t' },
    });
    expect(saved).toMatchObject({
      url: 'https://saved/t',
      passphrase: 'saved-pass',
      persistPassphrase: true, // already on disk
    });

    const discovered = resolveShimConnection({
      cfg: {},
      envPass: 'env-pass',
      hubInfo: { loopbackUrl: 'http://127.0.0.1:1/t', url: 'https://pub/t' },
    });
    expect(discovered).toMatchObject({
      url: 'http://127.0.0.1:1/t', // loopback preferred on the hub machine
      passphrase: 'env-pass',
      persistPassphrase: false, // env-sourced secrets never hit disk
    });
  });

  it('never persists env-sourced passphrases (--passphrase-env or env vars)', () => {
    const viaFlag = resolveShimConnection({
      argUrl: 'https://x/t',
      argPassphrase: 'from-env-var',
      argPassphraseFromEnv: true,
      cfg: {},
    });
    expect(viaFlag?.persistPassphrase).toBe(false);

    const envOverSaved = resolveShimConnection({
      cfg: { url: 'https://x/t', passphrase: 'old-saved' },
      envPass: 'env-wins',
    });
    expect(envOverSaved?.passphrase).toBe('env-wins');
    expect(envOverSaved?.persistPassphrase).toBe(false);
  });

  it('strips trailing slashes from the url', () => {
    const conn = resolveShimConnection({
      argUrl: 'https://x/t///',
      argPassphrase: 'p',
      cfg: {},
    });
    expect(conn?.url).toBe('https://x/t');
  });
});

describe('envPassphrase', () => {
  it('prefers AUDITARIA_HIVE_PASSPHRASE over HIVE_PASS', () => {
    expect(
      envPassphrase({ AUDITARIA_HIVE_PASSPHRASE: 'a', HIVE_PASS: 'b' }),
    ).toBe('a');
    expect(envPassphrase({ HIVE_PASS: 'b' })).toBe('b');
    expect(envPassphrase({})).toBeUndefined();
  });
});

describe('peekJsonlPending', () => {
  it('counts pending entries without touching the file', () => {
    const file = path.join(dir, 'inbox.jsonl');
    const lines = [
      JSON.stringify({ op: 'enq', seq: 1, v: { n: 'one' } }),
      JSON.stringify({ op: 'enq', seq: 2, v: { n: 'two' } }),
      JSON.stringify({ op: 'ack', seq: 1 }),
      '{ torn tail', // crash artifact — must be ignored
    ].join('\n');
    fs.writeFileSync(file, lines, 'utf-8');
    const before = fs.readFileSync(file, 'utf-8');
    const { count, first } = peekJsonlPending<{ n: string }>(file);
    expect(count).toBe(1);
    expect(first?.n).toBe('two');
    // read-only: a live shim may hold this file open for append
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it('handles a missing file', () => {
    expect(peekJsonlPending(path.join(dir, 'nope.jsonl'))).toEqual({
      count: 0,
      values: [],
    });
  });
});

describe('discoverLocalHive', () => {
  const writeJson = (p: string, v: unknown) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(v), 'utf-8');
  };
  const instCfg = (name: string) =>
    path.join(dir, '.auditaria', 'hive', 'instances', name, 'config.json');
  const hubInfoPath = () =>
    path.join(dir, '.auditaria', 'hive', 'hub-info.json');

  it('returns undefined on a machine with no hive state', () => {
    expect(discoverLocalHive(dir, {})).toBeUndefined();
  });

  it('uses env passphrase + hub discovery when no configs exist', () => {
    writeJson(hubInfoPath(), {
      url: 'https://tun.example/tok1',
      loopbackUrl: 'http://127.0.0.1:18800/tok1',
      urlToken: 'tok1',
    });
    const found = discoverLocalHive(dir, { HIVE_PASS: 'env-secret' });
    expect(found).toMatchObject({
      url: 'http://127.0.0.1:18800/tok1',
      passphrase: 'env-secret',
      persistPassphrase: false,
    });
  });

  it('finds a local Auditaria instance connection (no env needed)', () => {
    writeJson(instCfg('p_abc'), {
      url: 'https://tun.example/tok2',
      passphrase: 'saved-secret',
    });
    const found = discoverLocalHive(dir, {});
    expect(found).toMatchObject({
      url: 'https://tun.example/tok2',
      passphrase: 'saved-secret',
      persistPassphrase: true,
    });
    expect(found?.source).toContain('p_abc');
  });

  it('prefers the hub-hosting instance and swaps in the loopback url', () => {
    writeJson(instCfg('p_peer'), {
      url: 'https://other.example/tokX',
      passphrase: 'peer-secret',
    });
    writeJson(instCfg('p_hub'), {
      url: 'https://tun.example/tok3',
      passphrase: 'hub-secret',
      hub: { port: 18800 },
    });
    writeJson(hubInfoPath(), {
      url: 'https://tun.example/tok3',
      loopbackUrl: 'http://127.0.0.1:18800/tok3',
      urlToken: 'tok3',
    });
    const found = discoverLocalHive(dir, {});
    expect(found).toMatchObject({
      url: 'http://127.0.0.1:18800/tok3', // loopback beats rotated tunnel
      passphrase: 'hub-secret',
    });
  });

  it('env passphrase wins over a saved one and is never persisted', () => {
    writeJson(instCfg('p_abc'), {
      url: 'https://tun.example/tok4',
      passphrase: 'saved-secret',
    });
    const found = discoverLocalHive(dir, {
      AUDITARIA_HIVE_PASSPHRASE: 'env-wins',
    });
    expect(found?.passphrase).toBe('env-wins');
    expect(found?.persistPassphrase).toBe(false);
  });

  it('falls back to the legacy machine-wide hive.json', () => {
    writeJson(path.join(dir, '.auditaria', 'hive.json'), {
      url: 'https://legacy.example/tok5',
      passphrase: 'legacy-secret',
    });
    const found = discoverLocalHive(dir, {});
    expect(found).toMatchObject({
      url: 'https://legacy.example/tok5',
      passphrase: 'legacy-secret',
    });
    expect(found?.source).toContain('legacy');
  });
});

describe('legacyShimNotice', () => {
  it('is silent when no legacy state exists', () => {
    expect(legacyShimNotice(dir)).toBeUndefined();
  });

  it('mentions the legacy path and pending count when found', () => {
    const legacy = path.join(dir, '.auditaria', 'hive-shim');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'shim.json'), '{}', 'utf-8');
    fs.writeFileSync(
      path.join(legacy, 'inbox.jsonl'),
      JSON.stringify({ op: 'enq', seq: 1, v: {} }) + '\n',
      'utf-8',
    );
    const note = legacyShimNotice(dir);
    expect(note).toContain('hive-shim');
    expect(note).toContain('1 undrained');
  });
});
