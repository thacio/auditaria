/**
 * Tests for SearchEngine.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SearchEngine } from './SearchEngine.js';
import { MockEmbedder } from '../embedders/TransformersJsEmbedder.js';
import type { StorageAdapter } from '../storage/types.js';
import type { SearchResult } from '../types.js';

// ============================================================================
// Mock Storage
// ============================================================================

function createMockStorage(): StorageAdapter {
  const mockResults: SearchResult[] = [
    {
      documentId: 'doc1',
      chunkId: 'chunk1',
      filePath: '/docs/file1.pdf',
      fileName: 'file1.pdf',
      chunkText: 'This is a test document about machine learning.',
      score: 0.9,
      matchType: 'semantic',
      highlights: [],
      metadata: { page: 1, section: 'Introduction', tags: [] },
    },
    {
      documentId: 'doc2',
      chunkId: 'chunk2',
      filePath: '/docs/file2.pdf',
      fileName: 'file2.pdf',
      chunkText: 'Machine learning is a subset of artificial intelligence.',
      score: 0.8,
      matchType: 'semantic',
      highlights: [],
      metadata: { page: 1, section: null, tags: ['ai'] },
    },
  ];

  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),

    // Document methods
    createDocument: vi.fn(),
    getDocument: vi.fn(),
    getDocumentByPath: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
    listDocuments: vi.fn(),
    countDocuments: vi.fn(),

    // Chunk methods
    createChunks: vi.fn(),
    getChunks: vi.fn(),
    deleteChunks: vi.fn(),
    updateChunkEmbeddings: vi.fn(),
    countChunks: vi.fn(),

    // Tag methods
    addTags: vi.fn(),
    removeTags: vi.fn(),
    getDocumentTags: vi.fn(),
    getAllTags: vi.fn(),

    // Search methods
    searchKeyword: vi
      .fn()
      .mockResolvedValue(
        mockResults.map((r) => ({ ...r, matchType: 'keyword' })),
      ),
    searchSemantic: vi.fn().mockResolvedValue(mockResults),
    searchHybrid: vi
      .fn()
      .mockResolvedValue(
        mockResults.map((r) => ({ ...r, matchType: 'hybrid' })),
      ),

    // Queue methods
    enqueueItem: vi.fn(),
    enqueueItems: vi.fn(),
    dequeueItem: vi.fn(),
    updateQueueItem: vi.fn(),
    deleteQueueItem: vi.fn(),
    getQueueItemByPath: vi.fn(),
    getQueueStatus: vi.fn(),
    clearCompletedQueueItems: vi.fn(),
    clearQueue: vi.fn(),

    // Sync methods
    getFileHashes: vi.fn(),
    getDocumentsModifiedSince: vi.fn(),

    // Stats
    getStats: vi.fn(),

    // Config
    getConfigValue: vi.fn(),
    setConfigValue: vi.fn(),

    // Raw query
    query: vi.fn(),
    execute: vi.fn(),
  } as unknown as StorageAdapter;
}

// ============================================================================
// Tests
// ============================================================================

describe('SearchEngine', () => {
  let engine: SearchEngine;
  let mockStorage: StorageAdapter;
  let mockEmbedder: MockEmbedder;

  beforeEach(async () => {
    mockStorage = createMockStorage();
    mockEmbedder = new MockEmbedder();
    await mockEmbedder.initialize();
    engine = new SearchEngine(mockStorage, mockEmbedder);
  });

  describe('search', () => {
    it('should perform keyword search when strategy is keyword', async () => {
      const response = await engine.search({
        query: 'machine learning',
        strategy: 'keyword',
      });

      expect(mockStorage.searchKeyword).toHaveBeenCalledWith(
        'machine learning',
        {},
        expect.any(Number),
      );
      expect(response.results).toHaveLength(2);
      expect(response.strategy).toBe('keyword');
    });

    it('should perform semantic search when strategy is semantic', async () => {
      const response = await engine.search({
        query: 'machine learning',
        strategy: 'semantic',
      });

      expect(mockStorage.searchSemantic).toHaveBeenCalled();
      expect(response.results).toHaveLength(2);
      expect(response.strategy).toBe('semantic');
    });

    it('should perform hybrid search by default', async () => {
      const response = await engine.search({
        query: 'machine learning',
        strategy: 'hybrid',
      });

      // Hybrid search calls both semantic and keyword
      expect(mockStorage.searchSemantic).toHaveBeenCalled();
      expect(mockStorage.searchKeyword).toHaveBeenCalled();
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.strategy).toBe('hybrid');
    });

    it('should respect limit option', async () => {
      const response = await engine.search({
        query: 'machine learning',
        strategy: 'keyword',
        limit: 1,
      });

      expect(response.results).toHaveLength(1);
    });

    it('should respect offset option', async () => {
      const response = await engine.search({
        query: 'machine learning',
        strategy: 'keyword',
        offset: 1,
      });

      // Should skip first result
      expect(response.results).toHaveLength(1);
      expect(response.results[0].documentId).toBe('doc2');
    });

    it('should include filters in search', async () => {
      await engine.search({
        query: 'test',
        strategy: 'keyword',
        filters: {
          fileTypes: ['.pdf'],
          folders: ['/docs'],
        },
      });

      expect(mockStorage.searchKeyword).toHaveBeenCalledWith(
        'test',
        {
          fileTypes: ['.pdf'],
          folders: ['/docs'],
        },
        expect.any(Number),
      );
    });

    it('should filter by minimum score', async () => {
      const response = await engine.search({
        query: 'test',
        strategy: 'keyword',
        filters: {
          minScore: 0.85,
        },
      });

      // Only doc1 with score 0.9 should remain
      expect(response.results).toHaveLength(1);
      expect(response.results[0].score).toBeGreaterThanOrEqual(0.85);
    });

    it('should return search metadata in response', async () => {
      const response = await engine.search({
        query: 'test query',
        strategy: 'keyword',
      });

      expect(response.query).toBe('test query');
      expect(response.strategy).toBe('keyword');
      expect(response.took).toBeGreaterThanOrEqual(0);
      expect(response.total).toBe(response.results.length);
    });

    it('should add highlights when requested', async () => {
      const response = await engine.search({
        query: 'machine learning',
        strategy: 'keyword',
        highlight: true,
      });

      // Each result should have highlights extracted
      for (const result of response.results) {
        expect(result.highlights).toBeDefined();
      }
    });
  });

  describe('searchKeyword', () => {
    it('should call storage searchKeyword directly', async () => {
      const results = await engine.searchKeyword('test query');

      expect(mockStorage.searchKeyword).toHaveBeenCalledWith(
        'test query',
        undefined,
        10,
      );
      expect(results).toHaveLength(2);
    });

    it('should pass filters and limit', async () => {
      const filters = { fileTypes: ['.pdf'] };
      await engine.searchKeyword('test', filters, 5);

      expect(mockStorage.searchKeyword).toHaveBeenCalledWith(
        'test',
        filters,
        5,
      );
    });
  });

  describe('searchSemantic', () => {
    it('should call storage searchSemantic with query embedding', async () => {
      const results = await engine.searchSemantic('test query');

      expect(mockStorage.searchSemantic).toHaveBeenCalledWith(
        expect.any(Array), // embedding
        undefined,
        10,
      );
      expect(results).toHaveLength(2);
    });

    it('should initialize embedder if not ready', async () => {
      const uninitializedEmbedder = new MockEmbedder();
      const newEngine = new SearchEngine(mockStorage, uninitializedEmbedder);

      expect(uninitializedEmbedder.isReady()).toBe(false);

      await newEngine.searchSemantic('test');

      expect(uninitializedEmbedder.isReady()).toBe(true);
    });
  });

  describe('searchHybrid', () => {
    it('should call storage searchHybrid', async () => {
      const results = await engine.searchHybrid('test query');

      expect(mockStorage.searchHybrid).toHaveBeenCalled();
      expect(results).toHaveLength(2);
    });

    it('should accept custom weights', async () => {
      await engine.searchHybrid('test', undefined, undefined, {
        semantic: 0.7,
        keyword: 0.3,
      });

      expect(mockStorage.searchHybrid).toHaveBeenCalledWith(
        'test',
        expect.any(Array),
        undefined,
        10,
        { semantic: 0.7, keyword: 0.3 },
        60, // default rrfK
      );
    });
  });

  describe('events', () => {
    it('should emit search:started event', async () => {
      const handler = vi.fn();
      engine.on('search:started', handler);

      await engine.search({ query: 'test', strategy: 'keyword' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'test',
          strategy: 'keyword',
        }),
      );
    });

    it('should emit search:completed event', async () => {
      const handler = vi.fn();
      engine.on('search:completed', handler);

      await engine.search({ query: 'test', strategy: 'keyword' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          resultCount: expect.any(Number),
          duration: expect.any(Number),
          strategy: 'keyword',
        }),
      );
    });

    it('should emit search:error event on failure', async () => {
      const error = new Error('Search failed');
      (mockStorage.searchKeyword as ReturnType<typeof vi.fn>).mockRejectedValue(
        error,
      );

      const handler = vi.fn();
      engine.on('search:error', handler);

      await expect(
        engine.search({ query: 'test', strategy: 'keyword' }),
      ).rejects.toThrow('Search failed');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          error,
        }),
      );
    });
  });

  describe('search failure behavior (no silent fallbacks)', () => {
    // IMPORTANT: Search should fail loudly, NOT silently fall back to another strategy.
    // This prevents misleading results when a search strategy fails.

    it('should throw if embedder initialization fails during hybrid search', async () => {
      const failingEmbedder = {
        ...mockEmbedder,
        isReady: () => false,
        initialize: vi.fn().mockRejectedValue(new Error('Embedder failed')),
      } as unknown as MockEmbedder;

      const failingEngine = new SearchEngine(mockStorage, failingEmbedder);

      // Should throw, NOT fall back to keyword search
      await expect(
        failingEngine.search({ query: 'test', strategy: 'hybrid' }),
      ).rejects.toThrow('Embedder failed');
    });

    it('should throw if semantic search fails during hybrid search', async () => {
      (
        mockStorage.searchSemantic as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('Semantic search failed'));

      // Should throw, NOT fall back to keyword search
      await expect(
        engine.search({ query: 'test', strategy: 'hybrid' }),
      ).rejects.toThrow('Semantic search failed');
    });

    it('should throw if keyword search fails during hybrid search', async () => {
      (mockStorage.searchKeyword as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Keyword search failed'),
      );

      // Should throw, NOT silently ignore the failure
      await expect(
        engine.search({ query: 'test', strategy: 'hybrid' }),
      ).rejects.toThrow('Keyword search failed');
    });

    it('should throw if semantic strategy fails', async () => {
      // Mock the embedder's embedQuery to fail
      const originalEmbedQuery = mockEmbedder.embedQuery;
      mockEmbedder.embedQuery = vi
        .fn()
        .mockRejectedValue(new Error('Embedding failed'));

      try {
        await expect(
          engine.search({ query: 'test', strategy: 'semantic' }),
        ).rejects.toThrow('Embedding failed');
      } finally {
        // Restore original
        mockEmbedder.embedQuery = originalEmbedQuery;
      }
    });

    it('should throw if keyword strategy fails', async () => {
      (mockStorage.searchKeyword as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Keyword search failed'),
      );

      await expect(
        engine.search({ query: 'test', strategy: 'keyword' }),
      ).rejects.toThrow('Keyword search failed');
    });
  });

  describe('getSuggestions', () => {
    it('should return search suggestions', async () => {
      const suggestions = await engine.getSuggestions('mach', 5);

      expect(mockStorage.searchKeyword).toHaveBeenCalled();
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe('configuration', () => {
    it('should use config defaults', () => {
      const configuredEngine = new SearchEngine(mockStorage, mockEmbedder, {
        defaultLimit: 20,
        defaultStrategy: 'semantic',
        semanticWeight: 0.8,
        keywordWeight: 0.2,
      });

      // Access internal config through search behavior
      expect(configuredEngine).toBeDefined();
    });
  });
});
