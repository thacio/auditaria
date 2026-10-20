/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { ClaudeCLIDriverPrint } from './claudeCLIDriver.print.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../utils/process-utils.js', () => ({
  killProcessGroup: vi.fn(),
}));

describe('Claude print bridge configuration', () => {
  it('isolates concurrent MCP files and their cleanup when the clock is unchanged', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.mocked(spawn).mockImplementation(
      () =>
        Object.assign(new EventEmitter(), {
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          stdin: { write: vi.fn(), end: vi.fn() },
          exitCode: 0,
        }) as unknown as ChildProcess,
    );
    const drivers = ['first-call', 'second-call'].map(
      (toolBridgeCallId) =>
        new ClaudeCLIDriverPrint({
          cwd: tmpdir(),
          toolBridgePort: 12345,
          toolBridgeScript: 'bridge.js',
          toolBridgeCallId,
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
      const paths = vi.mocked(spawn).mock.calls.map((call) => {
        const args = call[1];
        if (!Array.isArray(args)) throw new Error('Missing spawn arguments');
        const value = args[args.indexOf('--mcp-config') + 1];
        if (typeof value !== 'string') throw new Error('Missing MCP path');
        return value.replace(/^"|"$/g, '');
      });
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(paths[1]);
      for (const [index, configPath] of paths.entries()) {
        const config: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
        expect(config).toMatchObject({
          mcpServers: {
            'auditaria-tools': {
              args: expect.arrayContaining([
                '--call-id',
                index === 0 ? 'first-call' : 'second-call',
              ]),
            },
          },
        });
      }
      drivers[0].dispose();
      expect(existsSync(paths[0])).toBe(false);
      expect(existsSync(paths[1])).toBe(true);
      drivers[1].dispose();
      expect(existsSync(paths[1])).toBe(false);
    } finally {
      for (const driver of drivers) driver.dispose();
      clock.mockRestore();
      vi.mocked(spawn).mockReset();
    }
  });
});
