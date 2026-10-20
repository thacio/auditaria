/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import toml from '@iarna/toml';
import { spawnWithoutShell } from '../../utils/resolveExecutable.js';
import { CodexCLIDriver } from './codexCLIDriver.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeFileSync: vi.fn(),
}));
vi.mock('../../utils/resolveExecutable.js', () => ({
  resolveSpawnSpec: vi.fn(() => ({
    file: 'codex',
    argsPrefix: [],
    via: 'path',
  })),
  spawnWithoutShell: vi.fn(),
}));
vi.mock('../../utils/process-utils.js', () => ({
  killProcessGroup: vi.fn(),
}));

describe('Codex subprocess MCP isolation', () => {
  it('passes independent bridge overrides without modifying shared configuration', async () => {
    vi.mocked(spawnWithoutShell).mockImplementation(
      () =>
        Object.assign(new EventEmitter(), {
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          stdin: { write: vi.fn(), end: vi.fn() },
          exitCode: 0,
        }) as unknown as ChildProcessWithoutNullStreams,
    );
    const drivers = ['call-one', 'call-two'].map(
      (callId, index) =>
        new CodexCLIDriver({
          cwd: '.',
          model: 'gpt-6-luna',
          toolBridgePort: 19751 + index,
          toolBridgeScript: 'C:\\Program Files\\Auditaria\\bridge.js',
          toolBridgeCallId: callId,
          toolBridgeExclude: [`excluded-${index}`],
          mcpServers: {
            evidence: {
              command: 'C:\\Tools\\evidence.exe',
              args: ['--label', 'Quoted "evidence"'],
              env: { AUDIT_LABEL: 'first line\nsecond "line"' },
            },
          },
        }),
    );
    try {
      await Promise.all(
        drivers.map(async (driver) => {
          for await (const _event of driver.sendMessage(
            'Return the result',
            new AbortController().signal,
          )) {
            // Drain the completed provider turn.
          }
        }),
      );
      expect(spawnWithoutShell).toHaveBeenCalledTimes(2);
      for (const [index, call] of vi
        .mocked(spawnWithoutShell)
        .mock.calls.entries()) {
        const args = call[1];
        const overrides = args.filter(
          (arg, position) =>
            args[position - 1] === '-c' && arg.startsWith('mcp_servers.'),
        );
        expect(overrides).toHaveLength(2);
        expect(toml.parse(overrides[0])).toMatchObject({
          mcp_servers: {
            'auditaria-tools': {
              command: process.execPath,
              args: [
                'C:\\Program Files\\Auditaria\\bridge.js',
                '--port',
                String(19751 + index),
                '--exclude',
                `excluded-${index}`,
                '--call-id',
                index === 0 ? 'call-one' : 'call-two',
              ],
            },
          },
        });
        expect(toml.parse(overrides[1])).toMatchObject({
          mcp_servers: {
            evidence: {
              command: 'C:\\Tools\\evidence.exe',
              args: ['--label', 'Quoted "evidence"'],
              env: { AUDIT_LABEL: 'first line\nsecond "line"' },
            },
          },
        });
        expect(args).toContain('tool_output_token_limit=10000');
      }
      drivers[0].dispose();
      drivers[1].dispose();
      expect(spawn).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    } finally {
      for (const driver of drivers) driver.dispose();
      vi.mocked(spawnWithoutShell).mockReset();
    }
  });
});
