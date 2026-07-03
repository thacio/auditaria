/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Durable JSONL stores for the custody chain (§5.2):
//
//   sender disk spool ──(relay acks receipt)──▶ relay disk queue
//     ──(receiver acks AFTER local fsync)──▶ receiver disk inbox
//     ──(model turn consumes / hive_check drains)──▶ processed
//
// Deliberately NOT Maildir: atomic renames are the documented
// Windows-antivirus failure mode (cc2cc field notes). Everything here is
// append-only JSONL + fsync; compaction happens by truncate-and-reappend at
// load time (no renames anywhere).

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Best-effort owner-only permissions; a no-op on Windows ACL semantics. */
const FILE_MODE = 0o600;

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

interface EnqLine<T> {
  op: 'enq';
  seq: number;
  v: T;
}

interface AckLine {
  op: 'ack';
  seq: number;
}

type QueueLine<T> = EnqLine<T> | AckLine;

/**
 * Append-only persisted FIFO queue keyed by a local monotonic sequence.
 * Used for: relay per-peer queues, the node inbox, and the sender outbox
 * spool. Entries survive restarts until explicitly acked.
 */
export class JsonlQueueStore<T> {
  private pending = new Map<number, T>();
  private nextSeq = 1;
  private fd: number | undefined;

  constructor(private readonly filePath: string) {}

  /** Load persisted state, then compact the file down to pending entries. */
  load(): void {
    ensureDir(this.filePath);
    if (fs.existsSync(this.filePath)) {
      let raw = '';
      try {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      } catch {
        raw = '';
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const parsed = JSON.parse(trimmed) as QueueLine<T>;
          if (parsed.op === 'enq') {
            this.pending.set(parsed.seq, parsed.v);
            if (parsed.seq >= this.nextSeq) this.nextSeq = parsed.seq + 1;
          } else if (parsed.op === 'ack') {
            this.pending.delete(parsed.seq);
            if (parsed.seq >= this.nextSeq) this.nextSeq = parsed.seq + 1;
          }
        } catch {
          // Torn tail line from a crash mid-append — ignore; the entry was
          // never acked upstream, so at-least-once redelivery covers it.
        }
      }
    }
    this.compact();
  }

  /** Rewrite the file with only pending entries. Truncate + append, no renames. */
  private compact(): void {
    this.closeFd();
    ensureDir(this.filePath);
    const lines = [...this.pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seq, v]) => JSON.stringify({ op: 'enq', seq, v }) + '\n')
      .join('');
    fs.writeFileSync(this.filePath, lines, {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
    this.fd = fs.openSync(this.filePath, 'a', FILE_MODE);
  }

  private ensureFd(): number {
    if (this.fd === undefined) {
      ensureDir(this.filePath);
      this.fd = fs.openSync(this.filePath, 'a', FILE_MODE);
    }
    return this.fd;
  }

  private appendLine(line: object, fsync: boolean): void {
    const fd = this.ensureFd();
    fs.writeSync(fd, JSON.stringify(line) + '\n');
    if (fsync) {
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync can fail on exotic filesystems; the append itself succeeded.
      }
    }
  }

  /**
   * Durably persist an entry. Returns its sequence number.
   * fsyncs by default — callers on the custody chain must not ack upstream
   * before this returns.
   */
  enqueue(value: T, fsync = true): number {
    const seq = this.nextSeq++;
    this.pending.set(seq, value);
    this.appendLine({ op: 'enq', seq, v: value }, fsync);
    return seq;
  }

  /**
   * Remove an entry. The ack line is appended without fsync — losing it on a
   * crash only causes a redelivery, which dedup absorbs.
   */
  ack(seq: number): void {
    if (!this.pending.delete(seq)) return;
    this.appendLine({ op: 'ack', seq }, false);
  }

  get size(): number {
    return this.pending.size;
  }

  /** Entries in sequence order. */
  entries(): Array<{ seq: number; value: T }> {
    return [...this.pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seq, value]) => ({ seq, value }));
  }

  peek(): { seq: number; value: T } | undefined {
    return this.entries()[0];
  }

  get(seq: number): T | undefined {
    return this.pending.get(seq);
  }

  private closeFd(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = undefined;
    }
  }

  dispose(): void {
    this.closeFd();
  }
}

interface SeenLine {
  id: string;
  ts: number;
}

/**
 * Persisted seen-ULID set for at-least-once dedup. Retention MUST outlive the
 * maximum message TTL (+ slack): with a shorter window, a late duplicate of
 * an already-processed message could be accepted again as if new (§5.2).
 */
export class SeenStore {
  private seen = new Map<string, number>();
  private fd: number | undefined;

  constructor(
    private readonly filePath: string,
    private readonly retentionMs: number,
  ) {}

  load(now = Date.now()): void {
    ensureDir(this.filePath);
    if (fs.existsSync(this.filePath)) {
      let raw = '';
      try {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      } catch {
        raw = '';
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const parsed = JSON.parse(trimmed) as SeenLine;
          if (now - parsed.ts <= this.retentionMs) {
            this.seen.set(parsed.id, parsed.ts);
          }
        } catch {
          // Torn tail line — safe to drop (worst case one extra redelivery
          // is deduped by the inbox's own pending check).
        }
      }
    }
    this.compact();
  }

  private compact(): void {
    this.closeFd();
    ensureDir(this.filePath);
    const lines = [...this.seen.entries()]
      .map(([id, ts]) => JSON.stringify({ id, ts }) + '\n')
      .join('');
    fs.writeFileSync(this.filePath, lines, {
      encoding: 'utf-8',
      mode: FILE_MODE,
    });
    this.fd = fs.openSync(this.filePath, 'a', FILE_MODE);
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  /** Durably record an id. fsynced: must happen before the delivered-ack. */
  add(id: string, now = Date.now()): void {
    if (this.seen.has(id)) return;
    this.seen.set(id, now);
    if (this.fd === undefined) {
      ensureDir(this.filePath);
      this.fd = fs.openSync(this.filePath, 'a', FILE_MODE);
    }
    fs.writeSync(this.fd, JSON.stringify({ id, ts: now }) + '\n');
    try {
      fs.fsyncSync(this.fd);
    } catch {
      /* fsync best-effort; the append itself succeeded */
    }
  }

  get size(): number {
    return this.seen.size;
  }

  private closeFd(): void {
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = undefined;
    }
  }

  dispose(): void {
    this.closeFd();
  }
}

// -------------------------------------------------------------------
// Small JSON config helpers (0600-equivalent best effort)
// -------------------------------------------------------------------

export function readJsonFile<T>(filePath: string): T | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), {
    encoding: 'utf-8',
    mode: FILE_MODE,
  });
}
