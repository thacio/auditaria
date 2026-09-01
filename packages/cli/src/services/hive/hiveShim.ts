/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Per-instance state for the hive-mcp shim (§6.2): every FOREIGN agent
// process (Claude Code, Codex, Gemini CLI, Copilot… — anything speaking MCP)
// gets its OWN hive identity, nickname, credentials and durable inbox, so
// several foreign agents can be distinct hive peers at once. Mirrors the
// per-instance layout Auditaria peers use (hivePaths.ts), in a separate
// `shim/` namespace so a foreign agent and an Auditaria instance running in
// the same directory never collide on one identity.
//
// Kept free of any @google/gemini-cli-core import so it runs in the lean
// vitest.hive.config.ts suite and bundles cleanly into bundle/hive-mcp.js.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hiveInstanceKey, checkPidLock, acquirePidLock } from './hivePaths.js';
import { readJsonFile, writeJsonFile } from './HiveStore.js';
import { urlTokenOf } from './hivePolicy.js';
import type { HubInfoFile } from './types.js';

// -------------------------------------------------------------------
// Instance identity + layout
// -------------------------------------------------------------------

/**
 * Instance key for a shim process: explicit `--instance` flag wins, then the
 * same derivation Auditaria peers use (AUDITARIA_HIVE_INSTANCE env, else a
 * hash of the working directory — different projects are automatically
 * different peers).
 */
export function shimInstanceKey(
  explicit?: string,
  cwd = process.cwd(),
): string {
  if (explicit && explicit.trim()) {
    return explicit
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
  }
  return hiveInstanceKey(cwd);
}

/** ~/.auditaria/hive/shim/<key> — a foreign agent's private state directory. */
export function getShimInstanceDir(
  key: string,
  homedir = os.homedir(),
): string {
  return path.join(homedir, '.auditaria', 'hive', 'shim', key);
}

export interface ShimInstance {
  key: string;
  dir: string;
  configPath: string;
  inboxPath: string;
  seenPath: string;
  lockPath: string;
}

export function shimInstancePaths(
  key: string,
  homedir = os.homedir(),
): ShimInstance {
  const dir = getShimInstanceDir(key, homedir);
  return {
    key,
    dir,
    configPath: path.join(dir, 'shim.json'),
    inboxPath: path.join(dir, 'inbox.jsonl'),
    seenPath: path.join(dir, 'seen.jsonl'),
    lockPath: path.join(dir, 'instance.lock'),
  };
}

/**
 * Claim an instance for this process. If the base key is held by another
 * live process (a second MCP session in the same directory), fall through
 * deterministic suffixes — `<key>_2`, `<key>_3`, … — so concurrent sessions
 * become distinct peers with their own identity + inbox instead of fighting
 * over one hub connection (the hub displaces duplicate nodeIds).
 * The caller releases lockPath via releasePidLock on exit.
 */
export function acquireShimInstance(
  baseKey: string,
  maxInstances = 9,
  homedir = os.homedir(),
): ShimInstance | undefined {
  for (let n = 1; n <= maxInstances; n++) {
    const key = n === 1 ? baseKey : `${baseKey}_${n}`;
    const inst = shimInstancePaths(key, homedir);
    if (acquirePidLock(inst.lockPath)) return inst;
  }
  return undefined;
}

/** Live PID currently holding an instance, or undefined. */
export function shimInstanceHolder(
  key: string,
  homedir = os.homedir(),
): number | undefined {
  return checkPidLock(shimInstancePaths(key, homedir).lockPath);
}

// -------------------------------------------------------------------
// Persisted per-instance config
// -------------------------------------------------------------------

export interface ShimInstanceConfig {
  nodeId?: string;
  nodePublicKeyPem?: string;
  nodePrivateKeyPem?: string;
  nickname?: string;
  selfDescription?: string;
  /** Base invite URL of the joined hive (persisted after hive_connect). */
  url?: string;
  /**
   * Persisted ONLY when it arrived as a literal (invite line or --passphrase
   * flag). Env-sourced passphrases are never written to disk — same rule as
   * AUDITARIA_HIVE_PASSPHRASE on Auditaria peers.
   */
  passphrase?: string;
  /** Pinned relay key fingerprint (TOFU on first join). */
  relayFingerprint?: string;
  /** hive_leave sets false; hive_connect sets true. Default: join when able. */
  autojoin?: boolean;
}

