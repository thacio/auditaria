/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_AVAILABILITY: Shell-free executable resolution.
 *
 * On some corporate machines `cmd.exe` and PowerShell are blocked by policy.
 * Anything that spawns a provider CLI through a shell (`shell: true`,
 * `shell: 'powershell.exe'`) or through an npm `.cmd` shim (which IS a cmd.exe
 * batch file) fails there, so Codex / Copilot looked "not installed" and their
 * model lists never refreshed. This module resolves what a command name really
 * runs — the underlying `node <script>` or native binary behind the shim — so
 * callers can spawn it directly with `shell: false`.
 */

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithStdioTuple,
} from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { resolveExecutable } from './shell-utils.js';

export interface SpawnSpec {
  /** The file to execute (a native binary, or the Node executable). */
  file: string;
  /** Arguments that go BEFORE the caller's own arguments (e.g. the script path). */
  argsPrefix: string[];
  /** How it was resolved — for diagnostics. */
  via: 'path' | 'shim-node' | 'shim-exe' | 'absolute';
}

/** Find `name` on PATH without invoking `where`/`which` — the existing
 *  shell-free walk in `shell-utils.ts` (exe, cmd, bat, then bare name). */
export function findOnPath(name: string): string | undefined {
  const found = resolveExecutable(name);
  if (!found) return undefined;
  // npm also drops an extension-less Unix shell script beside `<name>.cmd`;
  // ConPTY cannot run it ("Cannot create process"), so never return it on
  // Windows — the shim (parsed below) or a real binary must exist instead.
  if (process.platform === 'win32' && !/\.[A-Za-z0-9]+$/.test(found)) {
    const withCmd = found + '.cmd';
    return existsSync(withCmd) ? withCmd : undefined;
  }
  return found;
}

/**
 * npm's Windows shim (`<name>.cmd`) ends with a line like
 *   `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`   (node script)
 *   `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*` (native)
 * Parse the quoted `%dp0%`-relative target and say how to run it.
 */
export function resolveNpmShim(shimPath: string): SpawnSpec | undefined {
  let text: string;
  try {
    text = readFileSync(shimPath, 'utf8');
  } catch {
    return undefined;
  }
  const dp0 = dirname(shimPath);
  const targets = [...text.matchAll(/"%dp0%\\?([^"]+)"/g)].map((m) =>
    normalize(join(dp0, m[1])),
  );
  const target = targets.find((t) => existsSync(t));
  if (!target) return undefined;
  if (/\.(exe|com)$/i.test(target)) {
    return { file: target, argsPrefix: [], via: 'shim-exe' };
  }
  // A JS entry: run it with the Node that runs us (never the shell's `node`).
  return { file: process.execPath, argsPrefix: [target], via: 'shim-node' };
}

/**
 * How to spawn `name` without a shell. Returns undefined when it is not
 * installed. A `.cmd` shim is parsed to its real target; anything else is
 * spawned as-is.
 */
export function resolveSpawnSpec(name: string): SpawnSpec | undefined {
  const found = findOnPath(name);
  if (!found) return undefined;
  if (process.platform === 'win32' && /\.cmd$/i.test(found)) {
    const parsed = resolveNpmShim(found);
    if (parsed) return parsed;
    // Unparseable shim: the caller must decide (a shell would be needed).
    return undefined;
  }
  return {
    file: found,
    argsPrefix: [],
    via: isAbsolute(name) ? 'absolute' : 'path',
  };
}

/**
 * Spawn `name` without any shell (see the module header). Returns null when
 * the command cannot be resolved to a shell-free target — callers may then
 * fall back to their previous shell-based spawn so nothing regresses where a
 * shell IS available.
 */
export function spawnWithoutShell(
  name: string,
  args: string[],
  options: Omit<SpawnOptionsWithStdioTuple<'pipe', 'pipe', 'pipe'>, 'shell'>,
): ChildProcessWithoutNullStreams | null;
export function spawnWithoutShell(
  name: string,
  args: string[],
  options?: Omit<SpawnOptions, 'shell'>,
): ChildProcess | null;
export function spawnWithoutShell(
  name: string,
  args: string[],
  options: Omit<SpawnOptions, 'shell'> = {},
): ChildProcess | null {
  const spec = resolveSpawnSpec(name);
  if (!spec) return null;
  return spawn(spec.file, [...spec.argsPrefix, ...args], {
    ...options,
    shell: false,
    windowsHide: true,
  });
}
