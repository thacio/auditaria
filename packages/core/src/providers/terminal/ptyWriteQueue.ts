/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: PTY write serialisation, shared by all
 * PTY-driven provider drivers (moved verbatim from
 * claude/interactivePromptSupport.ts, which re-exports it for
 * backwards-compatible imports).
 */

export type WritePriority = 'system' | 'cli-typist' | 'web-typist';

interface QueuedWrite {
  priority: WritePriority;
  bytes: string;
  resolve: () => void;
}

/**
 * Serialises writes to a PTY through a single mutex queue. Two roles:
 *
 *   - `writeAtomic(bytes, priority)`: enqueues bytes; resolves when written.
 *   - `withAtomicBlock(fn)`: runs `fn` while holding the lock, so a sequence
 *     of `write()` calls inside is uninterrupted by web-typist input.
 *     Used by prompt-typing to keep prompt+CR together.
 *
 * Lower-priority writes wait for higher-priority ones to drain. The actual
 * write is just `pty.write(bytes)`; the queue is about ordering, not
 * backpressure.
 */
export class PtyWriteQueue {
  private writeFn: (bytes: string) => void;
  private queue: QueuedWrite[] = [];
  private running = false;
  /** When true, only `system`-priority writes are accepted. */
  private gated = false;

  constructor(writeFn: (bytes: string) => void) {
    this.writeFn = writeFn;
  }

  /** Replace the underlying write function (e.g. PTY changed across turns). */
  setWriteFn(writeFn: (bytes: string) => void): void {
    this.writeFn = writeFn;
  }

  writeAtomic(bytes: string, priority: WritePriority): Promise<void> {
    if (this.gated && priority !== 'system') {
      // Silently drop typist writes while the gate is up (prompt being typed).
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push({ priority, bytes, resolve });
      this.queue.sort(priorityCompare);
      void this.drain();
    });
  }

  /**
   * Run `fn` with the gate up: queued non-system writes are dropped while
   * inside. `fn` may itself call writeAtomic('...', 'system').
   */
  async withAtomicBlock<T>(fn: () => Promise<T>): Promise<T> {
    this.gated = true;
    try {
      return await fn();
    } finally {
      this.gated = false;
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        try {
          this.writeFn(next.bytes);
        } catch {
          /* PTY died — drop silently, caller will see via exit handler */
        }
        next.resolve();
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
