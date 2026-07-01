/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Incremental JSONL file tail with a private
 * byte cursor. The core read primitive for transcript-driven providers —
 * Copilot's events.jsonl today; Claude's session transcript and Codex/agy
 * rollouts share the same shape and can migrate later.
 *
 * Guarantees:
 *   - only complete (newline-terminated) lines are parsed; a partial trailing
 *     line is buffered AS BYTES and retried on the next drain (writers append
 *     whole lines but reads can race mid-write — buffering decoded strings
 *     would corrupt a multi-byte UTF-8 character split across reads);
 *   - unparseable lines are skipped silently (metadata formats change
 *     between CLI versions);
 *   - the cursor only moves forward; reset() re-arms at a given offset
 *     (e.g. a pre-turn size snapshot);
 *   - drains are serialised internally, so concurrent callers (a background
 *     watcher tick racing a turn loop) can never interleave reads and
 *     rewind the cursor.
 */

import { promises as fsp } from 'node:fs';

export class JsonlFileTail {
  private cursor = 0;
  private leftover: Buffer = Buffer.alloc(0);
  private lastSize = 0;
  /** Serialises drains — concurrent callers queue behind each other. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly getPath: () => string | undefined) {}

  /** Re-arm the tail at `offset` (defaults to 0). Clears the partial-line buffer. */
  reset(offset = 0): void {
    this.cursor = offset;
    this.leftover = Buffer.alloc(0);
    this.lastSize = offset;
  }

  /** Move the cursor to the file's current end (skip existing content). */
  async seekToEnd(): Promise<void> {
    const path = this.getPath();
    if (!path) {
      this.reset(0);
      return;
    }
    try {
      const stat = await fsp.stat(path);
      this.reset(stat.size);
    } catch {
      this.reset(0);
    }
  }

  get offset(): number {
    return this.cursor;
  }

  /**
   * Read new complete lines since the cursor. Returns parsed entries plus
   * `grew` (file grew this drain — feeds idle clocks) and the current size.
   * Safe to call concurrently — calls are serialised internally.
   */
  drain(): Promise<{ entries: unknown[]; grew: boolean; size: number }> {
    const run = this.chain.then(() => this.drainInner());
    // Keep the chain alive even if a drain rejects (it shouldn't — errors
    // are swallowed inside — but a broken chain would stall the tail).
    this.chain = run.catch(() => {});
    return run;
  }

  private async drainInner(): Promise<{
    entries: unknown[];
    grew: boolean;
    size: number;
  }> {
    const path = this.getPath();
    const none = { entries: [] as unknown[], grew: false, size: this.lastSize };
    if (!path) return none;

    let size: number;
    try {
      const stat = await fsp.stat(path);
      size = stat.size;
    } catch {
      return none;
    }
    const grew = size > this.lastSize;
    if (grew) this.lastSize = size;
    if (size <= this.cursor) return { entries: [], grew, size };

    let chunk: Buffer;
    try {
      const fh = await fsp.open(path, 'r');
      try {
        const len = size - this.cursor;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, this.cursor);
        chunk = buf;
      } finally {
        await fh.close();
      }
    } catch {
      return { entries: [], grew, size };
    }
    this.cursor = size;

    // Work on BYTES until the last newline so a multi-byte UTF-8 character
    // split across reads is never decoded in halves. Scanning for 0x0A on
    // raw bytes is safe: UTF-8 continuation bytes are all >= 0x80.
    const combined = this.leftover.length
      ? Buffer.concat([this.leftover, chunk])
      : chunk;
    const lastNl = combined.lastIndexOf(0x0a);
    if (lastNl < 0) {
      this.leftover = Buffer.from(combined);
      return { entries: [], grew, size };
    }
    this.leftover = Buffer.from(combined.subarray(lastNl + 1));

    const entries: unknown[] = [];
    for (const line of combined
      .subarray(0, lastNl)
      .toString('utf-8')
      .split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        /* skip malformed / mid-write lines */
      }
    }
    return { entries, grew, size };
  }
}
