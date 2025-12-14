/**
 * Tests for OcrQueueManager.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OcrQueueManager} from './OcrQueueManager.js';
import { createOcrQueueManager } from './OcrQueueManager.js';
import { OcrRegistry } from './OcrRegistry.js';
import type { OcrProvider, OcrResult } from './types.js';
import type { StorageAdapter } from '../storage/types.js';
import type { OcrRegion } from '../parsers/types.js';

// Mock Storage Adapter
const createMockStorage = (): StorageAdapter => ({
  initialize: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isInitialized: vi.fn().mockReturnValue(true),
  createDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
  getDocument: vi.fn().mockResolvedValue({
    id: 'doc-1',
    filePath: '/test/file.pdf',
  }),
  getDocumentByPath: vi.fn().mockResolvedValue(null),
  updateDocument: vi.fn().mockResolvedValue({ id: 'doc-1' }),
  deleteDocument: vi.fn().mockResolvedValue(undefined),
  listDocuments: vi.fn().mockResolvedValue([]),
  countDocuments: vi.fn().mockResolvedValue(0),
  createChunks: vi.fn().mockResolvedValue([]),
  getChunks: vi
    .fn()
    .mockResolvedValue([{ id: 'chunk-1', endOffset: 100, text: 'test' }]),
  deleteChunks: vi.fn().mockResolvedValue(undefined),
  updateChunkEmbeddings: vi.fn().mockResolvedValue(undefined),
  countChunks: vi.fn().mockResolvedValue(0),
  addTags: vi.fn().mockResolvedValue(undefined),
  removeTags: vi.fn().mockResolvedValue(undefined),
  getDocumentTags: vi.fn().mockResolvedValue([]),
  getAllTags: vi.fn().mockResolvedValue([]),
  searchKeyword: vi.fn().mockResolvedValue([]),
  searchSemantic: vi.fn().mockResolvedValue([]),
  searchHybrid: vi.fn().mockResolvedValue([]),
  enqueueItem: vi.fn().mockResolvedValue({ id: 'queue-1' }),
  enqueueItems: vi.fn().mockResolvedValue([]),
  dequeueItem: vi.fn().mockResolvedValue(null),
  updateQueueItem: vi.fn().mockResolvedValue({ id: 'queue-1' }),
  deleteQueueItem: vi.fn().mockResolvedValue(undefined),
  getQueueItemByPath: vi.fn().mockResolvedValue(null),
  getQueueStatus: vi.fn().mockResolvedValue({
    total: 0,
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    byPriority: { high: 0, normal: 0, low: 0, ocr: 0 },
  }),
  clearCompletedQueueItems: vi.fn().mockResolvedValue(0),
  clearQueue: vi.fn().mockResolvedValue(undefined),
  getFileHashes: vi.fn().mockResolvedValue(new Map()),
  getDocumentsModifiedSince: vi.fn().mockResolvedValue([]),
  getStats: vi.fn().mockResolvedValue({
    totalDocuments: 0,
    totalChunks: 0,
    indexedDocuments: 0,
    pendingDocuments: 0,
    failedDocuments: 0,
    ocrPending: 0,
    totalTags: 0,
    databaseSize: 0,
  }),
  getConfigValue: vi.fn().mockResolvedValue(null),
  setConfigValue: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(undefined),
});

// Mock OCR Provider
class MockOcrProvider implements OcrProvider {
  readonly name = 'mock-ocr';
  readonly supportedLanguages = ['en'];
  readonly priority = 100;
  private ready = false;

  isReady(): boolean {
    return this.ready;
  }

  async initialize(): Promise<void> {
    this.ready = true;
  }

  async recognize(): Promise<OcrResult> {
    return {
      text: 'Mock OCR text from image',
      confidence: 0.92,
      regions: [],
    };
  }

  async recognizeRegions(regions: OcrRegion[]): Promise<OcrResult[]> {
    return regions.map(() => ({
      text: 'Region text',
      confidence: 0.9,
      regions: [],
    }));
  }

  async recognizeFile(): Promise<OcrResult> {
    return {
      text: 'Mock OCR text from file',
      confidence: 0.95,
      regions: [],
    };
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }
}

describe('OcrQueueManager', () => {
  let storage: StorageAdapter;
  let registry: OcrRegistry;
  let queueManager: OcrQueueManager;
  let mockProvider: MockOcrProvider;

  beforeEach(async () => {
    storage = createMockStorage();
    registry = new OcrRegistry();
    mockProvider = new MockOcrProvider();
    registry.register(mockProvider);
    await mockProvider.initialize();

    queueManager = createOcrQueueManager(storage, registry, {
      enabled: true,
      concurrency: 1,
      maxRetries: 2,
      retryDelay: 100,
      processAfterMainQueue: false, // Don't wait for main queue in tests
      defaultLanguages: ['en'],
    });
  });

  describe('state management', () => {
    it('should start in idle state', () => {
      expect(queueManager.getState()).toBe('idle');
    });

    it('should transition to running state when started', () => {
      queueManager.start();
      expect(queueManager.getState()).toBe('running');
    });

    it('should pause and resume', () => {
      queueManager.start();
      queueManager.pause();
      expect(queueManager.getState()).toBe('paused');

      queueManager.resume();
      expect(queueManager.getState()).toBe('running');
    });

    it('should stop processing', async () => {
      queueManager.start();
      await queueManager.stop();
      expect(queueManager.getState()).toBe('idle');
    });
  });

  describe('queue operations', () => {
    it('should enqueue a document for OCR', async () => {
      const regions: OcrRegion[] = [
        { page: 1, bounds: { x: 0, y: 0, width: 100, height: 50 } },
      ];

      const job = await queueManager.enqueue(
        'doc-1',
        '/test/file.pdf',
        regions,
      );

      expect(job.documentId).toBe('doc-1');
      expect(job.filePath).toBe('/test/file.pdf');
      expect(job.status).toBe('pending');
      expect(job.regions).toEqual(regions);
    });

    it('should update document OCR status when enqueueing', async () => {
      const regions: OcrRegion[] = [];
      await queueManager.enqueue('doc-1', '/test/file.pdf', regions);

      expect(storage.updateDocument).toHaveBeenCalledWith('doc-1', {
        ocrStatus: 'pending',
      });
    });

    it('should find job by document ID', async () => {
      await queueManager.enqueue('doc-1', '/test/file.pdf', []);

      const job = queueManager.findJobByDocument('doc-1');
      expect(job).toBeDefined();
      expect(job!.documentId).toBe('doc-1');
    });

    it('should get pending jobs', async () => {
      await queueManager.enqueue('doc-1', '/test/file1.pdf', []);
      await queueManager.enqueue('doc-2', '/test/file2.pdf', []);

      const pending = queueManager.getPendingJobs();
      expect(pending).toHaveLength(2);
    });

    it('should cancel a pending job', async () => {
      const job = await queueManager.enqueue('doc-1', '/test/file.pdf', []);
      const cancelled = queueManager.cancelJob(job.id);

      expect(cancelled).toBe(true);
      expect(queueManager.getPendingJobs()).toHaveLength(0);
    });

    it('should clear completed jobs', async () => {
      const job = await queueManager.enqueue('doc-1', '/test/file.pdf', []);
      // Manually mark as completed for testing
      job.status = 'completed';

      const cleared = queueManager.clearCompleted();
      expect(cleared).toBe(1);
    });
  });

  describe('status', () => {
    it('should return correct status', async () => {
      await queueManager.enqueue('doc-1', '/test/file1.pdf', []);
      await queueManager.enqueue('doc-2', '/test/file2.pdf', []);

      const status = queueManager.getStatus();

      expect(status.state).toBe('idle');
      expect(status.totalJobs).toBe(2);
      expect(status.pendingJobs).toBe(2);
      expect(status.processingJobs).toBe(0);
      expect(status.completedJobs).toBe(0);
      expect(status.failedJobs).toBe(0);
    });

    it('should report if OCR is enabled', () => {
      expect(queueManager.isEnabled()).toBe(true);
    });

    it('should report disabled when no providers', () => {
      const emptyRegistry = new OcrRegistry();
      const disabled = createOcrQueueManager(storage, emptyRegistry, {
        enabled: true,
        concurrency: 1,
        maxRetries: 3,
        retryDelay: 5000,
        processAfterMainQueue: true,
        defaultLanguages: ['en'],
      });

      expect(disabled.isEnabled()).toBe(false);
    });
  });

  describe('processing', () => {
    it('should process all pending jobs', async () => {
      await queueManager.enqueue('doc-1', '/test/file1.pdf', []);

      const result = await queueManager.processAll();

      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(1);
      expect(result.failed).toBe(0);
    });

    it('should emit events during processing', async () => {
      const startedHandler = vi.fn();
      const completedHandler = vi.fn();

      queueManager.on('ocr:started', startedHandler);
      queueManager.on('ocr:completed', completedHandler);

      await queueManager.enqueue('doc-1', '/test/file.pdf', []);
      await queueManager.processAll();

      expect(startedHandler).toHaveBeenCalled();
      expect(completedHandler).toHaveBeenCalled();
    });

    it('should update document status on completion', async () => {
      await queueManager.enqueue('doc-1', '/test/file.pdf', []);
      await queueManager.processAll();

      expect(storage.updateDocument).toHaveBeenCalledWith('doc-1', {
        ocrStatus: 'completed',
      });
    });

    it('should create OCR chunk on completion', async () => {
      await queueManager.enqueue('doc-1', '/test/file.pdf', []);
      await queueManager.processAll();

      expect(storage.createChunks).toHaveBeenCalled();
    });
  });
});
