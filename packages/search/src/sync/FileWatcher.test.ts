/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from './FileWatcher.js';
import { SQLiteVectorliteStorage } from '../storage/SQLiteVectorliteStorage.js';

const watch = vi.hoisted(() => vi.fn());
vi.mock('chokidar', () => ({ watch }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'search-watcher-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const storage = new SQLiteVectorliteStorage(
    { backend: 'sqlite', path: '', inMemory: true, backupEnabled: false },
    { type: 'none', useHalfVec: false },
    8,
  );
  await storage.initialize();
  cleanups.push(() => storage.close());
  const source = new EventEmitter();
  Object.assign(source, { close: vi.fn().mockResolvedValue(undefined) });
  watch.mockReturnValue(source);
  const watcher = new FileWatcher(root, storage, { debounceMs: 1 });
  cleanups.push(() => watcher.stop());
  await watcher.start();
  const file = join(root, 'report.txt');
  await writeFile(file, 'evidence');
  return { root, storage, watcher, source, file };
}

describe('file watcher ownership', () => {
  it('requeues completed items without removing published content', async () => {
    const { storage, watcher, source, file } = await fixture();
    const doc = await storage.createDocument({
      filePath: 'report.txt',
      fileName: 'report.txt',
      fileExtension: '.txt',
      fileHash: 'old',
      fileSize: 8,
      fileModifiedAt: new Date(),
      status: 'indexed',
    });
    await storage.createChunks(doc.id, [
      {
        chunkIndex: 0,
        text: 'published evidence',
        startOffset: 0,
        endOffset: 18,
      },
    ]);
    const queued = await storage.enqueueItem({ filePath: 'report.txt' });
    await storage.updateQueueItem(queued.id, { status: 'completed' });
    const flushed = new Promise<void>((resolve) =>
      watcher.once('queue:flushed', () => resolve()),
    );
    source.emit('change', file);
    await flushed;
    expect((await storage.getQueueItemByPath('report.txt'))?.status).toBe(
      'pending',
    );
    expect((await storage.getChunks(doc.id))[0].text).toBe(
      'published evidence',
    );
    expect((await storage.getDocument(doc.id))?.status).toBe('indexed');
  });

  it('joins concurrent starts and drains queued changes before stop resolves', async () => {
    const { storage, watcher, source, file, root } = await fixture();
    await Promise.all([watcher.start(), watcher.start()]);
    const ignored = watch.mock.calls.at(-1)![1].ignored;
    expect(ignored(join(root, 'node_modules', 'report.txt'))).toBe(true);
    expect(ignored(file)).toBe(false);
    source.emit('add', file);
    await Promise.all([watcher.stop(), watcher.stop()]);
    expect((await storage.getQueueItemByPath('report.txt'))?.status).toBe(
      'pending',
    );
    expect(watcher.isWatching()).toBe(false);
  });
});
