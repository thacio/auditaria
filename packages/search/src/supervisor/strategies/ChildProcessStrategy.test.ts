/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { ChildProcessStrategy } from './ChildProcessStrategy.js';
import { DEFAULT_SUPERVISOR_CONFIG } from '../types.js';
import type { DeepPartial, SearchSystemConfig } from '../../config.js';

// ============================================================================
// Test Utilities
// ============================================================================

async function createTestDirectory(): Promise<string> {
  const testDir = join(tmpdir(), `child-process-strategy-test-${randomUUID()}`);
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
      path: '.auditaria/knowledge-base.db',
      inMemory: true,
      backupEnabled: false,
    },
    indexing: {
      useChildProcess: false, // Child uses in-process internally
      supervisorStrategy: 'child-process',
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

describe('ChildProcessStrategy', () => {
  let testDir: string;
  let strategy: ChildProcessStrategy;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    strategy = new ChildProcessStrategy();
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
      expect(strategy.name).toBe('child-process');
    });

    it('should not be ready before initialization', () => {
      expect(strategy.isReady()).toBe(false);
    });

    it('should return null for child PID before initialization', () => {
      expect(strategy.getChildPid()).toBeNull();
    });
  });

  describe('initialize()', () => {
    it('should initialize and spawn child process', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
      });

      expect(strategy.isReady()).toBe(true);
      expect(strategy.getChildPid()).toBeGreaterThan(0);
    }, 180000);

    it('should report memory usage after initialization', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
      });

      // Memory may be from last child report or current process
      const memoryMb = strategy.getMemoryUsageMb();
      expect(memoryMb).toBeGreaterThan(0);
    }, 180000);
  });

  describe('call()', () => {
    it('should throw when not ready', async () => {
      await expect(strategy.call('getStats', [])).rejects.toThrow(
        'Child process not ready',
      );
    });

    it('should call SearchSystem methods via IPC', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
        callTimeoutMs: 60000,
      });

      const stats = await strategy.call<{ documentCount: number }>('getStats', []);
      expect(stats).toHaveProperty('totalDocuments');
    }, 180000);

    it('should throw for unknown methods', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
        callTimeoutMs: 30000,
      });

      await expect(strategy.call('nonExistentMethod', [])).rejects.toThrow();
    }, 180000);
  });

  describe('onEvent()', () => {
    it('should allow subscribing to events before initialization', () => {
      const events: unknown[] = [];
      const unsubscribe = strategy.onEvent('indexing:progress', (data) => {
        events.push(data);
      });

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });

    it('should forward events from child process', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      const events: string[] = [];
      strategy.onEvent('indexing:completed', () => {
        events.push('indexing:completed');
      });

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
      });

      // Strategy initialized and subscribed
      expect(strategy.isReady()).toBe(true);
    }, 180000);
  });

  describe('restart()', () => {
    it('should restart by killing and respawning child', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
        shutdownTimeoutMs: 30000,
      });

      const pidBefore = strategy.getChildPid();
      expect(pidBefore).toBeGreaterThan(0);

      await strategy.restart('test restart');

      expect(strategy.isReady()).toBe(true);
      const pidAfter = strategy.getChildPid();
      expect(pidAfter).toBeGreaterThan(0);
      // PID should be different after restart
      expect(pidAfter).not.toBe(pidBefore);
    }, 300000);
  });

  describe('dispose()', () => {
    it('should dispose without error when not initialized', async () => {
      await expect(strategy.dispose()).resolves.not.toThrow();
    });

    it('should dispose and kill child process', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
      });

      expect(strategy.isReady()).toBe(true);
      expect(strategy.getChildPid()).toBeGreaterThan(0);

      await strategy.dispose();

      expect(strategy.isReady()).toBe(false);
      expect(strategy.getChildPid()).toBeNull();
    }, 180000);

    it('should be safe to call dispose multiple times', async () => {
      const config = createTestConfig();
      const databasePath = join(testDir, '.auditaria/knowledge-base.db');

      await strategy.initialize(testDir, databasePath, config, {
        ...DEFAULT_SUPERVISOR_CONFIG,
        startupTimeoutMs: 120000,
      });

      await strategy.dispose();
      await expect(strategy.dispose()).resolves.not.toThrow();
    }, 180000);
  });
});

describe('ChildProcessStrategy error handling', () => {
  let testDir: string;
  let strategy: ChildProcessStrategy;

  beforeEach(async () => {
    testDir = await createTestDirectory();
    strategy = new ChildProcessStrategy();
  });

  afterEach(async () => {
    try {
      await strategy.dispose();
    } catch {
      // Ignore dispose errors
    }
    await cleanupTestDirectory(testDir);
  });

  it('should reject pending calls on dispose', async () => {
    const config = createTestConfig();
    const databasePath = join(testDir, '.auditaria/knowledge-base.db');

    await strategy.initialize(testDir, databasePath, config, {
      ...DEFAULT_SUPERVISOR_CONFIG,
      startupTimeoutMs: 120000,
      callTimeoutMs: 60000,
    });

    // Start a call but don't wait for it
    // Add immediate .catch() to prevent unhandled rejection warning
    let rejected = false;
    const callPromise = strategy.call('getStats', []).catch(() => {
      rejected = true;
    });

    // Dispose immediately
    await strategy.dispose();

    // Wait for the promise to settle
    await callPromise;

    // The call should have been rejected
    expect(rejected).toBe(true);
  }, 180000);
});
