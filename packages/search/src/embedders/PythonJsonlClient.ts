/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Owns process lifecycle and JSONL framing, independently of any ML library. */
export class PythonJsonlClient {
  private process?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private stderr = '';

  start(command: string, script: string): void {
    if (this.process) throw new Error('Python worker already started');
    this.stderr = '';
    const child = spawn(command, ['-u', script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      try {
        const response: unknown = JSON.parse(line);
        if (
          !response ||
          typeof response !== 'object' ||
          !('id' in response) ||
          typeof response.id !== 'number'
        )
          throw new Error('Invalid response envelope');
        const pending = this.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(response.id);
        if ('error' in response)
          pending.reject(new Error(String(response.error)));
        else
          pending.resolve('result' in response ? response.result : undefined);
      } catch {
        this.fail(new Error('Invalid JSON from Python embedding worker'));
        child.kill();
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4000);
    });
    child.stdin.on('error', (error) => this.fail(error));
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      this.process = undefined;
      this.lines?.close();
      this.fail(
        new Error(
          `Python embedding worker exited (${code ?? signal}). ${this.stderr}`,
        ),
      );
    });
  }

  isRunning(): boolean {
    return (
      !!this.process && this.process.exitCode === null && !this.process.killed
    );
  }

  request<T>(
    method: string,
    params: object = {},
    timeoutMs = 120_000,
  ): Promise<T> {
    if (!this.isRunning())
      return Promise.reject(new Error('Python worker is not running'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(
          new Error(
            `Python embedding request timed out: ${method}. ${this.stderr}`,
          ),
        );
        // A timed-out inference must not keep using GPU memory in the background.
        this.process?.kill();
      }, timeoutMs);
      this.pending.set(id, {
        // The model adapter validates dimensions and values; this layer only frames JSON.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.process!.stdin.write(
        JSON.stringify({ id, method, ...params }) + '\n',
        (error) => {
          if (error) this.fail(error);
        },
      );
    });
  }

  async dispose(): Promise<void> {
    const child = this.process;
    this.fail(new Error('Python embedding worker disposed'));
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.stdin.end();
    });
    this.lines?.close();
    this.lines = undefined;
    this.process = undefined;
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
