/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Minimal unbounded push → pull bridge. A
 * producer that discovers events on its own clock (a PTY observer polling a
 * transcript) pushes into the queue; a consumer drains it with `for await`.
 * `end()` closes the queue after the buffered items are delivered; `fail()`
 * rejects the consumer after them. Both are idempotent.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private failure: unknown = undefined;

  /** Items pushed but not yet consumed. */
  get size(): number {
    return this.buffer.length;
  }

  /** True once `end()` or `fail()` was called (buffered items still drain). */
  get ended(): boolean {
    return this.closed;
  }

  push(item: T): void {
    if (this.closed) return;
    this.buffer.push(item);
    this.wake();
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
