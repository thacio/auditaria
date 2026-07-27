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
