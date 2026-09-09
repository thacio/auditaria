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
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
} from 'node:path';

export interface SpawnSpec {
  /** The file to execute (a native binary, or the Node executable). */
  file: string;
  /** Arguments that go BEFORE the caller's own arguments (e.g. the script path). */
  argsPrefix: string[];
  /** How it was resolved — for diagnostics. */
  via: 'path' | 'shim-node' | 'shim-exe' | 'absolute';
}

function isExecutableFile(file: string, mode = constants.X_OK): boolean {
  try {
    accessSync(file, mode);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Find a command without invoking a shell, `where`, `which`, or npm. */
export function findOnPath(name: string): string | undefined {
  if (isAbsolute(name)) return isExecutableFile(name) ? name : undefined;
  const windows = process.platform === 'win32';
  const pathKey = Object.keys(process.env).find((key) =>
    windows ? key.toUpperCase() === 'PATH' : key === 'PATH',
  );
  const dirs = (pathKey ? process.env[pathKey] : '')?.split(delimiter) ?? [];
  // A running app can inherit PATH before an installer updates it. Keep these
  // fallbacks shared with the drivers so discovery and launching agree.
  if (windows && ['claude', 'codex', 'copilot', 'agy'].includes(name)) {
    const appData = process.env['APPDATA'];
    const localAppData = process.env['LOCALAPPDATA'];
    const npmPrefix = process.env['npm_config_prefix'];
    if (npmPrefix) dirs.push(npmPrefix);
    if (appData) dirs.push(join(appData, 'npm'));
    dirs.push(dirname(process.execPath), join(homedir(), '.local', 'bin'));
    if (localAppData) {
      dirs.push(join(localAppData, 'Microsoft', 'WinGet', 'Links'));
    }
    dirs.push(join(homedir(), 'scoop', 'shims'));
  }
  // Never return npm's extensionless Unix shell script on Windows.
  const extensions =
    windows && !extname(name) ? ['.exe', '.com', '.cmd', '.bat', '.ps1'] : [''];
  for (const dir of new Set(dirs)) {
    const unquoted = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!unquoted) continue;
    for (const extension of extensions) {
      const candidate = join(unquoted, name + extension);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
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
  // Only inspect the invocation's target, not IF EXIST "%dp0%\node.exe".
  // Also recognize older cmd shims and npm's PowerShell-only launchers.
  const pattern = /\.ps1$/i.test(shimPath)
    ? /"\$basedir[\\/]([^"]+)"\s+\$args\b/gi
    : /"%(?:dp0%|~dp0)[\\/]?([^"]+)"\s+%\*/gi;
  const targets = [...text.matchAll(pattern)].map((m) =>
    normalize(join(dp0, m[1].replace(/[\\/]/g, '/'))),
  );
  const target = targets.find((t) => isExecutableFile(t, constants.R_OK));
  if (!target) return undefined;
  if (/\.(exe|com)$/i.test(target)) {
    return { file: target, argsPrefix: [], via: 'shim-exe' };
  }
  if (!/\.[cm]?js$/i.test(target)) return undefined;
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
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found)) {
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
