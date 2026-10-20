/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchSystem } from './SearchSystem.js';
import { MockEmbedder } from '../embedders/TransformersJsEmbedder.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'search-system-lifecycle-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const system = await SearchSystem.initialize({
    rootPath: root,
    useMockEmbedder: true,
    config: {
      database: { backend: 'sqlite', inMemory: false, backupEnabled: false },
      vectorIndex: { type: 'none' },
      indexing: { useChildProcess: false },
      ocr: { enabled: false },
    },
  });
  cleanups.push(() => system.close());
  await writeFile(
    join(root, 'report.txt'),
    'Audit evidence for procurement controls.',
  );
  return { system, root };
}

describe('SearchSystem operation ownership', () => {
  it('owns direct indexing and can stop background processing before it starts', async () => {
    const { system } = await fixture();
    const direct = system.indexFile('report.txt');
    await expect(system.indexAll()).rejects.toThrow('already in progress');
    expect(await direct).toBe(true);
    await system.queueFiles(['report.txt']);
    system.startProcessing();
    await system.stopProcessing();
    expect(system.isProcessingIdle()).toBe(true);
    expect((await system.getQueueStatus()).pending).toBe(1);
    expect((await system.processQueue()).indexed).toBe(1);
  });

  it('indexes, searches, updates and removes the final file in a persistent index', async () => {
    const { system, root } = await fixture();
    expect((await system.indexAll()).indexed).toBe(1);
    expect(await system.searchKeyword('procurement')).toHaveLength(1);
    expect(
      (await system.search({ query: 'procurement', strategy: 'hybrid' }))
        .results,
    ).toHaveLength(1);
    await system.addTags('report.txt', ['reviewed']);
    await writeFile(
      join(root, 'report.txt'),
      'Revised audit evidence for payroll controls.',
    );
    expect((await system.indexAll()).indexed).toBe(1);
    expect(await system.searchKeyword('procurement')).toHaveLength(0);
    expect(await system.searchKeyword('payroll')).toHaveLength(1);
    expect(await system.getFileTags('report.txt')).toEqual(['reviewed']);
    await rm(join(root, 'report.txt'));
    await system.indexAll();
    expect((await system.getStats()).totalDocuments).toBe(0);
    expect(await system.searchKeyword('payroll')).toHaveLength(0);
  });

  it('rejects competing runs and joins shutdown without disposing a shared model twice', async () => {
    const { system } = await fixture();
    const dispose = vi.spyOn(MockEmbedder.prototype, 'dispose');
    const indexing = system.indexAll();
    await expect(system.processQueue()).rejects.toThrow('already in progress');
    const first = system.close();
    const second = system.close();
    expect(second).toBe(first);
    await Promise.all([indexing, first, second]);
    expect(dispose).toHaveBeenCalledTimes(1);
    await expect(system.searchKeyword('audit')).rejects.toThrow();
  });
});
