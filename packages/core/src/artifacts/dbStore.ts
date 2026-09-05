/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { EventEmitter } from 'node:events';
import {
  DbError,
  MAX_DOCUMENTS,
  clampLeaseTtl,
  collectionOf,
  evaluateQuery,
  mergeBodies,
  parseCollectionPath,
  parseDocPath,
  validateBody,
  type Body,
  type QuerySpec,
  type StoredDoc,
} from './dbEngine.js';
import { appendJsonl, readJsonl, replaceFile } from './journal.js';

/** One line of `db.jsonl`. `update` is journaled as the merged `set`. */
export type DbJournalLine =
  | {
      readonly op: 'set';
      readonly path: string;
      readonly data: Body;
      readonly version: number;
      readonly at: string;
    }
  | { readonly op: 'delete'; readonly path: string; readonly at: string }
  | {
      readonly op: 'batch';
      readonly writes: ReadonlyArray<
        | {
            readonly op: 'set';
            readonly path: string;
            readonly data: Body;
            readonly version: number;
          }
        | { readonly op: 'delete'; readonly path: string }
      >;
      readonly at: string;
    };

export type BatchWrite =
  | { readonly op: 'set'; readonly path: string; readonly data: unknown }
  | { readonly op: 'update'; readonly path: string; readonly data: unknown }
  | { readonly op: 'delete'; readonly path: string };

export interface AcquireOptions {
  readonly holder: string;
  readonly ttlMs?: number;
  readonly data?: unknown;
}

export interface AcquireResult {
  readonly acquired: boolean;
  readonly version?: number;
  readonly expiresAt?: string;
  readonly holder?: string;
}

export interface ArtifactDbEvents {
  /** Paths whose documents changed in one commit. */
  change: [paths: string[]];
}

/** Journal lines above which the store rewrites itself as a snapshot. */
const COMPACT_MIN_LINES = 1000;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * The document store of ONE artifact: an in-memory map replayed from an
 * append-only journal, every mutation journaled before it is visible.
 * A batch is one journal line, so it is all-or-nothing on disk as well
 * as in memory. Leases live in memory only — they are cooperative and
 * expire within minutes. Viewer visibility (rules, `{self}`) is the
 * caller's business: the store itself sees everything.
 */
export class ArtifactDb extends EventEmitter<ArtifactDbEvents> {
  private readonly docs = new Map<string, StoredDoc>();
  private readonly leases = new Map<
    string,
    { holder: string; expiresAt: number }
  >();
  private loaded: Promise<void> | null = null;

  constructor(readonly file: string) {
    super();
  }

  async load(): Promise<void> {
    this.loaded ??= this.replay();
    return this.loaded;
  }

  private async replay(): Promise<void> {
    const lines = await readJsonl<DbJournalLine>(this.file);
    for (const line of lines) this.applyLine(line);
    if (lines.length > COMPACT_MIN_LINES && lines.length > this.docs.size * 4) {
      await this.compact();
    }
  }

  private applyLine(line: DbJournalLine): void {
    switch (line.op) {
      case 'set':
        this.docs.set(line.path, {
          path: line.path,
          data: line.data,
          version: line.version,
          updatedAt: line.at,
        });
        break;
      case 'delete':
        this.docs.delete(line.path);
        break;
      case 'batch':
        for (const write of line.writes) {
          if (write.op === 'set') {
            this.docs.set(write.path, {
              path: write.path,
              data: write.data,
              version: write.version,
              updatedAt: line.at,
            });
          } else {
            this.docs.delete(write.path);
          }
        }
        break;
      default:
        break;
    }
  }

