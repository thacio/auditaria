import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGliteStorage } from './PGliteStorage.js';
import type { CreateDocumentInput, CreateChunkInput } from './types.js';

describe('PGliteStorage', () => {
  let storage: PGliteStorage;

  beforeEach(async () => {
    // Use in-memory database for tests
    storage = new PGliteStorage({
      path: '',
      inMemory: true,
    });
    await storage.initialize();
  });

  afterEach(async () => {
    await storage.close();
  });

  describe('lifecycle', () => {
    it('should initialize successfully', () => {
      expect(storage.isInitialized()).toBe(true);
    });

    it('should close successfully', async () => {
      await storage.close();
      expect(storage.isInitialized()).toBe(false);
    });

    it('should not double initialize', async () => {
      await storage.initialize();
      expect(storage.isInitialized()).toBe(true);
    });

    it('should throw when not initialized', async () => {
      const newStorage = new PGliteStorage({ path: '', inMemory: true });
      await expect(newStorage.getStats()).rejects.toThrow(
        'Storage not initialized',
      );
    });
  });

  describe('documents', () => {
    const createTestDocument = (
      overrides?: Partial<CreateDocumentInput>,
    ): CreateDocumentInput => ({
      filePath: `/test/document-${Date.now()}.txt`,
      fileName: 'document.txt',
      fileExtension: '.txt',
      fileSize: 100,
      fileHash: `hash-${Date.now()}`,
      mimeType: 'text/plain',
      fileModifiedAt: new Date(),
      ...overrides,
    });

    it('should create a document', async () => {
      const input = createTestDocument();
      const doc = await storage.createDocument(input);

      expect(doc.id).toBeDefined();
      expect(doc.filePath).toBe(input.filePath);
      expect(doc.fileName).toBe(input.fileName);
      expect(doc.status).toBe('pending');
      expect(doc.ocrStatus).toBe('not_needed');
    });

    it('should get document by id', async () => {
      const input = createTestDocument();
      const created = await storage.createDocument(input);
      const found = await storage.getDocument(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.filePath).toBe(input.filePath);
    });

    it('should get document by path', async () => {
      const input = createTestDocument();
      const created = await storage.createDocument(input);
      const found = await storage.getDocumentByPath(input.filePath);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent document', async () => {
      const found = await storage.getDocument('non-existent-id');
      expect(found).toBeNull();
    });

    it('should update a document', async () => {
      const created = await storage.createDocument(createTestDocument());
      const updated = await storage.updateDocument(created.id, {
        status: 'indexed',
        title: 'Updated Title',
      });

      expect(updated.status).toBe('indexed');
      expect(updated.title).toBe('Updated Title');
      expect(updated.updatedAt.getTime()).toBeGreaterThan(
        created.updatedAt.getTime(),
      );
    });

    it('should delete a document', async () => {
      const created = await storage.createDocument(createTestDocument());
      await storage.deleteDocument(created.id);

      const found = await storage.getDocument(created.id);
      expect(found).toBeNull();
    });

    it('should list documents', async () => {
      await storage.createDocument(
        createTestDocument({ filePath: '/test/a.txt' }),
      );
      await storage.createDocument(
        createTestDocument({ filePath: '/test/b.txt' }),
      );

      const docs = await storage.listDocuments();
      expect(docs).toHaveLength(2);
    });

    it('should filter documents by folder', async () => {
      await storage.createDocument(
        createTestDocument({ filePath: '/folder1/a.txt' }),
      );
      await storage.createDocument(
        createTestDocument({ filePath: '/folder2/b.txt' }),
      );

      const docs = await storage.listDocuments({ folders: ['/folder1'] });
      expect(docs).toHaveLength(1);
      expect(docs[0].filePath).toBe('/folder1/a.txt');
    });

    it('should filter documents by file type', async () => {
      await storage.createDocument(
        createTestDocument({
          filePath: '/test/a.pdf',
          fileExtension: '.pdf',
        }),
      );
      await storage.createDocument(
        createTestDocument({
          filePath: '/test/b.txt',
          fileExtension: '.txt',
        }),
      );

      const docs = await storage.listDocuments({ fileTypes: ['.pdf'] });
      expect(docs).toHaveLength(1);
      expect(docs[0].fileExtension).toBe('.pdf');
    });

    it('should count documents', async () => {
      await storage.createDocument(createTestDocument({ filePath: '/a.txt' }));
      await storage.createDocument(createTestDocument({ filePath: '/b.txt' }));

      const count = await storage.countDocuments();
      expect(count).toBe(2);
    });
  });

  describe('chunks', () => {
    let documentId: string;

    beforeEach(async () => {
      const doc = await storage.createDocument({
        filePath: '/test/document.txt',
        fileName: 'document.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'hash123',
        fileModifiedAt: new Date(),
      });
      documentId = doc.id;
    });

    const createTestChunk = (index: number): CreateChunkInput => ({
      chunkIndex: index,
      text: `This is chunk ${index} text content`,
      startOffset: index * 100,
      endOffset: (index + 1) * 100,
      page: 1,
      section: 'Introduction',
    });

    it('should create chunks', async () => {
      const chunks = await storage.createChunks(documentId, [
        createTestChunk(0),
        createTestChunk(1),
      ]);

      expect(chunks).toHaveLength(2);
      expect(chunks[0].chunkIndex).toBe(0);
      expect(chunks[1].chunkIndex).toBe(1);
    });

    it('should get chunks for document', async () => {
      await storage.createChunks(documentId, [
        createTestChunk(0),
        createTestChunk(1),
      ]);

      const chunks = await storage.getChunks(documentId);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].documentId).toBe(documentId);
    });

    it('should delete chunks', async () => {
      await storage.createChunks(documentId, [createTestChunk(0)]);
      await storage.deleteChunks(documentId);

      const chunks = await storage.getChunks(documentId);
      expect(chunks).toHaveLength(0);
    });

    it('should update chunk embeddings', async () => {
      const chunks = await storage.createChunks(documentId, [
        createTestChunk(0),
      ]);
      const embedding = new Array(384).fill(0).map(() => Math.random());

      await storage.updateChunkEmbeddings([{ id: chunks[0].id, embedding }]);

      const updated = await storage.getChunks(documentId);
      expect(updated[0].embedding).toHaveLength(384);
    });

    it('should count chunks', async () => {
      await storage.createChunks(documentId, [
        createTestChunk(0),
        createTestChunk(1),
        createTestChunk(2),
      ]);

      const count = await storage.countChunks();
      expect(count).toBe(3);
    });

    it('should cascade delete chunks when document deleted', async () => {
      await storage.createChunks(documentId, [createTestChunk(0)]);
      await storage.deleteDocument(documentId);

      // Direct query since getChunks would fail with no document
      const count = await storage.countChunks();
      expect(count).toBe(0);
    });
  });

  describe('tags', () => {
    let documentId: string;

    beforeEach(async () => {
      const doc = await storage.createDocument({
        filePath: '/test/tagged-doc.txt',
        fileName: 'tagged-doc.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'hash-tagged',
        fileModifiedAt: new Date(),
      });
      documentId = doc.id;
    });

    it('should add tags to document', async () => {
      await storage.addTags(documentId, ['important', 'review']);

      const tags = await storage.getDocumentTags(documentId);
      expect(tags).toContain('important');
      expect(tags).toContain('review');
    });

    it('should not duplicate tags', async () => {
      await storage.addTags(documentId, ['tag1', 'tag1']);

      const tags = await storage.getDocumentTags(documentId);
      expect(tags).toHaveLength(1);
    });

    it('should remove tags from document', async () => {
      await storage.addTags(documentId, ['keep', 'remove']);
      await storage.removeTags(documentId, ['remove']);

      const tags = await storage.getDocumentTags(documentId);
      expect(tags).toContain('keep');
      expect(tags).not.toContain('remove');
    });

    it('should get all tags with counts', async () => {
      const doc2 = await storage.createDocument({
        filePath: '/test/doc2.txt',
        fileName: 'doc2.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'hash-doc2',
        fileModifiedAt: new Date(),
      });

      await storage.addTags(documentId, ['shared', 'unique1']);
      await storage.addTags(doc2.id, ['shared', 'unique2']);

      const allTags = await storage.getAllTags();
      const sharedTag = allTags.find((t) => t.tag === 'shared');

      expect(sharedTag?.count).toBe(2);
    });
  });

  describe('queue', () => {
    it('should enqueue an item', async () => {
      const item = await storage.enqueueItem({ filePath: '/test/file.txt' });

      expect(item.id).toBeDefined();
      expect(item.filePath).toBe('/test/file.txt');
      expect(item.status).toBe('pending');
      expect(item.priority).toBe('normal');
    });

    it('should enqueue with priority', async () => {
      const item = await storage.enqueueItem({
        filePath: '/test/urgent.txt',
        priority: 'high',
      });

      expect(item.priority).toBe('high');
    });

    it('should dequeue by priority order', async () => {
      await storage.enqueueItem({ filePath: '/low.txt', priority: 'low' });
      await storage.enqueueItem({ filePath: '/high.txt', priority: 'high' });
      await storage.enqueueItem({
        filePath: '/normal.txt',
        priority: 'normal',
      });

      const first = await storage.dequeueItem();
      expect(first?.filePath).toBe('/high.txt');
      expect(first?.status).toBe('processing');

      const second = await storage.dequeueItem();
      expect(second?.filePath).toBe('/normal.txt');

      const third = await storage.dequeueItem();
      expect(third?.filePath).toBe('/low.txt');
    });

    it('should return null when queue is empty', async () => {
      const item = await storage.dequeueItem();
      expect(item).toBeNull();
    });

    it('should update queue item', async () => {
      const item = await storage.enqueueItem({ filePath: '/test.txt' });
      const updated = await storage.updateQueueItem(item.id, {
        status: 'completed',
        completedAt: new Date(),
      });

      expect(updated.status).toBe('completed');
      expect(updated.completedAt).toBeDefined();
    });

    it('should get queue status', async () => {
      await storage.enqueueItem({ filePath: '/pending.txt' });
      await storage.enqueueItem({ filePath: '/high.txt', priority: 'high' });

      const status = await storage.getQueueStatus();

      expect(status.total).toBe(2);
      expect(status.pending).toBe(2);
      expect(status.byPriority.high).toBe(1);
      expect(status.byPriority.normal).toBe(1);
    });

    it('should clear completed items', async () => {
      const item1 = await storage.enqueueItem({ filePath: '/completed.txt' });
      await storage.enqueueItem({ filePath: '/pending.txt' });

      await storage.updateQueueItem(item1.id, { status: 'completed' });

      const cleared = await storage.clearCompletedQueueItems();
      expect(cleared).toBe(1);

      const status = await storage.getQueueStatus();
      expect(status.total).toBe(1);
    });

    it('should clear entire queue', async () => {
      await storage.enqueueItem({ filePath: '/file1.txt' });
      await storage.enqueueItem({ filePath: '/file2.txt' });

      await storage.clearQueue();

      const status = await storage.getQueueStatus();
      expect(status.total).toBe(0);
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Create a document with chunks for search testing
      const doc = await storage.createDocument({
        filePath: '/test/searchable.txt',
        fileName: 'searchable.txt',
        fileExtension: '.txt',
        fileSize: 1000,
        fileHash: 'hash-search',
        status: 'indexed',
        fileModifiedAt: new Date(),
      });

      await storage.createChunks(doc.id, [
        {
          chunkIndex: 0,
          text: 'This document discusses machine learning algorithms.',
          startOffset: 0,
          endOffset: 50,
          section: 'Introduction',
        },
        {
          chunkIndex: 1,
          text: 'Neural networks are a type of machine learning model.',
          startOffset: 50,
          endOffset: 100,
          section: 'Chapter 1',
        },
      ]);

      // Update embeddings for semantic search
      const chunks = await storage.getChunks(doc.id);
      const mockEmbedding = new Array(384).fill(0).map(() => Math.random());

      await storage.updateChunkEmbeddings([
        { id: chunks[0].id, embedding: mockEmbedding },
        { id: chunks[1].id, embedding: mockEmbedding },
      ]);
    });

    it('should perform keyword search', async () => {
      const results = await storage.searchKeyword('machine learning');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].matchType).toBe('keyword');
    });

    it('should perform semantic search', async () => {
      const queryEmbedding = new Array(384).fill(0).map(() => Math.random());
      const results = await storage.searchSemantic(queryEmbedding);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].matchType).toBe('semantic');
    });

    it('should perform hybrid search', async () => {
      const queryEmbedding = new Array(384).fill(0).map(() => Math.random());
      const results = await storage.searchHybrid(
        'machine learning',
        queryEmbedding,
      );

      expect(results.length).toBeGreaterThan(0);
    });

    it('should respect limit parameter', async () => {
      const results = await storage.searchKeyword('machine', undefined, 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('sync', () => {
    it('should get file hashes', async () => {
      await storage.createDocument({
        filePath: '/test/file1.txt',
        fileName: 'file1.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'hash1',
        fileModifiedAt: new Date(),
      });

      await storage.createDocument({
        filePath: '/test/file2.txt',
        fileName: 'file2.txt',
        fileExtension: '.txt',
        fileSize: 200,
        fileHash: 'hash2',
        fileModifiedAt: new Date(),
      });

      const hashes = await storage.getFileHashes();

      expect(hashes.size).toBe(2);
      expect(hashes.get('/test/file1.txt')).toBe('hash1');
      expect(hashes.get('/test/file2.txt')).toBe('hash2');
    });

    it('should get documents modified since date', async () => {
      const oldDate = new Date('2020-01-01');
      const newDate = new Date();

      await storage.createDocument({
        filePath: '/old.txt',
        fileName: 'old.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'hash-old',
        fileModifiedAt: oldDate,
      });

      await storage.createDocument({
        filePath: '/new.txt',
        fileName: 'new.txt',
        fileExtension: '.txt',
        fileSize: 100,
        fileHash: 'hash-new',
        fileModifiedAt: newDate,
      });

      const docs = await storage.getDocumentsModifiedSince(
        new Date('2023-01-01'),
      );

      expect(docs.length).toBe(1);
      expect(docs[0].filePath).toBe('/new.txt');
    });
  });

  describe('stats', () => {
    it('should get stats', async () => {
      const doc = await storage.createDocument({
        filePath: '/test/doc.txt',
        fileName: 'doc.txt',
        fileExtension: '.txt',
        fileSize: 500,
        fileHash: 'hash-stats',
        status: 'indexed',
        fileModifiedAt: new Date(),
      });

      await storage.createChunks(doc.id, [
        {
          chunkIndex: 0,
          text: 'Test chunk',
          startOffset: 0,
          endOffset: 10,
        },
      ]);

      await storage.addTags(doc.id, ['test-tag']);

      const stats = await storage.getStats();

      expect(stats.totalDocuments).toBe(1);
      expect(stats.indexedDocuments).toBe(1);
      expect(stats.totalChunks).toBe(1);
      expect(stats.totalTags).toBe(1);
    });
  });

  describe('configuration storage', () => {
    it('should set and get config value', async () => {
      await storage.setConfigValue('test_key', { foo: 'bar' });
      const value = await storage.getConfigValue<{ foo: string }>('test_key');

      expect(value).toEqual({ foo: 'bar' });
    });

    it('should return null for non-existent key', async () => {
      const value = await storage.getConfigValue('non_existent');
      expect(value).toBeNull();
    });

    it('should update existing config value', async () => {
      await storage.setConfigValue('key', 'value1');
      await storage.setConfigValue('key', 'value2');

      const value = await storage.getConfigValue<string>('key');
      expect(value).toBe('value2');
    });
  });

  describe('raw query', () => {
    it('should execute raw query', async () => {
      const result = await storage.query<{ result: number }>(
        'SELECT 1 + 1 as result',
      );
      expect(result[0].result).toBe(2);
    });

    it('should execute raw command', async () => {
      await expect(
        storage.execute(
          `INSERT INTO search_config (key, value) VALUES ('raw_key', '"raw_value"')
           ON CONFLICT (key) DO UPDATE SET value = '"raw_value"'`,
        ),
      ).resolves.not.toThrow();
    });
  });
});
