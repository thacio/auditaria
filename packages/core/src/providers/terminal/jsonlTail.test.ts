/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Tests for the incremental JSONL tail —
 * partial-line safety, cursor advancement, and reset semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileTail } from './jsonlTail.js';

describe('JsonlFileTail', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsonl-tail-test-'));
    file = join(dir, 'events.jsonl');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns nothing for a missing file', async () => {
    const tail = new JsonlFileTail(() => file);
    const { entries, grew } = await tail.drain();
    expect(entries).toEqual([]);
    expect(grew).toBe(false);
  });

  it('reads complete lines and advances the cursor', async () => {
    writeFileSync(file, '{"a":1}\n{"a":2}\n');
    const tail = new JsonlFileTail(() => file);
    const first = await tail.drain();
    expect(first.entries).toEqual([{ a: 1 }, { a: 2 }]);
    expect(first.grew).toBe(true);

    const second = await tail.drain();
    expect(second.entries).toEqual([]);
    expect(second.grew).toBe(false);

    appendFileSync(file, '{"a":3}\n');
    const third = await tail.drain();
    expect(third.entries).toEqual([{ a: 3 }]);
    expect(third.grew).toBe(true);
  });

  it('buffers a partial trailing line until its newline arrives', async () => {
    writeFileSync(file, '{"a":1}\n{"a":2');
    const tail = new JsonlFileTail(() => file);
    const first = await tail.drain();
    expect(first.entries).toEqual([{ a: 1 }]);

    appendFileSync(file, ',"b":true}\n');
    const second = await tail.drain();
    expect(second.entries).toEqual([{ a: 2, b: true }]);
  });

  it('skips malformed lines silently', async () => {
    writeFileSync(file, 'not json\n{"ok":1}\n');
    const tail = new JsonlFileTail(() => file);
    const { entries } = await tail.drain();
    expect(entries).toEqual([{ ok: 1 }]);
  });

  it('seekToEnd skips existing content', async () => {
    writeFileSync(file, '{"old":1}\n');
    const tail = new JsonlFileTail(() => file);
    await tail.seekToEnd();
    expect((await tail.drain()).entries).toEqual([]);

    appendFileSync(file, '{"new":2}\n');
    expect((await tail.drain()).entries).toEqual([{ new: 2 }]);
  });

  it('returns nothing when getPath yields undefined (no session yet)', async () => {
    const tail = new JsonlFileTail(() => undefined);
    expect((await tail.drain()).entries).toEqual([]);
  });

  it('does not corrupt a multi-byte UTF-8 character split across drains', async () => {
    // 'ã' = 0xC3 0xA3. Write the line up to and INCLUDING only the first
    // byte of the character, drain, then write the rest.
    const full = Buffer.from('{"t":"conversação"}\n', 'utf-8');
    const splitAt = full.indexOf(0xc3) + 1; // mid-character
    writeFileSync(file, full.subarray(0, splitAt));
    const tail = new JsonlFileTail(() => file);
    expect((await tail.drain()).entries).toEqual([]);

    appendFileSync(file, full.subarray(splitAt));
    const { entries } = await tail.drain();
    expect(entries).toEqual([{ t: 'conversação' }]);
  });

  it('serialises concurrent drains (no cursor rewind, no duplicates)', async () => {
    writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n');
    const tail = new JsonlFileTail(() => file);
    const [a, b] = await Promise.all([tail.drain(), tail.drain()]);
    const combined = [...a.entries, ...b.entries];
    expect(combined).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
