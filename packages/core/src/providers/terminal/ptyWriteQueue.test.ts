/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_PROVIDER_TERMINAL

import { describe, it, expect } from 'vitest';
import { PtyWriteQueue } from './ptyWriteQueue.js';

describe('PtyWriteQueue.writeChunked', () => {
  it('writes a small payload as a single write (unchanged behavior)', async () => {
    const writes: string[] = [];
    const q = new PtyWriteQueue((b) => writes.push(b));
    await q.writeChunked('hello', 'system', 512, 0);
    expect(writes).toEqual(['hello']);
  });

  it('splits a large payload into paced chunks that concatenate to the original', async () => {
    const writes: string[] = [];
    const q = new PtyWriteQueue((b) => writes.push(b));
    const payload = 'x'.repeat(1300);
    await q.writeChunked(payload, 'system', 512, 0);
    expect(writes.length).toBe(3); // 512 + 512 + 276
    expect(writes.every((c) => c.length <= 512)).toBe(true);
    expect(writes.join('')).toBe(payload);
  });

  it('never splits a surrogate pair (emoji) across chunks', async () => {
    const writes: string[] = [];
    const q = new PtyWriteQueue((b) => writes.push(b));
    // A run of emoji (each a surrogate pair) longer than the chunk size.
    const payload = '🐝'.repeat(600); // 1200 UTF-16 code units
    await q.writeChunked(payload, 'system', 5, 0);
    // Round-trips exactly...
    expect(writes.join('')).toBe(payload);
    // ...and no chunk ends on a lone high surrogate.
    for (const c of writes) {
      const last = c.charCodeAt(c.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('preserves order across chunks', async () => {
    const writes: string[] = [];
    const q = new PtyWriteQueue((b) => writes.push(b));
    const payload = 'ABCDEFGHIJ'.repeat(200); // 2000 chars
    await q.writeChunked(payload, 'system', 512, 0);
    expect(writes.join('')).toBe(payload);
  });
});

describe('PtyWriteQueue gate and lease', () => {
  it('buffers typist bytes during an atomic block and delivers them after it, in order', async () => {
    const writes: string[] = [];
    const q = new PtyWriteQueue((b) => writes.push(b));
    let typed: Promise<void> | undefined;
    await q.withAtomicBlock(async () => {
      await q.writeAtomic('prompt', 'system');
      typed = q.writeAtomic('k', 'web-typist'); // used to be dropped
      await q.writeAtomic('\r', 'system');
    });
    await typed;
    expect(writes).toEqual(['prompt', '\r', 'k']);
  });

  it('serialises atomic blocks', async () => {
    const writes: string[] = [];
    const q = new PtyWriteQueue((b) => writes.push(b));
    const first = q.withAtomicBlock(async () => {
      await q.writeAtomic('a1', 'system');
      await new Promise((r) => setTimeout(r, 10));
      await q.writeAtomic('a2', 'system');
    });
    const second = q.withAtomicBlock(async () => {
      await q.writeAtomic('b1', 'system');
    });
    await Promise.all([first, second]);
    expect(writes).toEqual(['a1', 'a2', 'b1']);
  });

  it('rejects the caller when the PTY write fails', async () => {
    const q = new PtyWriteQueue(() => {
      throw new Error('EPIPE');
    });
    await expect(q.writeAtomic('x', 'system')).rejects.toThrow('EPIPE');
  });
});