  /** Rewrites the journal as one `set` line per live document. */
  async compact(): Promise<void> {
    const at = nowIso();
    const lines = Array.from(this.docs.values()).map((doc) =>
      JSON.stringify({
        op: 'set',
        path: doc.path,
        data: doc.data,
        version: doc.version,
        at: doc.updatedAt || at,
      } satisfies DbJournalLine),
    );
    await replaceFile(this.file, lines.length ? `${lines.join('\n')}\n` : '');
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  get size(): number {
    return this.docs.size;
  }

  get(path: string): StoredDoc | null {
    parseDocPath(path);
    return this.docs.get(path) ?? null;
  }

  /** The direct children of a collection, in insertion order. */
  list(collectionPath: string): StoredDoc[] {
    parseCollectionPath(collectionPath);
    const out: StoredDoc[] = [];
    for (const doc of this.docs.values()) {
      if (collectionOf(doc.path) === collectionPath) out.push(doc);
    }
    return out;
  }

  /** The full ordered match of a query (limit applied by the caller). */
  query(spec: QuerySpec): StoredDoc[] {
    return evaluateQuery(spec, this.list(spec.path));
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  async set(path: string, data: unknown): Promise<StoredDoc> {
    parseDocPath(path);
    const body = validateBody(data);
    const existing = this.docs.get(path);
    if (!existing) this.assertCapacity();
    const doc: StoredDoc = {
      path,
      data: body,
      version: (existing?.version ?? 0) + 1,
      updatedAt: nowIso(),
    };
    await this.commit(
      { op: 'set', path, data: body, version: doc.version, at: doc.updatedAt },
      [doc],
      [],
    );
    return doc;
  }

  /** Merge into an EXISTING document; rejects when absent. */
  async update(path: string, patch: unknown): Promise<StoredDoc> {
    parseDocPath(path);
    const existing = this.docs.get(path);
    if (!existing) {
      throw new DbError(
        'invalid_argument',
        `update requires an existing document; "${path}" does not exist (use set to create it)`,
      );
    }
    const body = validateBody(mergeBodies(existing.data, validateBody(patch)));
    const doc: StoredDoc = {
      path,
      data: body,
      version: existing.version + 1,
      updatedAt: nowIso(),
    };
    await this.commit(
      { op: 'set', path, data: body, version: doc.version, at: doc.updatedAt },
      [doc],
      [],
    );
    return doc;
  }

  /** Idempotent; documents nested under the path survive. */
  async delete(path: string): Promise<boolean> {
    parseDocPath(path);
    if (!this.docs.has(path)) return false;
    await this.commit({ op: 'delete', path, at: nowIso() }, [], [path]);
    return true;
  }

  /**
   * Applies up to 50 writes all-or-nothing: every write is validated
   * against the state BEFORE the batch, then all land in one journal
   * line. Each document may be addressed once.
   */
  async batch(writes: readonly BatchWrite[]): Promise<StoredDoc[]> {
    if (writes.length === 0 || writes.length > 50) {
      throw new DbError('invalid_argument', 'a batch holds 1-50 writes');
    }
    const seen = new Set<string>();
    const sets: StoredDoc[] = [];
    const deletes: string[] = [];
    let creates = 0;
    const at = nowIso();
    for (const write of writes) {
      parseDocPath(write.path);
      if (seen.has(write.path)) {
        throw new DbError(
          'invalid_argument',
          `a batch may address each document once ("${write.path}" appears twice)`,
        );
      }
      seen.add(write.path);
      const existing = this.docs.get(write.path);
      if (write.op === 'delete') {
        if (existing) deletes.push(write.path);
        continue;
      }
      if (write.op === 'update' && !existing) {
        throw new DbError(
          'invalid_argument',
          `update requires an existing document; "${write.path}" does not exist`,
        );
      }
      const body =
        write.op === 'update' && existing
          ? validateBody(mergeBodies(existing.data, validateBody(write.data)))
          : validateBody(write.data);
      if (!existing) creates++;
      sets.push({
        path: write.path,
        data: body,
        version: (existing?.version ?? 0) + 1,
        updatedAt: at,
      });
    }
    if (this.docs.size + creates > MAX_DOCUMENTS) {
      throw new DbError(
        'quota_exceeded',
        `this artifact's database holds at most ${MAX_DOCUMENTS} documents`,
      );
    }
    await this.commit(
      {
        op: 'batch',
        at,
        writes: [
          ...sets.map((d) => ({
            op: 'set' as const,
            path: d.path,
            data: d.data,
            version: d.version,
          })),
          ...deletes.map((path) => ({ op: 'delete' as const, path })),
        ],
      },
      sets,
      deletes,
    );
    return sets;
  }

  /**
   * Cooperative lease: granted when free, expired, or held by the same
   * holder (renewal). Busy is a normal `{acquired: false}`. A grant
   * merges `data` into the document (creating it when absent) and bumps
   * its version.
   */
  async acquire(path: string, options: AcquireOptions): Promise<AcquireResult> {
    parseDocPath(path);
    if (typeof options?.holder !== 'string' || !options.holder) {
      throw new DbError('invalid_argument', 'acquire needs a holder string');
    }
    const now = Date.now();
    const current = this.leases.get(path);
    if (
      current &&
      current.expiresAt > now &&
      current.holder !== options.holder
    ) {
      return {
        acquired: false,
        expiresAt: new Date(current.expiresAt).toISOString(),
      };
    }
    const expiresAt = now + clampLeaseTtl(options.ttlMs);
    this.leases.set(path, { holder: options.holder, expiresAt });
    const existing = this.docs.get(path);
    const patch = options.data === undefined ? {} : validateBody(options.data);
    if (!existing) this.assertCapacity();
    const body = validateBody(mergeBodies(existing?.data ?? {}, patch));
    const doc: StoredDoc = {
      path,
      data: body,
      version: (existing?.version ?? 0) + 1,
      updatedAt: nowIso(),
    };
    await this.commit(
      { op: 'set', path, data: body, version: doc.version, at: doc.updatedAt },
      [doc],
      [],
    );
    return {
      acquired: true,
      version: doc.version,
      expiresAt: new Date(expiresAt).toISOString(),
      holder: options.holder,
    };
  }

  private assertCapacity(): void {
    if (this.docs.size >= MAX_DOCUMENTS) {
      throw new DbError(
        'quota_exceeded',
        `this artifact's database holds at most ${MAX_DOCUMENTS} documents; delete some before creating more (writes to existing documents still succeed)`,
      );
    }
  }

  /** Journal first, then memory, then listeners. */
  private async commit(
    line: DbJournalLine,
    sets: readonly StoredDoc[],
    deletes: readonly string[],
  ): Promise<void> {
    await appendJsonl(this.file, line);
    for (const doc of sets) this.docs.set(doc.path, doc);
    for (const path of deletes) this.docs.delete(path);
    const changed = [...sets.map((d) => d.path), ...deletes];
    if (changed.length) this.emit('change', changed);
  }
}
