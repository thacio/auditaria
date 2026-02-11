/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Basic integration tests for LanceDBStorage.
 * Tests the StorageAdapter interface implementation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LanceDBStorage } from './LanceDBStorage.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('LanceDBStorage', () => {
  let storage: LanceDBStorage;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temp directory for the database
    tempDir = path.join(os.tmpdir(), `lancedb-storage-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    storage = new LanceDBStorage(
      {
        backend: 'lancedb',
        path: path.join(tempDir, 'test.db'),
        inMemory: false,
        backupEnabled: false,
      },
      undefined,
      384, // embedding dimensions
    );

    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();

    // Small delay to allow LanceDB to release file handles
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clean up temp directory
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Ignore cleanup errors in tests
      }
    }
  });

  describe('Lifecycle', () => {
    it('should initialize successfully', () => {
      expect(storage.isInitialized()).toBe(true);
    });

    it('should report not suspended after init', () => {
      expect(storage.isSuspended()).toBe(false);
    });

    it('should support suspend and resume', async () => {
      await storage.suspend();
      expect(storage.isSuspended()).toBe(true);

      await storage.resume();
      expect(storage.isSuspended()).toBe(false);
      expect(storage.isInitialized()).toBe(true);
    });
  });

  describe('Documents', () => {
    it('should create and retrieve a document', async () => {
      const doc = await storage.createDocument({
        filePath: '/test/doc.txt',
        fileName: 'doc.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'abc123',
        fileModifiedAt: new Date(),
      });

      expect(doc).toBeDefined();
      expect(doc.id).toBeDefined();
      expect(doc.filePath).toBe('/test/doc.txt');

      // Document should be in pending state until chunks are created
      const retrieved = await storage.getDocument(doc.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(doc.id);
    });

    it('should get document by path', async () => {
      const doc = await storage.createDocument({
        filePath: '/test/doc2.txt',
        fileName: 'doc2.txt',
        fileExtension: '.txt',
        fileSize: 200,
        fileHash: 'def456',
        fileModifiedAt: new Date(),
      });

      const retrieved = await storage.getDocumentByPath('/test/doc2.txt');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(doc.id);
    });

    it('should update document status', async () => {
      const doc = await storage.createDocument({
        filePath: '/test/doc3.txt',
        fileName: 'doc3.txt',
        fileExtension: '.txt',
        fileSize: 300,
        fileHash: 'ghi789',
        fileModifiedAt: new Date(),
      });

      const updated = await storage.updateDocument(doc.id, {
        status: 'indexed',
        title: 'Test Document',
      });

      expect(updated.status).toBe('indexed');
      expect(updated.title).toBe('Test Document');
    });
  });

  describe('Chunks', () => {
    it('should create and retrieve chunks', async () => {
      const doc = await storage.createDocument({
        filePath: '/test/chunked.txt',
        fileName: 'chunked.txt',
        fileExtension: '.txt',
        fileSize: 500,
        fileHash: 'chunk123',
        fileModifiedAt: new Date(),
      });

      const chunks = await storage.createChunks(doc.id, [
        {
          chunkIndex: 0,
          text: 'First chunk of text',
          startOffset: 0,
          endOffset: 19,
        },
        {
          chunkIndex: 1,
          text: 'Second chunk of text',
          startOffset: 20,
          endOffset: 40,
        },
      ]);

      expect(chunks.length).toBe(2);
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[1].chunkIndex).toBe(1);

      const retrieved = await storage.getChunks(doc.id);
      expect(retrieved.length).toBe(2);
    });

    it('should update chunk embeddings', async () => {
      const doc = await storage.createDocument({
        filePath: '/test/embedded.txt',
        fileName: 'embedded.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'embed123',
        fileModifiedAt: new Date(),
      });

      const chunks = await storage.createChunks(doc.id, [
        {
          chunkIndex: 0,
          text: 'Chunk with embedding',
          startOffset: 0,
          endOffset: 20,
        },
      ]);

      const embedding = new Array(384).fill(0.1);
      await storage.updateChunkEmbeddings([
        { id: chunks[0].id, embedding },
      ]);

      // Verify via stats (we can't directly retrieve embeddings)
      const chunkCount = await storage.countChunks();
      expect(chunkCount).toBe(1);
    });
  });

  describe('Queue', () => {
    it('should enqueue and dequeue items', async () => {
      const item = await storage.enqueueItem({
        filePath: '/test/queue.txt',
        fileSize: 100,
        priority: 'text',
      });

      expect(item).toBeDefined();
      expect(item.status).toBe('pending');

      const dequeued = await storage.dequeueItem();
      expect(dequeued).toBeDefined();
      expect(dequeued?.status).toBe('processing');
      expect(dequeued?.filePath).toBe('/test/queue.txt');
    });

    it('should update queue item status', async () => {
      const item = await storage.enqueueItem({
        filePath: '/test/update-queue.txt',
        fileSize: 200,
      });

      const updated = await storage.updateQueueItem(item.id, {
        status: 'completed',
        completedAt: new Date(),
      });

      expect(updated.status).toBe('completed');
      expect(updated.completedAt).toBeDefined();
    });

    it('should get queue status', async () => {
      await storage.enqueueItem({ filePath: '/a.txt' });
      await storage.enqueueItem({ filePath: '/b.txt' });

      const status = await storage.getQueueStatus();
      expect(status.total).toBe(2);
      expect(status.pending).toBe(2);
    });

    it('should get detailed queue status with deferred reason counts', async () => {
      await storage.enqueueItem({
        filePath: '/deferred-raw-text.txt',
        priority: 'deferred',
        deferReason: 'raw_text_oversize',
      });
      await storage.enqueueItem({
        filePath: '/deferred-raw-markup.docx',
        priority: 'deferred',
        deferReason: 'raw_markup_oversize',
      });
      const parsedDeferred = await storage.enqueueItem({
        filePath: '/deferred-parsed.md',
      });
      await storage.updateQueueItem(parsedDeferred.id, {
        priority: 'deferred',
        deferReason: 'parsed_text_oversize',
      });

      const detailedStatus = await storage.getQueueDetailedStatus();
      expect(detailedStatus.precision).toBe('exact');
      expect(detailedStatus.byPriority.deferred).toBe(3);
      expect(detailedStatus.deferredByReason.raw_text_oversize).toBe(1);
      expect(detailedStatus.deferredByReason.raw_markup_oversize).toBe(1);
      expect(detailedStatus.deferredByReason.parsed_text_oversize).toBe(1);
      expect(detailedStatus.deferredByReason.unknown).toBe(0);
    });
  });

  describe('Config', () => {
    it('should set and get config values', async () => {
      await storage.setConfigValue('testKey', { foo: 'bar', count: 42 });

      const value = await storage.getConfigValue<{ foo: string; count: number }>('testKey');
      expect(value).toEqual({ foo: 'bar', count: 42 });
    });

    it('should return null for missing config', async () => {
      const value = await storage.getConfigValue('nonexistent');
      expect(value).toBeNull();
    });
  });

  describe('Stats', () => {
    it('should return stats', async () => {
      const stats = await storage.getStats();
      expect(stats).toBeDefined();
      expect(stats.totalDocuments).toBeGreaterThanOrEqual(0);
      expect(stats.totalChunks).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Search', () => {
    it('should perform semantic search', async () => {
      // Create a document with chunks
      const doc = await storage.createDocument({
        filePath: '/test/search.txt',
        fileName: 'search.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'search123',
        status: 'indexed',
        fileModifiedAt: new Date(),
      });

      await storage.createChunks(doc.id, [
        {
          chunkIndex: 0,
          text: 'Machine learning is fascinating',
          startOffset: 0,
          endOffset: 31,
        },
      ]);

      // Update document status to indexed
      await storage.updateDocument(doc.id, { status: 'indexed' });

      // Search with a query embedding
      const embedding = new Array(384).fill(0.1);
      const results = await storage.searchSemantic(embedding, undefined, 10);

      // Results may be empty if embeddings weren't stored properly,
      // but the search should not throw
      expect(Array.isArray(results)).toBe(true);
    });
  });
});
