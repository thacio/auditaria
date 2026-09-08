/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  KEY_PREFIX,
  WorkflowJournal,
  canonicalizeOpts,
  chainKey,
  forkChain,
  joinChain,
  newAgentId,
  readJournalLines,
} from './journal.js';

function tmpJournal(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-journal-'));
  return path.join(dir, 'runs', 'wf_x', 'journal.jsonl');
}

describe('chain keys', () => {
  it('are sha256 hex with the scheme prefix and chain through the previous key', () => {
    const k1 = chainKey('', 'p', { model: 'haiku' });
    const k2 = chainKey(k1, 'p', { model: 'haiku' });
    expect(k1).toMatch(new RegExp(`^${KEY_PREFIX}:[0-9a-f]{64}$`));
    expect(k1).not.toBe(k2);
    expect(chainKey('', 'p', { model: 'haiku' })).toBe(k1); // deterministic
  });

  it('ignore label/phase/stallMs but include model/schema/effort/etc.', () => {
    const base = chainKey('', 'p', {
      label: 'a',
      phase: 'X',
      stallMs: 5,
      model: 'haiku',
    });
    expect(chainKey('', 'p', { label: 'b', phase: 'Y', model: 'haiku' })).toBe(
      base,
    );
    expect(chainKey('', 'p', { model: 'sonnet' })).not.toBe(base);
    expect(chainKey('', 'p', { model: 'haiku', effort: 'low' })).not.toBe(base);
    expect(
      chainKey('', 'p', { model: 'haiku', schema: { type: 'object' } }),
    ).not.toBe(base);
    expect(chainKey('', 'p', { model: 'haiku', provider: 'codex' })).not.toBe(
      base,
    );
  });

  it('canonicalize option objects with sorted keys and ordered arrays, dropping functions', () => {
    expect(
      canonicalizeOpts({
        schema: { b: 1, a: [2, 1] },
        model: 'm',
        fn: () => 1,
        label: 'x',
      }),
    ).toBe('{"model":"m","schema":{"a":[2,1],"b":1}}');
    expect(canonicalizeOpts(undefined)).toBe('{}');
    expect(canonicalizeOpts({ disallowedTools: ['b', 'a'] })).not.toBe(
      canonicalizeOpts({ disallowedTools: ['a', 'b'] }),
    );
  });

  it('fork/join are deterministic and distinct per branch', () => {
    const f0 = forkChain('k', 0);
    const f1 = forkChain('k', 1);
    expect(f0).not.toBe(f1);
    expect(forkChain('k', 0)).toBe(f0);
    expect(joinChain('k', 2)).not.toBe(joinChain('k', 3));
    expect(joinChain('k', 2)).not.toBe(f0);
  });

  it('newAgentId is a + 16 hex', () => {
    expect(newAgentId()).toMatch(/^a[0-9a-f]{16}$/);
  });
});

describe('WorkflowJournal', () => {
  it('appends in order with the exact line shapes and reads back', async () => {
    const p = tmpJournal();
    const j = await WorkflowJournal.open(p);
    const k = chainKey('', 'p', {});
    await Promise.all([
      j.appendStarted(k, 'a1'),
      j.appendResult(k, 'a1', { n: 1 }),
      j.appendFailed('k2'),
      j.appendFailed('k3', 'a3'),
    ]);
    await j.flush();
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    expect(lines).toEqual([
      JSON.stringify({ type: 'started', key: k, agentId: 'a1' }),
      JSON.stringify({
        type: 'result',
        key: k,
        agentId: 'a1',
        result: { n: 1 },
      }),
      JSON.stringify({ type: 'failed', key: 'k2' }),
      JSON.stringify({ type: 'failed', key: 'k3', agentId: 'a3' }),
    ]);
    expect(readJournalLines(p)).toHaveLength(4);
  });

  it('fresh journal: first lookup is a miss that breaks the chain', async () => {
    const j = await WorkflowJournal.open(tmpJournal());
    expect(j.lookup('k')).toEqual({ kind: 'miss' });
    expect(j.isChainBroken).toBe(true);
  });

  it('resume: hit / rerun (started only) / miss+broken / failed never hits', async () => {
    const p = tmpJournal();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: 'started', key: 'k1', agentId: 'a1' }),
        JSON.stringify({
          type: 'result',
          key: 'k1',
          agentId: 'a1',
          result: 'R1',
        }),
        JSON.stringify({ type: 'started', key: 'k2', agentId: 'a2' }),
        'this line is torn {',
        JSON.stringify({ type: 'started', key: 'k3', agentId: 'a3' }),
        JSON.stringify({ type: 'failed', key: 'k3', agentId: 'a3' }),
        JSON.stringify({ type: 'started', key: 'k4', agentId: 'a4' }),
        JSON.stringify({
          type: 'result',
          key: 'k4',
          agentId: 'a4',
          result: 'R4',
        }),
        '',
      ].join('\n'),
    );
    const j = await WorkflowJournal.open(p);
    expect(j.priorLineCount).toBe(7);
    expect(j.lookup('k1')).toEqual({
      kind: 'hit',
      agentId: 'a1',
      result: 'R1',
    });
    expect(j.lookup('k2')).toEqual({ kind: 'rerun' });
    expect(j.isChainBroken).toBe(false);
    expect(j.lookup('k3')).toEqual({ kind: 'miss' }); // failed → re-run, chain broken
    expect(j.isChainBroken).toBe(true);
    expect(j.lookup('k4')).toEqual({ kind: 'miss' }); // would have hit, but the chain is broken
  });

  it('a previously killed in-flight call is re-run under the same key with a new agent id', async () => {
    const p = tmpJournal();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ type: 'started', key: 'k1', agentId: 'a1' }) + '\n',
    );
    const j = await WorkflowJournal.open(p);
    expect(j.lookup('k1')).toEqual({ kind: 'rerun' });
    await j.appendStarted('k1', 'a9');
    await j.appendResult('k1', 'a9', 'done');
    const lines = readJournalLines(p);
    expect(lines.map((l) => l.type)).toEqual(['started', 'started', 'result']);
  });
});
