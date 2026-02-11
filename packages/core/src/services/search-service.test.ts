/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SearchServiceManager, getSearchService } from './search-service.js';

// Mock the @thacio/auditaria-search module
vi.mock('@thacio/auditaria-search', () => {
  const mockSearchSystem = {
    discoverFiles: vi.fn().mockResolvedValue([]),
    indexAll: vi.fn().mockResolvedValue({ indexed: 0, failed: 0, duration: 0 }),
    getStats: vi.fn().mockResolvedValue({
      totalDocuments: 0,
      indexedDocuments: 0,
      totalChunks: 0,
      totalTags: 0,
      databaseSize: 0,
    }),
    getState: vi.fn().mockReturnValue({
      initialized: true,
      rootPath: '/test',
      databasePath: '/test/.auditaria/knowledge-base.db',
      indexingInProgress: false,
      ocrEnabled: false,
      ocrAvailable: false,
    }),
    getQueueStatus: vi.fn().mockResolvedValue({
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    }),
    getOcrQueueStatus: vi.fn().mockReturnValue(null),
    startProcessing: vi.fn(),
    stopProcessing: vi.fn().mockResolvedValue(undefined),
    reindexFile: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue({ results: [], took: 0 }),
    on: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    storage: {
      execute: vi.fn().mockResolvedValue(undefined),
    },
  };

  return {
    initializeSearchSystem: vi.fn().mockResolvedValue(mockSearchSystem),
    loadSearchSystem: vi.fn().mockResolvedValue(mockSearchSystem),
    searchDatabaseExists: vi.fn().mockReturnValue(false),
    SearchSystem: vi.fn(),
  };
});

describe('SearchServiceManager', () => {
  beforeEach(() => {
    // Reset singleton before each test
    SearchServiceManager.resetInstance();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Cleanup
    const service = SearchServiceManager.getInstance();
    if (service.isRunning()) {
      await service.stop();
    }
    SearchServiceManager.resetInstance();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const instance1 = SearchServiceManager.getInstance();
      const instance2 = SearchServiceManager.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should reset instance correctly', () => {
      const instance1 = SearchServiceManager.getInstance();
      SearchServiceManager.resetInstance();
      const instance2 = SearchServiceManager.getInstance();
      expect(instance1).not.toBe(instance2);
    });

    it('should return same instance via getSearchService helper', () => {
      const service1 = getSearchService();
      const service2 = SearchServiceManager.getInstance();
      expect(service1).toBe(service2);
    });
  });

  describe('lifecycle', () => {
    it('should start with stopped state', () => {
      const service = SearchServiceManager.getInstance();
      expect(service.isRunning()).toBe(false);
      expect(service.getState().status).toBe('stopped');
    });

    it('should start service successfully', async () => {
      const service = SearchServiceManager.getInstance();
      await service.start('/test/path', { skipInitialSync: true });

      expect(service.isRunning()).toBe(true);
      expect(service.getState().status).toBe('running');
      expect(service.getState().rootPath).toBe('/test/path');
      expect(service.getState().startedAt).toBeInstanceOf(Date);
    });

    it('should not start twice', async () => {
      const service = SearchServiceManager.getInstance();
      await service.start('/test/path', { skipInitialSync: true });
      await service.start('/test/path', { skipInitialSync: true }); // Second call should be no-op

      expect(service.isRunning()).toBe(true);
    });

    it('should stop service successfully', async () => {
      const service = SearchServiceManager.getInstance();
      await service.start('/test/path', { skipInitialSync: true });
      await service.stop();

      expect(service.isRunning()).toBe(false);
      expect(service.getState().status).toBe('stopped');
    });

    it('should handle stop when already stopped', async () => {
      const service = SearchServiceManager.getInstance();
      await service.stop(); // Should not throw
      expect(service.isRunning()).toBe(false);
    });

    it('should return SearchSystem when running', async () => {
      const service = SearchServiceManager.getInstance();
      expect(service.getSearchSystem()).toBeNull();

      await service.start('/test/path', { skipInitialSync: true });
      expect(service.getSearchSystem()).not.toBeNull();
    });

    it('should return null SearchSystem after stop', async () => {
      const service = SearchServiceManager.getInstance();
      await service.start('/test/path', { skipInitialSync: true });
      await service.stop();
      expect(service.getSearchSystem()).toBeNull();
    });
  });

  describe('state', () => {
    it('should track state correctly during lifecycle', async () => {
      const service = SearchServiceManager.getInstance();

      // Initial state
      let state = service.getState();
      expect(state.status).toBe('stopped');
      expect(state.rootPath).toBeNull();
      expect(state.startedAt).toBeNull();
      expect(state.error).toBeNull();

      // After start
      await service.start('/test/path', { skipInitialSync: true });
      state = service.getState();
      expect(state.status).toBe('running');
      expect(state.rootPath).toBe('/test/path');
      expect(state.startedAt).toBeInstanceOf(Date);

      // After stop
      await service.stop();
      state = service.getState();
      expect(state.status).toBe('stopped');
    });
  });

  describe('indexing progress', () => {
    it('should have idle progress initially', () => {
      const service = SearchServiceManager.getInstance();
      const progress = service.getIndexingProgress();

      expect(progress.status).toBe('idle');
      expect(progress.totalFiles).toBe(0);
      expect(progress.processedFiles).toBe(0);
      expect(progress.failedFiles).toBe(0);
    });

    it('should return copy of progress (not reference)', () => {
      const service = SearchServiceManager.getInstance();
      const progress1 = service.getIndexingProgress();
      const progress2 = service.getIndexingProgress();

      expect(progress1).not.toBe(progress2);
      expect(progress1).toEqual(progress2);
    });
  });

  describe('operations', () => {
    it('should throw when triggering sync while not running', async () => {
      const service = SearchServiceManager.getInstance();

      await expect(service.triggerSync()).rejects.toThrow(
        'Search service not running',
      );
    });

    it('should throw when reindexing while not running', async () => {
      const service = SearchServiceManager.getInstance();

      await expect(service.reindexFile('/test/file.txt')).rejects.toThrow(
        'Search service not running',
      );
    });

    it('should reindex file when running', async () => {
      const service = SearchServiceManager.getInstance();
      await service.start('/test/path', { skipInitialSync: true });

      const result = await service.reindexFile('/test/file.txt');
      expect(result).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should set error state on start failure', async () => {
      const { initializeSearchSystem } = await import('@thacio/auditaria-search');
      vi.mocked(initializeSearchSystem).mockRejectedValueOnce(
        new Error('Init failed'),
      );

      const service = SearchServiceManager.getInstance();

      await expect(
        service.start('/test/path', { skipInitialSync: true }),
      ).rejects.toThrow('Init failed');

      const state = service.getState();
      expect(state.status).toBe('error');
      expect(state.error).toBe('Init failed');
    });
  });
});

describe('Queue processing', () => {
  beforeEach(() => {
    SearchServiceManager.resetInstance();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const service = SearchServiceManager.getInstance();
    if (service.isRunning()) {
      await service.stop();
    }
    SearchServiceManager.resetInstance();
  });

  it('should start queue processor on service start', async () => {
    const service = SearchServiceManager.getInstance();
    await service.start('/test/path', { skipInitialSync: true });

    // Queue processor should be running (interval started)
    expect(service.isRunning()).toBe(true);
  });

  it('should stop queue processor on service stop', async () => {
    const service = SearchServiceManager.getInstance();
    await service.start('/test/path', { skipInitialSync: true });
    await service.stop();

    expect(service.isRunning()).toBe(false);
  });
});
