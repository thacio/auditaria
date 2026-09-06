/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AsyncEventQueue } from './asyncEventQueue.js';

async function collect<T>(q: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe('AsyncEventQueue', () => {
  it('delivers items pushed before the consumer starts, then ends', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    expect(await collect(q)).toEqual([1, 2]);
  });

  it('wakes a waiting consumer on push and on end', async () => {
    const q = new AsyncEventQueue<string>();
    const done = collect(q);
    await Promise.resolve();
    q.push('a');
    setTimeout(() => {
      q.push('b');
      q.end();
    }, 5);
    expect(await done).toEqual(['a', 'b']);
  });

  it('ignores pushes after end and is idempotent', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.end();
    q.push(2);
    q.end();
    expect(q.ended).toBe(true);
    expect(await collect(q)).toEqual([1]);
  });

  it('fail() rejects the consumer after buffered items', async () => {
    const q = new AsyncEventQueue<number>();
    q.push(1);
    q.fail(new Error('boom'));
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const item of q) seen.push(item);
      })(),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1]);
  });
});
