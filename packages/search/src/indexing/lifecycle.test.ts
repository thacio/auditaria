/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexingPipeline } from './IndexingPipeline.js';
import { ParserRegistry } from '../parsers/ParserRegistry.js';
import { PlainTextParser } from '../parsers/PlainTextParser.js';
import { ChunkerRegistry } from '../chunkers/ChunkerRegistry.js';
import { RecursiveChunker } from '../chunkers/RecursiveChunker.js';
import { MockEmbedder } from '../embedders/TransformersJsEmbedder.js';
import { SQLiteVectorliteStorage } from '../storage/SQLiteVectorliteStorage.js';
import { FileDiscovery } from '../discovery/FileDiscovery.js';
import { StartupSync } from '../sync/StartupSync.js';
import type { IndexingPipelineOptions } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(options: Partial<IndexingPipelineOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'search-lifecycle-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const storage = new SQLiteVectorliteStorage(
    {
      backend: 'sqlite',
      path: '',
      inMemory: true,
      backupEnabled: false,
    },
    { type: 'none', useHalfVec: false },
    8,
  );
  await storage.initialize();
  cleanups.push(() => storage.close());
  const parser = new PlainTextParser();
  const parsers = new ParserRegistry();
  parsers.register(parser);
  const chunkers = new ChunkerRegistry();
  chunkers.register(new RecursiveChunker());
  const embedder = new MockEmbedder(8);
  await embedder.initialize();
  cleanups.push(() => embedder.dispose());
  const pipeline = new IndexingPipeline(storage, parsers, chunkers, embedder, {
    rootPath: root,
    autoStart: false,
    retryDelay: 0,
    prepareWorkers: 2,
    preparedBufferSize: 2,
    ...options,
  });
  cleanups.push(() => pipeline.stop());
  await writeFile(join(root, 'report.txt'), 'Original audit evidence.');
  return { root, storage, pipeline, parser, embedder, parsers };
}

