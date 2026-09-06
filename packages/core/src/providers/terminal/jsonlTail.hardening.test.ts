/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: JsonlFileTail fences — truncation, replacement
 * and a path switch re-arm the tail instead of reading from a stale offset.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileTail } from './jsonlTail.js';

const line = (n: number) => JSON.stringify({ n }) + '\n';

describe('JsonlFileTail hardening', () => {
  it('re-reads from the start after the file is truncated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'));
    try {
      const path = join(dir, 'a.jsonl');
      writeFileSync(path, line(1) + line(2));
      const tail = new JsonlFileTail(() => path);
      tail.reset(0);
      expect((await tail.drain()).entries).toEqual([{ n: 1 }, { n: 2 }]);
      writeFileSync(path, line(9)); // truncated + rewritten (shorter)
      expect((await tail.drain()).entries).toEqual([{ n: 9 }]);
      appendFileSync(path, line(10));
      expect((await tail.drain()).entries).toEqual([{ n: 10 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows a path switch (native /clear) from offset 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jsonl-tail-'));
    try {
      let current = join(dir, 'one.jsonl');
      writeFileSync(current, line(1));
      const tail = new JsonlFileTail(() => current);
      tail.reset(0);
      expect((await tail.drain()).entries).toEqual([{ n: 1 }]);
      current = join(dir, 'two.jsonl');
      writeFileSync(current, line(2));
      expect((await tail.drain()).entries).toEqual([{ n: 2 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