export function loadShimConfig(inst: ShimInstance): ShimInstanceConfig {
  return readJsonFile<ShimInstanceConfig>(inst.configPath) ?? {};
}

export function saveShimConfig(
  inst: ShimInstance,
  cfg: ShimInstanceConfig,
): void {
  writeJsonFile(inst.configPath, cfg);
}

/** Env passphrase sources, strongest first. Never persisted. */
export function envPassphrase(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env['AUDITARIA_HIVE_PASSPHRASE'] || env['HIVE_PASS'] || undefined;
}

/** A connection resolved from args/config/env, ready for HiveWireClient. */
export interface ShimConnection {
  url: string;
  passphrase: string;
  inviteToken?: string;
  /** True when the passphrase may be persisted (came from a literal source). */
  persistPassphrase: boolean;
}

/**
 * Resolve where to connect from the available sources, in precedence order:
 * CLI args (legacy registrations) → saved instance config → machine-local
 * hub discovery (hub-info.json) + env passphrase. Returns undefined when no
 * complete url+passphrase pair exists — the shim then starts unjoined and
 * waits for hive_connect.
 */
export function resolveShimConnection(params: {
  argUrl?: string;
  argPassphrase?: string;
  argPassphraseFromEnv?: boolean;
  argInvite?: string;
  cfg: ShimInstanceConfig;
  envPass?: string;
  hubInfo?: { url?: string; loopbackUrl?: string };
}): ShimConnection | undefined {
  const { cfg } = params;
  const url =
    params.argUrl ||
    cfg.url ||
    params.hubInfo?.loopbackUrl ||
    params.hubInfo?.url;
  const passphrase = params.argPassphrase || params.envPass || cfg.passphrase;
  if (!url || !passphrase) return undefined;
  const fromLiteralArg = !!params.argPassphrase && !params.argPassphraseFromEnv;
  return {
    url: url.replace(/\/+$/, ''),
    passphrase,
    inviteToken: params.argInvite,
    // cfg.passphrase is already persisted; env-sourced must never be written.
    persistPassphrase:
      fromLiteralArg || (!params.argPassphrase && !params.envPass),
  };
}

// -------------------------------------------------------------------
// Zero-config local hive discovery (hive_join_local)
// -------------------------------------------------------------------

/**
 * Find the hive this machine is already part of, with NO invite from the
 * user: the hub's discovery file plus the saved connection of any local
 * Auditaria peer. An agent already running on this machine sits inside the
 * same user/filesystem trust domain as those files, so joining from them
 * grants nothing the agent could not already read — it just removes the
 * copy-paste ceremony that left agents stranded.
 *
 * Sources, strongest first:
 *  1. env passphrase + hub-info.json (hub machine, secret kept off disk)
 *  2. the hub-hosting Auditaria instance's saved config
 *  3. the most recently updated Auditaria instance config with a saved hive
 *  4. the legacy machine-wide ~/.auditaria/hive.json
 * When the saved URL is this machine's own hub, the loopback address is
 * preferred (immune to quick-tunnel rotation).
 */