describe('indexing lifecycle and consistency', () => {
  it('completes maintenance without waiting on its own preparation batch', async () => {
    const { root, pipeline, storage } = await fixture();
    const files = Array.from({ length: 202 }, (_, i) => `batch-${i}.txt`);
    await Promise.all(
      files.map((file) => writeFile(join(root, file), 'Audit evidence.')),
    );
    const checkpoint = vi.spyOn(storage, 'checkpoint');
    await pipeline.queueFiles(files);
    pipeline.start();
    await pipeline.waitForIdle();
    expect((await storage.getQueueStatus()).completed).toBe(202);
    expect(checkpoint).toHaveBeenCalledTimes(2);
  });

  it('does not lose auto-start work queued during the final empty dequeue', async () => {
    const { pipeline, storage } = await fixture({ autoStart: true });
    const entered = deferred();
    const release = deferred();
    vi.spyOn(storage, 'dequeueItem').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return null;
    });
    pipeline.start();
    await entered.promise;
    const queued = pipeline.queueFile('report.txt');
    release.resolve();
    await queued;
    await pipeline.waitForIdle();
    expect((await storage.getDocumentByPath('report.txt'))?.status).toBe(
      'indexed',
    );
  });

  it('detects same-size edits even when the modification time is unchanged', async () => {
    const { root, pipeline, storage } = await fixture();
    await pipeline.processFile('report.txt');
    const file = join(root, 'report.txt');
    const before = await stat(file);
    await writeFile(file, 'Modified audit evidence.');
    await utimes(file, before.atime, before.mtime);
    expect((await pipeline.sync()).modified).toEqual(['report.txt']);
    const doc = await storage.getDocumentByPath('report.txt');
    await storage.addTags(doc!.id, ['reviewed']);
    expect((await pipeline.processFile(file)).success).toBe(true);
    expect((await pipeline.sync()).modified).toEqual([]);
    expect(await storage.getDocumentTags(doc!.id)).toEqual(['reviewed']);
    expect((await storage.getChunks(doc!.id))[0].text).toContain('Modified');
  });

  it('keeps previous passages when replacement inference fails', async () => {
    const { root, pipeline, storage, embedder } = await fixture();
    await pipeline.processFile('report.txt');
    const doc = (await storage.getDocumentByPath('report.txt'))!;
    const chunks = await storage.getChunks(doc.id);
    await writeFile(join(root, 'report.txt'), 'Replacement evidence.');
    vi.spyOn(embedder, 'embedBatchDocumentsStreaming').mockImplementation(
      async function* () {
        yield {
          startIndex: 0,
          embeddings: await Promise.reject(new Error('inference failed')),
        };
      },
    );
    expect((await pipeline.processFile('report.txt')).success).toBe(false);
    expect(await storage.getChunks(doc.id)).toEqual(chunks);
    expect((await storage.getDocument(doc.id))!.fileHash).toBe(doc.fileHash);
    expect((await storage.getDocument(doc.id))!.status).toBe('indexed');
  });

  it('does not publish passages if the file changes during inference', async () => {
    const { root, pipeline, storage, embedder } = await fixture();
    await pipeline.processFile('report.txt');
    const doc = (await storage.getDocumentByPath('report.txt'))!;
    const chunks = await storage.getChunks(doc.id);
    const embed = embedder.embedBatchDocumentsStreaming.bind(embedder);
    vi.spyOn(embedder, 'embedBatchDocumentsStreaming').mockImplementation(
      async function* (...args) {
        await writeFile(join(root, 'report.txt'), 'Edited during inference.');
        yield* embed(...args);
      },
    );
    expect((await pipeline.processFile('report.txt')).success).toBe(false);
    expect(await storage.getChunks(doc.id)).toEqual(chunks);
    expect((await pipeline.sync()).modified).toEqual(['report.txt']);
  });

  it('joins concurrent stops and returns unfinished claims to the queue', async () => {
    const { pipeline, parsers, storage } = await fixture();
    const entered = deferred();
    const release = deferred();
    const parse = parsers.parse.bind(parsers);
    vi.spyOn(parsers, 'parse').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return parse(...args);
    });
    await pipeline.queueFile('report.txt');
    pipeline.start();
    await entered.promise;
    let stopped = false;
    const first = pipeline.stop().then(() => {
      stopped = true;
    });
    const second = pipeline.stop();
    pipeline.start(); // Cannot start a second run while stopping.
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect(pipeline.getState()).toBe('idle');
    expect((await storage.getQueueItemByPath('report.txt'))!.status).toBe(
      'pending',
    );
    pipeline.start();
    await pipeline.waitForIdle();
    expect((await storage.getQueueItemByPath('report.txt'))!.status).toBe(
      'completed',
    );
  });

  it('counts each failed attempt once, including embedding failures', async () => {
    const { pipeline, storage, embedder } = await fixture({ maxRetries: 3 });
    const inference = vi
      .spyOn(embedder, 'embedBatchDocumentsStreaming')
      .mockImplementation(async function* () {
        yield {
          startIndex: 0,
          embeddings: await Promise.reject(new Error('unavailable')),
        };
      });
    const failed = vi.fn();
    pipeline.on('document:failed', failed);
    await pipeline.queueFile('report.txt');
    pipeline.start();
    await pipeline.waitForIdle();
    expect(inference).toHaveBeenCalledTimes(3);
    expect((await storage.getQueueItemByPath('report.txt'))!.attempts).toBe(3);
    expect((await storage.getDocumentByPath('report.txt'))!.status).toBe(
      'failed',
    );
    expect(failed).toHaveBeenCalledOnce();
  });

  it('surfaces queue failures and settles the run without detached rejections', async () => {
    const { pipeline, storage } = await fixture();
    vi.spyOn(storage, 'dequeueItem').mockRejectedValueOnce(
      new Error('database offline'),
    );
    const stopped = vi.fn();
    pipeline.on('pipeline:stopped', stopped);
    pipeline.start();
    await expect(pipeline.waitForIdle()).rejects.toThrow('database offline');
    expect(pipeline.getState()).toBe('idle');
    expect(stopped).toHaveBeenCalledOnce();
    await pipeline.queueFile('report.txt');
    pipeline.start();
    await pipeline.waitForIdle();
    expect((await storage.getQueueItemByPath('report.txt'))!.status).toBe(
      'completed',
    );
  });

  it('rejects incomplete vectors before publishing replacement chunks', async () => {
    const { pipeline, embedder, storage } = await fixture();
    vi.spyOn(embedder, 'embedBatchDocumentsStreaming').mockImplementation(
      async function* () {
        yield { startIndex: 0, embeddings: [] };
      },
    );
    const result = await pipeline.processFile('report.txt');
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/invalid streaming batch/);
    expect(await storage.countChunks()).toBe(0);
  });

  it('serializes simultaneous direct requests for the same document', async () => {
    const { pipeline, storage, root } = await fixture();
    const results = await Promise.all([
      pipeline.processFile('report.txt'),
      pipeline.processFile(join(root, 'report.txt')),
    ]);
    expect(results.every((result) => result.success)).toBe(true);
    expect(await storage.countDocuments()).toBe(1);
    expect(await storage.countChunks()).toBe(1);
  });

  it('keeps searchable content during startup sync and checks every discovered file', async () => {
    const { pipeline, storage, root } = await fixture();
    await pipeline.processFile('report.txt');
    const before = await storage.countChunks();
    await writeFile(join(root, 'report.txt'), 'Updated audit evidence.');
    const sync = new StartupSync(
      storage,
      new FileDiscovery({ rootPath: root }),
    );
    expect(await sync.needsSync()).toBe(true);
    expect((await sync.sync()).modified).toEqual(['report.txt']);
    expect(await storage.countChunks()).toBe(before);
    pipeline.start();
    await pipeline.waitForIdle();
    expect(await sync.needsSync()).toBe(false);
  });
});
