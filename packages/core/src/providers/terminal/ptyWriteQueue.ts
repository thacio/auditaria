/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: PtyWriteQueue — serialises all writes to a
 * provider PTY behind one mutex with priorities (system > cli-typist >
 * web-typist) and an atomic-block gate that keeps a typed prompt's body and
 * CR together. Shared by every PTY-driven provider (Claude, Copilot, …).
 *
 * Typist bytes that arrive while the gate is up are BUFFERED and delivered in
 * order after the block (they used to be dropped silently — a user typing in
 * the web terminal while a chat prompt was being typed lost keystrokes).
 * Atomic blocks are serialised through a lease so two dispatches can never
 * interleave. A failed PTY write rejects the caller's promise instead of
 * being swallowed, and an oversized backlog is refused up front.
 */

export type WritePriority = 'system' | 'cli-typist' | 'web-typist';

const CHUNK_SIZE = 512;
const CHUNK_DELAY_MS = 8;
/** Refuse new writes when this many bytes are already waiting. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface QueuedWrite {
  priority: WritePriority;
  bytes: string;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class PtyWriteQueue {
  private writeFn: (bytes: string) => void;
  private queue: QueuedWrite[] = [];
  private running = false;
  /** When true, only `system`-priority writes drain; typist bytes wait. */
  private gated = false;
  /** Atomic blocks run one after another. */
  private lease: Promise<unknown> = Promise.resolve();

  constructor(writeFn: (bytes: string) => void) {
    this.writeFn = writeFn;
  }

  /** Replace the underlying write function (e.g. PTY changed across turns). */
  setWriteFn(writeFn: (bytes: string) => void): void {
    this.writeFn = writeFn;
  }

  writeAtomic(bytes: string, priority: WritePriority): Promise<void> {
    const backlog = this.queue.reduce((n, w) => n + w.bytes.length, 0);
    if (backlog + bytes.length > MAX_BUFFERED_BYTES) {
      return Promise.reject(
        new Error(
          'Terminal input buffer is full; retry after the current write.',
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ priority, bytes, resolve, reject });
      this.queue.sort(priorityCompare);
      void this.drain();
    });
  }

  /**
   * Write a large payload as paced chunks instead of one burst. A TUI input
   * parser (Ink) drops the LEADING part of a very large single write, so a
   * long prompt reaches the model truncated to its tail (the "only the footer
   * arrived" hive symptom). Splitting into small chunks with a brief gap lets
   * the reader keep up. Payloads at or under `chunkSize` fall through to a
   * single writeAtomic — unchanged behavior for normal-length prompts.
   */
  async writeChunked(
    bytes: string,
    priority: WritePriority,
    chunkSize = CHUNK_SIZE,
    delayMs = CHUNK_DELAY_MS,
  ): Promise<void> {
    if (bytes.length <= chunkSize) {
      await this.writeAtomic(bytes, priority);
      return;
    }
    let i = 0;
    while (i < bytes.length) {
      let end = Math.min(i + chunkSize, bytes.length);
      // Don't split a surrogate pair (e.g. an emoji) across chunks — a lone
      // half encodes to invalid UTF-8 on the wire. Push a trailing high
      // surrogate into the next chunk.
      if (end < bytes.length) {
        const code = bytes.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      await this.writeAtomic(bytes.slice(i, end), priority);
      i = end;
      if (i < bytes.length) {
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    }
  }

  /**
   * Run `fn` with the gate up: queued non-system writes wait while inside and
   * drain afterwards, in order. `fn` may itself call writeAtomic('…', 'system').
   * Blocks are serialised — a second block waits for the first to finish.
   */
  withAtomicBlock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lease.then(async () => {
      this.gated = true;
      try {
        return await fn();
      } finally {
        this.gated = false;
        void this.drain();
      }
    });
    this.lease = run.catch(() => {});
    return run;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        if (this.gated && this.queue[0].priority !== 'system') break;
        const next = this.queue.shift()!;
        try {
          this.writeFn(next.bytes);
          next.resolve();
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function priorityCompare(a: QueuedWrite, b: QueuedWrite): number {
  const rank = (p: WritePriority): number =>
    p === 'system' ? 0 : p === 'cli-typist' ? 1 : 2;
  return rank(a.priority) - rank(b.priority);
}