export function discoverLocalHive(
  homedir = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): (ShimConnection & { source: string }) | undefined {
  const hubInfo = readJsonFile<HubInfoFile>(
    path.join(homedir, '.auditaria', 'hive', 'hub-info.json'),
  );
  const envPass = envPassphrase(env);

  interface Candidate {
    url: string;
    passphrase?: string;
    isHub: boolean;
    mtime: number;
    source: string;
  }
  const candidates: Candidate[] = [];
  const pushCandidate = (configPath: string, source: string) => {
    const cfg = readJsonFile<{
      url?: string;
      passphrase?: string;
      hub?: unknown;
    }>(configPath);
    if (!cfg?.url) return;
    if (!cfg.passphrase && !envPass) return;
    let mtime = 0;
    try {
      mtime = fs.statSync(configPath).mtimeMs;
    } catch {
      /* keep 0 */
    }
    candidates.push({
      url: cfg.url,
      passphrase: cfg.passphrase,
      isHub: !!cfg.hub,
      mtime,
      source,
    });
  };

  const instRoot = path.join(homedir, '.auditaria', 'hive', 'instances');
  try {
    for (const name of fs.readdirSync(instRoot)) {
      pushCandidate(
        path.join(instRoot, name, 'config.json'),
        `local Auditaria instance "${name}"`,
      );
    }
  } catch {
    /* no instances dir */
  }
  pushCandidate(
    path.join(homedir, '.auditaria', 'hive.json'),
    'legacy hive.json',
  );

  if (candidates.length === 0) {
    if (envPass && hubInfo?.loopbackUrl) {
      return {
        url: hubInfo.loopbackUrl.replace(/\/+$/, ''),
        passphrase: envPass,
        persistPassphrase: false,
        source: 'local hub discovery + env passphrase',
      };
    }
    return undefined;
  }

  candidates.sort(
    (a, b) => Number(b.isHub) - Number(a.isHub) || b.mtime - a.mtime,
  );
  const best = candidates[0];
  let url = best.url;
  if (
    hubInfo?.loopbackUrl &&
    hubInfo.urlToken &&
    urlTokenOf(url) === hubInfo.urlToken
  ) {
    url = hubInfo.loopbackUrl;
  }
  return {
    url: url.replace(/\/+$/, ''),
    passphrase: envPass ?? best.passphrase!,
    persistPassphrase: !envPass,
    source: best.source,
  };
}

// -------------------------------------------------------------------
// Read-only inbox peek (for one-shot --check beside a LIVE shim)
// -------------------------------------------------------------------

/**
 * Count pending entries of a JsonlQueueStore file WITHOUT opening it for
 * write. JsonlQueueStore.load() compacts (truncate + reappend), which must
 * never run against a file another live process holds open — this peek only
 * reads. Returns the pending count and the first pending value.
 */
export function peekJsonlPending<T>(filePath: string): {
  count: number;
  first?: T;
  values: T[];
} {
  let raw = '';
  try {
    if (!fs.existsSync(filePath)) return { count: 0, values: [] };
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { count: 0, values: [] };
  }
  const pending = new Map<number, T>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const parsed = JSON.parse(trimmed) as
        | { op: 'enq'; seq: number; v: T }
        | { op: 'ack'; seq: number };
      if (parsed.op === 'enq') pending.set(parsed.seq, parsed.v);
      else if (parsed.op === 'ack') pending.delete(parsed.seq);
    } catch {
      // torn tail line — ignore
    }
  }
  const values = [...pending.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  return { count: values.length, first: values[0], values };
}

// -------------------------------------------------------------------
// Legacy single-identity state (pre-per-instance shim)
// -------------------------------------------------------------------

/**
 * Note about the old machine-global shim state, if any survives. The shim
 * used ONE identity + inbox for the whole machine at ~/.auditaria/hive-shim;
 * that state is no longer read (each instance now has its own). Surfaced on
 * stderr so a pre-existing enrollment/nickname isn't silently "lost".
 */
export function legacyShimNotice(homedir = os.homedir()): string | undefined {
  const legacyDir = path.join(homedir, '.auditaria', 'hive-shim');
  try {
    if (!fs.existsSync(path.join(legacyDir, 'shim.json'))) return undefined;
  } catch {
    return undefined;
  }
  const { count } = peekJsonlPending(path.join(legacyDir, 'inbox.jsonl'));
  return (
    `hive-mcp: legacy machine-global shim state found at ${legacyDir} ` +
    `(identity + ${count} undrained message(s)). The shim is now per-instance ` +
    `and no longer reads it — re-join with hive_connect; delete the folder when done.`
  );
}
