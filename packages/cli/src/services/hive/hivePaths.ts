/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Per-instance state paths, kept free of any @google/gemini-cli-core import so
// they can be reasoned about and unit-tested in isolation.
//
// Hive state is PER INSTANCE, not per machine, so several Auditaria processes
// on one computer can each be a distinct hive peer (own identity, own queues).
// The instance key defaults to a hash of the working directory (different
// project checkouts are automatically different peers) and can be overridden
// with AUDITARIA_HIVE_INSTANCE to run more than one peer in the same directory
// (e.g. for local testing). The relay (hub) itself stays machine-wide — only
// ONE node hosts it (see HiveHub + the hub lock in hiveCommand).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shortHash } from './HiveCrypto.js';

/** Stable, filesystem-safe key identifying this peer instance on the machine. */
export function hiveInstanceKey(cwd = process.cwd()): string {
  const explicit = process.env['AUDITARIA_HIVE_INSTANCE'];
  if (explicit && explicit.trim()) {
    return explicit
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
  }
  return `p_${shortHash(cwd)}`;
}

/** ~/.auditaria/hive/instances/<key> — this peer's private state directory. */
export function getHiveInstanceDir(): string {
  return path.join(
    os.homedir(),
    '.auditaria',
    'hive',
    'instances',
    hiveInstanceKey(),
  );
}

export function getHiveConfigPath(): string {
  return path.join(getHiveInstanceDir(), 'config.json');
}

/** Machine-wide hub state directory (the single relay host). */
export function getHiveHubDir(): string {
  return path.join(os.homedir(), '.auditaria', 'hive', 'hub');
}

/**
 * Machine-local hub discovery file: the hub's CURRENT addresses, rewritten
 * on every hub start (quick-tunnel hostnames rotate per restart). Peers on
 * this machine read it to auto-heal their saved URL; see HubInfoFile.
 */
export function getHubInfoPath(): string {
  return path.join(os.homedir(), '.auditaria', 'hive', 'hub-info.json');
}

// -------------------------------------------------------------------
// PID-file locks (shared by hiveCommand and the hive-mcp shim)
// -------------------------------------------------------------------
//
// Simple liveness-checked PID locks over the state layout above:
//  - per-instance lock: one process per hive identity + queue files
//  - hub lock: one relay host per machine
// A stale lock (dead PID) is pruned on check, so hard kills self-heal.

/** PID held by a live process on this lock, or undefined (stale locks pruned). */
export function checkPidLock(lockPath: string): number | undefined {
  try {
    if (!fs.existsSync(lockPath)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
      pid: number;
    };
    if (!data.pid) return undefined;
    try {
      process.kill(data.pid, 0);
      return data.pid;
    } catch {
      fs.unlinkSync(lockPath);
      return undefined;
    }
  } catch {
    return undefined;
  }
}

export function acquirePidLock(lockPath: string): boolean {
  // Two rounds: the first can prune a stale lock, the second settles a
  // simultaneous-start race (both saw "no lock"; the 'wx' exclusive create
  // lets exactly one win — the loser re-checks and yields).
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = checkPidLock(lockPath);
    if (existing === process.pid) return true;
    if (existing) return false;
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), {
        encoding: 'utf-8',
        flag: 'wx',
      });
      return true;
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      // Raced with another starter — loop to see who holds it now.
    }
  }
  return false;
}

export function releasePidLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf-8')) as {
        pid: number;
      };
      if (data.pid === process.pid) fs.unlinkSync(lockPath);
    }
  } catch {
    /* ignore cleanup errors */
  }
}
