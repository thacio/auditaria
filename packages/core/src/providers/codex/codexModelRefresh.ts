/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CODEX_PROVIDER: refresh Codex's model list WITHOUT a model turn.
 *
 * Codex keeps its catalog in `$CODEX_HOME/models_cache.json`, which our
 * `codexModelCatalog.ts` reads (memoised on mtime). Codex rewrites that file
 * whenever one of its processes starts — verified with a metadata-only
 * `codex app-server` handshake (`initialize` + `model/list`, then exit):
 * the cache was rewritten and the list returned matched it. So a refresh is
 * a short app-server process; no inference, no config edits. Throttled, and
 * spawned without a shell (corporate PCs).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCodexExecutable } from './codexExecutable.js';
import { isPlainObject } from '../terminal/turnObserver.js';

/** Do not refresh more often than this unless forced. */
export const CODEX_MODELS_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 30_000;

let lastAttemptAt = 0;
let inFlight: Promise<string[] | null> | null = null;

/** Model ids from the last successful handshake (informational). */
export let lastCodexModelIds: string[] | null = null;

/**
 * Ask a short-lived `codex app-server` for its model list (metadata only).
 * Resolves with the ids, or null when Codex is missing / not logged in /
 * timed out — callers keep their cached list. The side effect that matters
 * is Codex rewriting its own `models_cache.json`.
 */
export function refreshCodexModelsCache(
  force = false,
): Promise<string[] | null> {
  if (inFlight) return inFlight;
  if (
    !force &&
    Date.now() - lastAttemptAt < CODEX_MODELS_REFRESH_MIN_INTERVAL_MS
  ) {
    return Promise.resolve(null);
  }
  lastAttemptAt = Date.now();
  inFlight = runHandshake().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function runHandshake(): Promise<string[] | null> {
  return new Promise((resolve) => {
    const exe = resolveCodexExecutable();
    if (!exe) {
      resolve(null);
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(
        exe.file,
        [...exe.argsPrefix, 'app-server', '--disable', 'apps'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        },
      );
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (ids: string[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      if (ids) lastCodexModelIds = ids;
      resolve(ids);
    };
    const timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    child.stderr?.resume();
    child.stdin?.on('error', () => finish(null));
    const send = (msg: Record<string, unknown>) => {
      try {
        child.stdin?.write(JSON.stringify(msg) + '\n');
      } catch {
        finish(null);
      }
    };
    if (!child.stdout) {
      finish(null);
      return;
    }
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isPlainObject(msg)) return;
      if (msg['id'] === 1) {
        send({ method: 'initialized' });
        send({
          id: 2,
          method: 'model/list',
          params: { limit: 100, includeHidden: false },
        });
        return;
      }
      if (msg['id'] === 2) {
        const result = isPlainObject(msg['result']) ? msg['result'] : {};
        const data = Array.isArray(result['data']) ? result['data'] : [];
        const ids: string[] = [];
        for (const entry of data) {
          if (!isPlainObject(entry)) continue;
          const id = entry['id'] ?? entry['model'];
          if (typeof id === 'string') ids.push(id);
        }
        finish(ids);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'auditaria', title: 'Auditaria', version: '0.0.0' },
        capabilities: {},
      },
    });
  });
}
