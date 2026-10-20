/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WorkflowJournal, chainKey, readJournalLines } from './journal.js';

const tempPrefix = path.join(os.tmpdir(), 'wf-journal-recovery-');
const tempDirs: string[] = [];

function journalPath(): string {
  const dir = fs.mkdtempSync(tempPrefix);
  tempDirs.push(dir);
  return path.join(dir, 'journal.jsonl');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (!path.resolve(dir).startsWith(path.resolve(tempPrefix))) {
      throw new Error('Unexpected journal test directory');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('workflow journal crash recovery', () => {
  it('preserves a resumed started record after a torn tail and another interruption', async () => {
    const file = journalPath();
    const firstKey = chainKey('', 'completed work', {});
    const secondKey = chainKey(firstKey, 'interrupted work', {});
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'result',
        key: firstKey,
        agentId: 'a1',
        result: 'preserved',
      }) + '\n{"type":"started","key":',
    );

    const resumed = await WorkflowJournal.open(file);
    await resumed.appendStarted(secondKey, 'a2');
    await resumed.flush();

    // Simulate another process exit before the resumed agent returns.
    const recovered = await WorkflowJournal.open(file);
    expect(recovered.lookup(firstKey)).toEqual({
      kind: 'hit',
      agentId: 'a1',
      result: 'preserved',
    });
    expect(recovered.lookup(secondKey)).toEqual({ kind: 'rerun' });
    expect(recovered.isChainBroken).toBe(false);
    expect(readJournalLines(file).map((line) => line.type)).toEqual([
      'result',
      'started',
    ]);
  });

  it('preserves both a valid unterminated record and the next completed result', async () => {
    const file = journalPath();
    const firstKey = chainKey('', 'first', {});
    const secondKey = chainKey(firstKey, 'second', {});
    fs.writeFileSync(
      file,
      JSON.stringify({
        type: 'result',
        key: firstKey,
        agentId: 'a1',
        result: { source: 'first' },
      }),
    );

    const resumed = await WorkflowJournal.open(file);
    await resumed.appendResult(secondKey, 'a2', { source: 'second' });
    await resumed.flush();

    const recovered = await WorkflowJournal.open(file);
    expect(recovered.lookup(firstKey)).toMatchObject({
      kind: 'hit',
      result: { source: 'first' },
    });
    expect(recovered.lookup(secondKey)).toMatchObject({
      kind: 'hit',
      result: { source: 'second' },
    });
    expect(readJournalLines(file)).toHaveLength(2);
  });
});
