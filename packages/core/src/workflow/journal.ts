/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The resume journal.
//
// Line shapes are identical to Claude Code's `journal.jsonl` (research 10 §7):
//   {"type":"started","key":"aw1:<hex>","agentId":"a<hex>"}
//   {"type":"result","key":"aw1:<hex>","agentId":"a<hex>","result":<json>}
//   {"type":"failed","key":"aw1:<hex>","agentId"?:"a<hex>"}
//
// Keys are hash-chained (research 02 §2.3): key_n = sha256(key_{n-1} \0 prompt
// \0 canonicalOpts). An edit to any earlier call therefore changes every later
// key ("longest unchanged prefix" replay falls out of the chain). Auditaria
// additionally forks a deterministic sub-chain per parallel()/pipeline()
// branch so keys never depend on async completion order (refute-resume.md).

import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { JournalLine } from './types.js';
import { errnoCode, isRecord, stringField } from './guards.js';

export const KEY_PREFIX = 'aw1';

/** Only these agent() option fields participate in the cache key (label/phase never do). */
export const KEYED_OPTS_FIELDS = [
  'schema',
  'model',
  'effort',
  'isolation',
  'agentType',
  'disallowedTools',
  'bashCommandClamp',
  'provider',
] as const;

function canonicalize(value: unknown): unknown {
  if (typeof value === 'function') return undefined;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__') continue;
      const v = canonicalize(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return value;
}

/** Stable JSON of the key-relevant option fields (sorted keys, ordered arrays). */
export function canonicalizeOpts(opts: unknown): string {
  if (!isRecord(opts)) return '{}';
  const picked: Record<string, unknown> = {};
  for (const field of KEYED_OPTS_FIELDS) {
    const v = opts[field];
    if (v === undefined || typeof v === 'function') continue;
    picked[field] = v;
  }
  return JSON.stringify(canonicalize(picked));
}

function digest(...parts: string[]): string {
  const h = createHash('sha256');
  parts.forEach((p, i) => {
    if (i > 0) h.update('\0');
    h.update(p);
  });
  return `${KEY_PREFIX}:${h.digest('hex')}`;
}

/** The key of an agent() call given the chain state before it. */
export function chainKey(prev: string, prompt: string, opts: unknown): string {
  return digest(prev, prompt, canonicalizeOpts(opts));
}

/** Deterministic seed for branch `index` of a parallel()/pipeline() forked at `prev`. */
export function forkChain(prev: string, index: number): string {
  return digest(prev, 'branch', String(index));
}

/** Chain state after a fork of `count` branches settles. */
export function joinChain(prev: string, count: number): string {
  return digest(prev, 'join', String(count));
}

/** Generate a Claude-shaped agent id: 'a' + 16 hex characters. */
export function newAgentId(): string {
  return 'a' + randomBytes(8).toString('hex');
}

export type JournalLookup =
  | { kind: 'hit'; agentId: string; result: unknown }
  | { kind: 'rerun' }
  | { kind: 'miss' };

/**
 * Append-only JSONL journal for one run. Loading indexes prior lines so a
 * resumed run can answer "cached / interrupted / new" for each key.
 */
export class WorkflowJournal {
  private readonly results = new Map<
    string,
    { agentId: string; result: unknown }
  >();
  private readonly started = new Map<string, string[]>();
  private readonly failed = new Set<string>();
  /** Once a key is genuinely new (or previously failed), no later lookup may hit. */
  private chainBroken = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private lineCount = 0;

  private constructor(readonly path: string) {}

  /** Open (creating the parent directory) and index any existing lines. */
  static async open(path: string): Promise<WorkflowJournal> {
    const journal = new WorkflowJournal(path);
    await fsp.mkdir(dirnameOf(path), { recursive: true });
    let text = '';
    try {
      text = await fsp.readFile(path, 'utf8');
    } catch (e) {
      if (errnoCode(e) !== 'ENOENT') throw e;
    }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a torn line from an ungraceful kill is skipped, never fatal
      }
      journal.index(parsed);
    }
    return journal;
  }

  /** Number of lines indexed from disk (for tests and diagnostics). */
  get priorLineCount(): number {
    return this.lineCount;
  }

  private index(parsed: unknown): void {
    const line = toJournalLine(parsed);
    if (!line) return;
    this.lineCount++;
    switch (line.type) {
      case 'started': {
        const list = this.started.get(line.key) ?? [];
        list.push(line.agentId);
        this.started.set(line.key, list);
        return;
      }
      case 'result':
        this.results.set(line.key, {
          agentId: line.agentId,
          result: line.result,
        });
        return;
      case 'failed':
        this.failed.add(line.key);
        return;
      default:
        return;
    }
  }

  /**
   * Resume decision for a key (Claude Code's `c` flag semantics, research 02
   * §2.4): a hit serves the cached result; a key that was started but never
   * settled is re-run without breaking the chain; anything else breaks the
   * chain so no later call can hit a stale entry.
   */
  lookup(key: string): JournalLookup {
    if (this.chainBroken) return { kind: 'miss' };
    const hit = this.results.get(key);
    if (hit) return { kind: 'hit', agentId: hit.agentId, result: hit.result };
    const started = this.started.get(key);
    if (started && started.length > 0 && !this.failed.has(key)) {
      return { kind: 'rerun' };
    }
    this.chainBroken = true;
    return { kind: 'miss' };
  }

  get isChainBroken(): boolean {
    return this.chainBroken;
  }

  appendStarted(key: string, agentId: string): Promise<void> {
    return this.append({ type: 'started', key, agentId });
  }

  appendResult(key: string, agentId: string, result: unknown): Promise<void> {
    return this.append({ type: 'result', key, agentId, result });
  }

  appendFailed(key: string, agentId?: string): Promise<void> {
    return this.append(
      agentId ? { type: 'failed', key, agentId } : { type: 'failed', key },
    );
  }

  /** Wait for every queued append to reach disk. */
  flush(): Promise<void> {
    return this.writeQueue;
  }

  private append(line: JournalLine): Promise<void> {
    const text = JSON.stringify(line) + '\n';
    const write = async () => {
      const handle = await fsp.open(this.path, 'a');
      try {
        await handle.write(text, null, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    // One serialized queue per run: concurrent parallel() members can never
    // interleave mid-line, and a failed write never blocks later ones.
    const next = this.writeQueue.then(write, write);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

/** Narrow one parsed JSON value to a journal line (unknown shapes are dropped). */
export function toJournalLine(parsed: unknown): JournalLine | undefined {
  if (!isRecord(parsed)) return undefined;
  const key = stringField(parsed, 'key');
  const type = stringField(parsed, 'type');
  if (key === undefined) return undefined;
  const agentId = stringField(parsed, 'agentId') ?? '';
  switch (type) {
    case 'started':
      return { type, key, agentId };
    case 'result':
      return { type, key, agentId, result: parsed['result'] };
    case 'failed':
      return agentId ? { type, key, agentId } : { type, key };
    default:
      return undefined;
  }
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

/** Read every line of a journal file (for /workflows and diagnostics). */
export function readJournalLines(path: string): JournalLine[] {
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: JournalLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = toJournalLine(JSON.parse(line));
      if (parsed) out.push(parsed);
    } catch {
      /* skip torn line */
    }
  }
  return out;
}
