/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { PythonJsonlClient } from './PythonJsonlClient.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function worker() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      child.emit('exit', null, 'SIGTERM');
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ReturnType<typeof spawn>,
  );
  child.stdin.on('finish', () => child.emit('exit', 0, null));
  const client = new PythonJsonlClient();
  client.start('python', 'worker.py');
  return { client, child };
}

describe('Python JSONL worker lifecycle', () => {
  it('correlates concurrent requests even when responses arrive out of order', async () => {
    const { client, child } = worker();
    const first = client.request('first');
    const second = client.request('second');
    child.stdout.write(
      '{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n',
    );
    expect(await first).toBe('first');
    expect(await second).toBe('second');
    await client.dispose();
    expect(client.isRunning()).toBe(false);
  });

  it('kills timed-out inference and rejects all queued requests', async () => {
    vi.useFakeTimers();
    const { client, child } = worker();
    await Promise.all([
      expect(client.request('slow', {}, 10)).rejects.toThrow('timed out'),
      expect(client.request('queued')).rejects.toThrow('timed out'),
      vi.advanceTimersByTimeAsync(10),
    ]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(client.isRunning()).toBe(false);
    await client.dispose();
  });

  it('reports worker exit diagnostics without leaving requests pending', async () => {
    const { client, child } = worker();
    const pending = client.request('embed');
    queueMicrotask(() => {
      child.stderr.write('missing dependency');
      child.emit('exit', 1, null);
    });
    await expect(pending).rejects.toThrow('missing dependency');
    await expect(client.request('embed')).rejects.toThrow('not running');
    await client.dispose();
  });

  it('rejects malformed protocol output and terminates the worker', async () => {
    const { client, child } = worker();
    const pending = client.request('embed');
    queueMicrotask(() => child.stdout.write('unexpected log on stdout\n'));
    await expect(pending).rejects.toThrow('Invalid JSON');
    expect(child.kill).toHaveBeenCalledOnce();
    await client.dispose();
  });
});
