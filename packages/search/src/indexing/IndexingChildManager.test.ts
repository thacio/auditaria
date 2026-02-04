/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  IndexingChildManager,
  type ChildManagerConfig,
} from './IndexingChildManager.js';
import type { DeepPartial, SearchSystemConfig } from '../config.js';

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Create a temporary test directory with sample files.
 */
async function createTestDirectory(
  fileCount: number,
  contentGenerator?: (index: number) => string,
): Promise<string> {
  const testDir = join(tmpdir(), `child-manager-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });

  // Create .auditaria directory for database
  await mkdir(join(testDir, '.auditaria'), { recursive: true });

  for (let i = 0; i < fileCount; i++) {
    const content =
      contentGenerator?.(i) ??
      `Test file ${i} content. This is a sample document for testing the child process indexing system.`;

    await writeFile(join(testDir, `file${i}.txt`), content);
  }

  return testDir;
}

/**
 * Clean up a test directory.
 */
async function cleanupTestDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Create a minimal search config for testing.
 */
function createTestConfig(): DeepPartial<SearchSystemConfig> {
  return {
    database: {
      path: '.auditaria/knowledge-base.db',
      inMemory: true,
      backupEnabled: false,
    },
    indexing: {
      useChildProcess: false, // Child will use in-process
      childProcessBatchSize: 10,
    },
    embeddings: {
      model: 'Xenova/multilingual-e5-small',
      quantization: 'q8',
      useWorkerThread: false, // Simpler for testing
    },
    ocr: {
      enabled: false,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('IndexingChildManager', () => {
  let testDir: string;
  let manager: IndexingChildManager | null = null;

  beforeEach(async () => {
    testDir = await createTestDirectory(0); // Start with empty dir
  });

  afterEach(async () => {
    if (manager) {
      try {
        await manager.stop();
      } catch {
        // Ignore stop errors
      }
      manager = null;
    }
    if (testDir) {
      await cleanupTestDirectory(testDir);
    }
  });

  describe('constructor and configuration', () => {
    it('should create manager with default config', () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
      );

      const status = manager.getStatus();
      expect(status.isRunning).toBe(false);
      expect(status.batchNumber).toBe(0);
      expect(status.childPid).toBeNull();
    });

    it('should create manager with custom config', () => {
      const config = createTestConfig();
      const customConfig: Partial<ChildManagerConfig> = {
        batchSize: 100,
        memoryThresholdMb: 2000,
        startupTimeoutMs: 60000,
        batchTimeoutMs: 1800000,
      };

      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
        customConfig,
      );

      // Manager created successfully
      expect(manager.getStatus().isRunning).toBe(false);
    });

    it('should use default values for unspecified config', () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
        { batchSize: 200 }, // Only override batchSize
      );

      // Should not throw and should have defaults for other values
      expect(manager.getStatus().isRunning).toBe(false);
    });
  });

  describe('getStatus', () => {
    it('should return correct initial status', () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
      );

      const status = manager.getStatus();

      expect(status).toEqual({
        isRunning: false,
        batchNumber: 0,
        childPid: null,
      });
    });
  });

  describe('stop', () => {
    it('should stop gracefully when not running', async () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
      );

      // Should not throw when stopping a non-running manager
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('event emitter', () => {
    it('should emit events through EventEmitter interface', () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
      );

      const events: string[] = [];

      manager.on('progress', () => {
        events.push('progress');
      });
      manager.on('batch:complete', () => {
        events.push('batch:complete');
      });
      manager.on('error', () => {
        events.push('error');
      });
      manager.on('child:spawned', () => {
        events.push('child:spawned');
      });
      manager.on('child:exited', () => {
        events.push('child:exited');
      });

      // Events are set up correctly (no throw)
      expect(events).toEqual([]);
    });

    it('should allow unsubscribing from events', () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
      );

      let callCount = 0;
      const unsubscribe = manager.on('progress', () => {
        callCount++;
      });

      // Unsubscribe
      unsubscribe();

      // Manually emitting would require accessing private methods,
      // so we just verify unsubscribe doesn't throw
      expect(callCount).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should throw when indexAll called while already running', async () => {
      const config = createTestConfig();
      manager = new IndexingChildManager(
        testDir,
        join(testDir, '.auditaria/knowledge-base.db'),
        config,
      );

      // Create a file to index
      await writeFile(join(testDir, 'test.txt'), 'test content');

      // Start first indexAll (don't await)
      const firstPromise = manager.indexAll({ force: false });

      // Give it a moment to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Try to start another - should throw
      await expect(manager.indexAll({ force: false })).rejects.toThrow(
        'Indexing already in progress',
      );

      // Clean up - stop the manager to cancel first operation
      await manager.stop();

      // Wait for first promise to settle (it may error due to stop)
      try {
        await firstPromise;
      } catch {
        // Expected - was stopped
      }
    }, 30000);
  });
});

describe('IndexingChildManager integration', () => {
  let testDir: string;
  let manager: IndexingChildManager | null = null;

  afterEach(async () => {
    if (manager) {
      try {
        await manager.stop();
      } catch {
        // Ignore stop errors
      }
      manager = null;
    }
    if (testDir) {
      await cleanupTestDirectory(testDir);
    }
  });

  it('should complete indexing with no files', async () => {
    testDir = await createTestDirectory(0);
    const config = createTestConfig();

    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 60000 },
    );

    const result = await manager.indexAll({ force: false });

    expect(result.indexed).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  }, 120000);

  it('should emit child:spawned and child:exited events', async () => {
    testDir = await createTestDirectory(0);
    const config = createTestConfig();

    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 60000 },
    );

    const spawnedEvents: Array<{ pid: number; batchNumber: number }> = [];
    const exitedEvents: Array<{
      pid: number;
      code: number | null;
      batchNumber: number;
    }> = [];

    manager.on('child:spawned', (event) => {
      spawnedEvents.push(event);
    });
    manager.on('child:exited', (event) => {
      exitedEvents.push(event);
    });

    await manager.indexAll({ force: false });

    // Should have spawned and exited at least one child
    expect(spawnedEvents.length).toBeGreaterThanOrEqual(1);
    expect(exitedEvents.length).toBeGreaterThanOrEqual(1);

    // Child should have a valid PID
    expect(spawnedEvents[0].pid).toBeGreaterThan(0);
    expect(spawnedEvents[0].batchNumber).toBe(1);

    // Child should have exited cleanly (code 0)
    expect(exitedEvents[0].code).toBe(0);
  }, 120000);

  it('should emit batch:complete event', async () => {
    testDir = await createTestDirectory(0);
    const config = createTestConfig();

    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 60000 },
    );

    const batchEvents: Array<{
      processed: number;
      failed: number;
      hasMore: boolean;
    }> = [];

    manager.on('batch:complete', (event) => {
      batchEvents.push({
        processed: event.processed,
        failed: event.failed,
        hasMore: event.hasMore,
      });
    });

    await manager.indexAll({ force: false });

    expect(batchEvents.length).toBeGreaterThanOrEqual(1);
    expect(batchEvents[0].hasMore).toBe(false); // No files, so no more work
  }, 120000);

  it('should report correct status during indexing', async () => {
    testDir = await createTestDirectory(0);
    const config = createTestConfig();

    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 60000 },
    );

    // Check status before
    let status = manager.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.batchNumber).toBe(0);

    // Start indexing (don't await)
    const indexPromise = manager.indexAll({ force: false });

    // Give it a moment to start
    await new Promise((resolve) => setTimeout(resolve, 500));

    // During indexing (may or may not have started child yet)
    status = manager.getStatus();
    // isRunning should be true while promise is pending
    // But child may have already finished for empty dir

    // Wait for completion
    await indexPromise;

    // After indexing
    status = manager.getStatus();
    expect(status.isRunning).toBe(false);
    expect(status.batchNumber).toBe(1); // One batch was processed
  }, 120000);
});

describe('IndexingChildManager with files', () => {
  let testDir: string;
  let manager: IndexingChildManager | null = null;

  afterEach(async () => {
    if (manager) {
      try {
        await manager.stop();
      } catch {
        // Ignore stop errors
      }
      manager = null;
    }
    if (testDir) {
      await cleanupTestDirectory(testDir);
    }
  });

  it('should index files and report progress', async () => {
    testDir = await createTestDirectory(3);
    const config = createTestConfig();

    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 120000 },
    );

    const progressEvents: Array<{ current: number; total: number }> = [];

    manager.on('progress', (event) => {
      progressEvents.push({ current: event.current, total: event.total });
    });

    const result = await manager.indexAll({ force: true });

    // Should have indexed the 3 files
    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.duration).toBeGreaterThan(0);

    // Should have received progress events
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
  }, 180000);

  it('should handle force reindex option', async () => {
    testDir = await createTestDirectory(2);
    const config = createTestConfig();

    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 120000 },
    );

    // First run with force
    const result1 = await manager.indexAll({ force: true });
    expect(result1.indexed).toBe(2);

    // Need new manager for second run (manager resets after indexAll)
    await manager.stop();
    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 120000 },
    );

    // Second run without force should find nothing new
    const result2 = await manager.indexAll({ force: false });
    expect(result2.indexed).toBe(0);

    // Third run with force should reindex all
    await manager.stop();
    manager = new IndexingChildManager(
      testDir,
      join(testDir, '.auditaria/knowledge-base.db'),
      config,
      { batchSize: 10, startupTimeoutMs: 120000 },
    );

    const result3 = await manager.indexAll({ force: true });
    expect(result3.indexed).toBe(2);
  }, 300000);
});
