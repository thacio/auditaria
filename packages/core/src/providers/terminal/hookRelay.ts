/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Hook relay for PTY-driven CLIs (Codex today;
 * the Claude driver embeds an identical script). The CLI runs
 * `node <relay> <eventName>` per hook fire; the relay reads the JSON payload
 * from stdin and appends ONE JSON line `{event, payload}` to the file named
 * by an environment variable, retrying the append because separate hook
 * processes collide on Windows (EBUSY/EPERM/EACCES) and a silently dropped
 * Stop line used to hang a turn.
 */

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function hookRelaySource(envVar: string): string {
  return `'use strict';
const fs = require('node:fs');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  const event = process.argv[2];
  const file = process.env[${JSON.stringify(envVar)}];
  if (!file) { process.exit(0); }
  let line;
  try {
    const payload = buf.trim() ? JSON.parse(buf) : {};
    line = JSON.stringify({event, payload}) + '\\n';
  } catch (err) {
    line = JSON.stringify({event, error: String(err), raw: buf}) + '\\n';
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.appendFileSync(file, line); break; }
    catch (err) {
      const code = err && err.code;
      if (attempt === 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1)); } catch (_) {}
    }
  }
  process.exit(0);
});
`;
}

/**
 * Write the relay script for `providerId` (once per process) into the temp
 * directory and return its path. Idempotent: an existing file is rewritten
 * only if missing, so several drivers can share it.
 */
export function ensureHookRelayScript(
  providerId: string,
  envVar: string,
  options: { stable?: boolean } = {},
): string {
  // `stable`: one durable path shared by every Auditaria process — for CLIs
  // whose hooks live in a user-level file that outlives us (Copilot): a relay
  // path with a PID (or under a temp dir the OS may purge) would dangle after
  // we exit and error in the user's own sessions.
  let file: string;
  if (options.stable) {
    const dir = join(homedir(), '.auditaria');
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${providerId}-hook-relay.cjs`);
  } else {
    file = join(
      tmpdir(),
      `auditaria-${providerId}-hook-relay-${process.pid}.cjs`,
    );
  }
  const source = hookRelaySource(envVar);
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== source) writeFileSync(file, source, 'utf8');
  return file;
}
