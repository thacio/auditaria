/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNpmShim } from './resolveExecutable.js';

// The two shapes npm writes on Windows (verbatim from codex.cmd / claude.cmd).
const NODE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`;
const EXE_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0
"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*
`;

describe('resolveNpmShim', () => {
  it('maps a node-script shim to `node <script>` and a native shim to the exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-'));
    try {
      mkdirSync(join(dir, 'node_modules', '@openai', 'codex', 'bin'), {
        recursive: true,
      });
      writeFileSync(
        join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        '',
      );
      writeFileSync(join(dir, 'codex.cmd'), NODE_SHIM);
      const node = resolveNpmShim(join(dir, 'codex.cmd'));
      expect(node?.via).toBe('shim-node');
      expect(node?.file).toBe(process.execPath);
      expect(node?.argsPrefix[0]).toMatch(/codex\.js$/);

      mkdirSync(
        join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'),
        { recursive: true },
      );
      writeFileSync(
        join(
          dir,
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'bin',
          'claude.exe',
        ),
        '',
      );
      writeFileSync(join(dir, 'claude.cmd'), EXE_SHIM);
      const exe = resolveNpmShim(join(dir, 'claude.cmd'));
      expect(exe?.via).toBe('shim-exe');
      expect(exe?.file).toMatch(/claude\.exe$/);
      expect(exe?.argsPrefix).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when the shim target does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-'));
    try {
      writeFileSync(join(dir, 'ghost.cmd'), NODE_SHIM);
      expect(resolveNpmShim(join(dir, 'ghost.cmd'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
