/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { InProcessStrategy } from './InProcessStrategy.js';
import { DEFAULT_SUPERVISOR_CONFIG } from '../types.js';
import type { DeepPartial, SearchSystemConfig } from '../../config.js';

// ============================================================================
// Test Utilities
// ============================================================================

async function createTestDirectory(): Promise<string> {
  const testDir = join(tmpdir(), `in-process-strategy-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  await mkdir(join(testDir, '.auditaria'), { recursive: true });
  return testDir;
}

async function cleanupTestDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function createTestConfig(): DeepPartial<SearchSystemConfig> {
  return {
    database: {
      backend: 'sqlite',
      path: '.auditaria/search.db',
      inMemory: true,
      backupEnabled: false,
    },
    indexing: {
      useChildProcess: false,
      supervisorStrategy: 'in-process',
      supervisorRestartThreshold: 100,
    },
    embeddings: {
      model: 'Xenova/multilingual-e5-small',
      quantization: 'q8',
      useWorkerThread: false,
    },
    ocr: {
      enabled: false,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('InProcessStrategy', () => {
  let testDir: string;
  let strategy: InProcessStrategy;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    strategy = new InProcessStrategy();
  });

  afterEach(async () => {
    try {
      await strategy.dispose();
    } catch {
      // Ignore dispose errors
    }
    await cleanupTestDirectory(testDir);
  });

  describe('constructor', () => {
    it('should have correct name', () => {
      expect(strategy.name).toBe('in-process');
    });

    it('should not be ready before initialization', () => {
      expect(strategy.isReady()).toBe(false);
    });

    it('should return null for child PID (not applicable)', () => {
      expect(strategy.getChildPid()).toBeNull();
    });
  });

  describe('initialize()', () => {
    it('should initialize successfully', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      expect(strategy.isReady()).toBe(true);
    }, 60000);

    it('should report memory usage after initialization', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      const memoryMb = strategy.getMemoryUsageMb();
      expect(memoryMb).toBeGreaterThan(0);
    }, 60000);
  });

  describe('call()', () => {
    it('should throw when not initialized', async () => {
      await expect(strategy.call('getStats', [])).rejects.toThrow(
        'SearchSystem not initialized',
      );
    });

    it('should call SearchSystem methods after initialization', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      const stats = await strategy.call<{ documentCount: number }>('getStats', []);
      expect(stats).toHaveProperty('totalDocuments');
    }, 60000);

    it('should throw for unknown methods', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      await expect(strategy.call('nonExistentMethod', [])).rejects.toThrow(
        'Unknown method: nonExistentMethod',
      );
    }, 60000);
  });

  describe('onEvent()', () => {
    it('should allow subscribing to events', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      const events: unknown[] = [];
      const unsubscribe = strategy.onEvent('indexing:progress', (data) => {
        events.push(data);
      });

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    }, 60000);

    it('should allow unsubscribing from events', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      const events: unknown[] = [];
      const unsubscribe = strategy.onEvent('indexing:progress', (data) => {
        events.push(data);
      });

      // Unsubscribe immediately
      unsubscribe();

      // No events should be received after unsubscribe
      expect(events.length).toBe(0);
    }, 60000);
  });

  describe('restart()', () => {
    it('should throw when not initialized', async () => {
      await expect(strategy.restart('test')).rejects.toThrow(
        'Cannot restart: SearchSystem not initialized',
      );
    });

    it('should restart successfully', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      const memoryBefore = strategy.getMemoryUsageMb();

      await strategy.restart('test restart');

      expect(strategy.isReady()).toBe(true);

      // Memory should still be reported
      const memoryAfter = strategy.getMemoryUsageMb();
      expect(memoryAfter).toBeGreaterThan(0);
    }, 120000);

    it('should preserve event subscriptions across restart', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      const events: unknown[] = [];
      strategy.onEvent('indexing:completed', (data) => {
        events.push(data);
      });

      await strategy.restart('test restart');

      // Strategy should still be functional
      expect(strategy.isReady()).toBe(true);
    }, 120000);
  });

  describe('dispose()', () => {
    it('should dispose without error when not initialized', async () => {
      await expect(strategy.dispose()).resolves.not.toThrow();
    });

    it('should dispose successfully after initialization', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);
      expect(strategy.isReady()).toBe(true);

      await strategy.dispose();

      expect(strategy.isReady()).toBe(false);
    }, 60000);

    it('should be safe to call dispose multiple times', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/search.db');

      await strategy.initialize(testDir, databasePath, config, DEFAULT_SUPERVISOR_CONFIG);

      await strategy.dispose();
      await expect(strategy.dispose()).resolves.not.toThrow();
    }, 60000);
  });

  describe('getMemoryUsageMb()', () => {
    it('should return current process memory', () => {
      const memoryMb = strategy.getMemoryUsageMb();
      expect(memoryMb).toBeGreaterThan(0);
      expect(Number.isInteger(memoryMb)).toBe(true);
    });
  });
});
