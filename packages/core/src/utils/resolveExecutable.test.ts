/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  findOnPath,
  resolveNpmShim,
  resolveSpawnSpec,
} from './resolveExecutable.js';
import { resolveCodexExecutable } from '../providers/codex/codexExecutable.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

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
      // npm can be installed next to node.exe. The IF EXIST check is not the
      // provider invocation and must never resolve to node.exe --version.
      writeFileSync(join(dir, 'node.exe'), '');
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
      writeFileSync(join(dir, 'node.exe'), '');
      expect(resolveNpmShim(join(dir, 'ghost.cmd'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ['copilot.cmd', '"%~dp0node_modules\\@github\\copilot\\index.js" %*'],
    [
      'copilot.ps1',
      '& "node$exe" "$basedir/node_modules/@github/copilot/index.js" $args',
    ],
  ])(
    'resolves the provider script from %s without executing a shell',
    (name, invocation) => {
      const dir = mkdtempSync(join(tmpdir(), 'shim-'));
      try {
        const pkg = join(dir, 'node_modules', '@github', 'copilot');
        mkdirSync(pkg, { recursive: true });
        const script = join(pkg, 'index.js');
        writeFileSync(script, '');
        writeFileSync(join(dir, name), invocation);
        expect(resolveNpmShim(join(dir, name))).toEqual({
          file: process.execPath,
          argsPrefix: [script],
          via: 'shim-node',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('findOnPath', () => {
  it('skips directories and searches subsequent PATH entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-path-'));
    try {
      const name =
        process.platform === 'win32' ? 'test-provider.exe' : 'test-provider';
      mkdirSync(join(dir, name));
      mkdirSync(join(dir, 'bin'));
      const executable = join(dir, 'bin', name);
      writeFileSync(executable, '', { mode: 0o755 });
      vi.stubEnv('PATH', [dir, join(dir, 'bin')].join(delimiter));
      expect(findOnPath('test-provider')).toBe(executable);
      expect(findOnPath(join(dir, name))).toBeUndefined();
      expect(findOnPath('missing-provider')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors the Codex executable override without PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-override-'));
    try {
      const executable = join(dir, 'custom-codex.exe');
      writeFileSync(executable, '', { mode: 0o755 });
      vi.stubEnv('CODEX_EXE', executable);
      vi.stubEnv('PATH', '');
      expect(resolveCodexExecutable()).toEqual({
        file: executable,
        argsPrefix: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe.runIf(process.platform === 'win32')('Windows discovery', () => {
    it('resolves a PowerShell-only npm launcher on a quoted PATH', () => {
      const dir = mkdtempSync(join(tmpdir(), 'provider path '));
      try {
        const script = join(dir, 'provider.js');
        writeFileSync(script, '');
        writeFileSync(
          join(dir, 'test-provider.ps1'),
          '& node "$basedir/provider.js" $args',
        );
        vi.stubEnv('PATH', `"${dir}"`);
        expect(resolveSpawnSpec('test-provider')).toEqual({
          file: process.execPath,
          argsPrefix: [script],
          via: 'shim-node',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('discovers an npm installation outside a stale PATH', () => {
      const dir = mkdtempSync(join(tmpdir(), 'provider-appdata-'));
      try {
        const npm = join(dir, 'npm');
        mkdirSync(npm);
        const executable = join(npm, 'copilot.exe');
        writeFileSync(executable, '');
        vi.stubEnv('PATH', '');
        vi.stubEnv('npm_config_prefix', '');
        vi.stubEnv('APPDATA', dir);
        expect(findOnPath('copilot')).toBe(executable);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not mistake an extensionless Unix launcher for a Windows executable', () => {
      const dir = mkdtempSync(join(tmpdir(), 'provider-path-'));
      try {
        writeFileSync(join(dir, 'test-provider'), '#!/bin/sh');
        vi.stubEnv('PATH', dir);
        expect(findOnPath('test-provider')).toBeUndefined();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
