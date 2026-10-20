/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/** Serializes asynchronous operations without poisoning the queue on failure. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}
