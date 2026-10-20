/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexingPipeline } from './IndexingPipeline.js';
import { ParserRegistry } from '../parsers/ParserRegistry.js';
import { ChunkerRegistry } from '../chunkers/ChunkerRegistry.js';
import { PGliteStorage } from '../storage/PGliteStorage.js';
import { MockEmbedder } from '../embedders/TransformersJsEmbedder.js';
import type { MediaDocument } from '../embedders/media.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'auditaria-media-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'scan.pdf');
  await writeFile(path, 'binary fixture: decoder is isolated in Python tests');
  const storage = new PGliteStorage({
    backend: 'pglite',
    path: '',
    inMemory: true,
    backupEnabled: false,
  });
  await storage.initialize();
  cleanup.push(() => storage.close());
  const base = new MockEmbedder(384);
  await base.initialize();
  const vector = [1, ...Array<number>(383).fill(0)];
  const prepareMedia = vi.fn(
    async (): Promise<MediaDocument> => ({
      pageCount: 1,
      chunks: [
        {
          index: 0,
          text: '[Visual PDF page 1]',
          startOffset: 0,
          endOffset: 19,
          metadata: { page: 1, section: 'Visual PDF page' },
          source: { kind: 'pdf', path, page: 1 },
        },
      ],
    }),
  );
  const embedMedia = vi.fn(async () => [vector]);
  Object.assign(base, { prepareMedia, embedMedia });
  const parsers = new ParserRegistry(); // No text or OCR parser can handle this fixture.
  const pipeline = new IndexingPipeline(
    storage,
    parsers,
    new ChunkerRegistry(),
    base,
    {
      rootPath: root,
      autoStart: false,
      prepareWorkers: 1,
    },
  );
  cleanup.push(() => pipeline.stop());
  return { path, pipeline, storage, prepareMedia, embedMedia, vector };
}

describe('media indexing', () => {
  it('indexes visual pages without OCR and returns their page references', async () => {
    const { path, pipeline, storage, vector } = await fixture();
    const ocr = vi.fn();
    pipeline.on('document:ocr_needed', ocr);
    expect((await pipeline.processFile(path)).success).toBe(true);
    const results = await storage.searchSemantic(vector, {}, 5);
    expect(results[0].metadata.page).toBe(1);
    expect(results[0].metadata.section).toBe('Visual PDF page');
    expect(results[0].chunkText).toBe('[Visual PDF page 1]');
    expect(ocr).not.toHaveBeenCalled();
  }, 30_000);

  it('uses media embeddings in the queued producer/consumer pipeline too', async () => {
    const { path, pipeline, storage, embedMedia } = await fixture();
    await pipeline.queueFile(path);
    const completed = new Promise<void>((resolve) =>
      pipeline.on('document:completed', () => resolve()),
    );
    pipeline.start();
    await completed;
    expect(embedMedia).toHaveBeenCalledOnce();
    expect((await storage.getDocumentByPath('scan.pdf'))?.ocrStatus).toBe(
      'not_needed',
    );
  }, 30_000);

  it('does not mark failed media inference as indexed', async () => {
    const { path, pipeline, storage, embedMedia } = await fixture();
    embedMedia.mockRejectedValueOnce(new Error('decoder failed'));
    expect((await pipeline.processFile(path)).success).toBe(false);
    expect((await storage.getDocumentByPath('scan.pdf'))?.status).toBe(
      'failed',
    );
  }, 30_000);
});
