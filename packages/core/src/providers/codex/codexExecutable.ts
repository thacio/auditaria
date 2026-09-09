/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CODEX_PROVIDER: the real Codex binary, without cmd.exe or the
 * node shim layer: npm's `codex.cmd` → `bin/codex.js` → vendor
 * `codex-<platform>-<arch>/…/codex(.exe)`. Falls back to `node codex.js`,
 * then to whatever is on PATH. Shared by the PTY driver and the metadata
 * refresh (both must work where shells are blocked).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findOnPath, resolveNpmShim } from '../../utils/resolveExecutable.js';

export interface CodexExecutable {
  file: string;
  argsPrefix: string[];
}

export function resolveCodexExecutable(): CodexExecutable | undefined {
  const fromEnv = process.env['CODEX_EXE'];
  if (fromEnv && existsSync(fromEnv)) return { file: fromEnv, argsPrefix: [] };
  const found = findOnPath('codex');
  if (!found) return undefined;
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(found)) {
    const shim = resolveNpmShim(found);
    if (shim?.via === 'shim-node') {
      const pkgDir = dirname(dirname(shim.argsPrefix[0])); // …/@openai/codex
      const vendor = join(
        pkgDir,
        'node_modules',
        '@openai',
        `codex-${process.platform}-${process.arch}`,
        'vendor',
      );
      for (const triple of [
        'x86_64-pc-windows-msvc',
        'aarch64-pc-windows-msvc',
      ]) {
        const exe = join(vendor, triple, 'bin', 'codex.exe');
        if (existsSync(exe)) return { file: exe, argsPrefix: [] };
      }
      return { file: shim.file, argsPrefix: shim.argsPrefix };
    }
    if (shim) return { file: shim.file, argsPrefix: shim.argsPrefix };
    return { file: found, argsPrefix: [] };
  }
  return { file: found, argsPrefix: [] };
}
