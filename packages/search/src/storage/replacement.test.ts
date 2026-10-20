/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from './StorageFactory.js';
import type { CreateChunkInput, StorageAdapter } from './types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const chunk = (text: string, chunkIndex = 0): CreateChunkInput => ({
  text,
  chunkIndex,
  startOffset: chunkIndex * 100,
  endOffset: chunkIndex * 100 + text.length,
});
const vector = [1, 0, 0, 0, 0, 0, 0, 0];

describe.each(['pglite', 'libsql', 'sqlite', 'lancedb'] as const)(
  '%s content replacement',
  (backend) => {
    async function fixture(indexType: 'none' | 'hnsw' = 'none'): Promise<{
      storage: StorageAdapter;
      id: string;
      other: string;
    }> {
      const directory = await mkdtemp(
        join(tmpdir(), `search-replacement-${backend}-`),
      );
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      const storage = await createStorage(
        {
          backend,
          path: join(directory, 'index'),
          inMemory: backend !== 'lancedb',
          backupEnabled: false,
        },
        { type: indexType, useHalfVec: false },
        8,
      );
      await storage.initialize();
      cleanups.push(() => storage.close());
      const create = async (filePath: string) => {
        const doc = await storage.createDocument({
          filePath,
          fileName: filePath,
          fileExtension: '.txt',
          fileHash: 'original',
          fileSize: 10,
          fileModifiedAt: new Date(),
        });
        await storage.replaceChunks!(
          doc.id,
          [chunk('Original audit evidence'), chunk('Old appendix', 1)],
          [vector, vector],
        );
        await storage.updateDocument(doc.id, {
          status: 'indexed',
          indexedAt: new Date(),
        });
        return doc.id;
      };
      return {
        storage,
        id: await create('report.txt'),
        other: await create('other.txt'),
      };
    }

    it('replaces text and vectors, removes obsolete chunks, and preserves other documents and tags', async () => {
      const { storage, id, other } = await fixture();
      await storage.addTags(id, ['reviewed']);
      await storage.replaceChunks!(
        id,
        [chunk('Replacement evidence')],
        [vector],
      );
      await storage.updateDocument(id, {
        status: 'indexed',
        indexedAt: new Date(),
      });
      expect((await storage.getChunks(id)).map((item) => item.text)).toEqual([
        'Replacement evidence',
      ]);
      expect(await storage.getChunks(other)).toHaveLength(2);
      expect(await storage.getDocumentTags(id)).toEqual(['reviewed']);
      expect(
        (await storage.searchSemantic(vector, {}, 10)).some(
          (item) => item.documentId === id,
        ),
      ).toBe(true);
    });

    it('preserves existing passages when a replacement vector is invalid', async () => {
      const { storage, id } = await fixture();
      const before = await storage.getChunks(id);
      await expect(
        storage.replaceChunks!(id, [chunk('Invalid replacement')], [[1, 2]]),
      ).rejects.toThrow();
      expect(await storage.getChunks(id)).toEqual(before);
    });

    it('retains document metadata when a file becomes empty, without returning a synthetic passage', async () => {
      const { storage, id } = await fixture();
      await storage.addTags(id, ['reviewed']);
      await storage.replaceChunks!(id, [], []);
      await storage.updateDocument(id, {
        status: 'indexed',
        fileHash: 'empty',
      });
      expect((await storage.getDocument(id))?.fileHash).toBe('empty');
      expect(await storage.getDocumentTags(id)).toEqual(['reviewed']);
      expect(await storage.getChunks(id)).toEqual([]);
      expect(await storage.countChunks()).toBe(2);
      expect(
        (await storage.searchSemantic(vector, {}, 10)).some(
          (item) => item.documentId === id,
        ),
      ).toBe(false);
    });

    if (backend !== 'lancedb') {
      it('rolls back partially written replacements on a database constraint error', async () => {
        const { storage, id } = await fixture();
        const before = await storage.getChunks(id);
        await expect(
          storage.replaceChunks!(
            id,
            [chunk('First'), chunk('Duplicate index')],
            [vector, vector],
          ),
        ).rejects.toThrow();
        expect(await storage.getChunks(id)).toEqual(before);
        expect(
          (await storage.searchSemantic(vector, {}, 10)).some(
            (item) => item.documentId === id,
          ),
        ).toBe(true);
      });
    }

    if (backend === 'sqlite') {
      it('preserves vector search after a failed replacement with HNSW enabled', async () => {
        const { storage, id } = await fixture('hnsw');
        const before = await storage.getChunks(id);
        await expect(
          storage.replaceChunks!(
            id,
            [chunk('First'), chunk('Duplicate index')],
            [vector, vector],
          ),
        ).rejects.toThrow();
        expect(await storage.getChunks(id)).toEqual(before);
        expect(
          (await storage.searchSemantic(vector, {}, 10)).filter(
            (item) => item.documentId === id,
          ),
        ).toHaveLength(2);
      });
    }

    it('claims each queued file once and recovers unfinished work', async () => {
      const { storage } = await fixture();
      await storage.enqueueItems([
        { filePath: 'report.txt' },
        { filePath: 'other.txt' },
      ]);
      const claimed = await Promise.all([
        storage.dequeueItem(),
        storage.dequeueItem(),
        storage.dequeueItem(),
      ]);
      expect(claimed.filter(Boolean)).toHaveLength(2);
      expect(
        new Set(claimed.filter(Boolean).map((item) => item!.id)).size,
      ).toBe(2);
      await storage.resetProcessingQueueItems!();
      expect((await storage.getQueueStatus()).pending).toBe(2);
    });
  },
);
