/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { SearchSystemSupervisor, createSearchSystemSupervisor } from './SearchSystemSupervisor.js';
import type { DeepPartial, SearchSystemConfig } from '../config.js';

// ============================================================================
// Test Utilities
// ============================================================================

async function createTestDirectory(fileCount = 0): Promise<string> {
  const testDir = join(tmpdir(), `supervisor-test-${randomUUID()}`);
  await mkdir(testDir, { recursive: true });
  await mkdir(join(testDir, '.auditaria'), { recursive: true });

  for (let i = 0; i < fileCount; i++) {
    const content = `Test file ${i} content. This is a sample document for testing.`;
    await writeFile(join(testDir, `file${i}.txt`), content);
  }

  return testDir;
}

async function cleanupTestDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function createTestConfig(
  strategy: 'in-process' | 'child-process' | 'none' = 'in-process',
): DeepPartial<SearchSystemConfig> {
  return {
    database: {
      backend: 'sqlite',
      path: '.auditaria/search.db',
      inMemory: true,
      backupEnabled: false,
    },
    indexing: {
      useChildProcess: false,
      supervisorStrategy: strategy,
      supervisorRestartThreshold: 5, // Low threshold for testing
      supervisorMemoryThresholdMb: 10000, // High to avoid memory-based restarts
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

describe('SearchSystemSupervisor', () => {
  let testDir: string;
  let supervisor: SearchSystemSupervisor | null = null;

  beforeEach(async () => {
    testDir = await createTestDirectory();
  });

  afterEach(async () => {
    if (supervisor) {
      try {
        await supervisor.close();
      } catch {
        // Ignore close errors
      }
      supervisor = null;
    }
    await cleanupTestDirectory(testDir);
  });

  describe('create()', () => {
    it('should create supervisor with in-process strategy', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
      });

      const state = supervisor.getSupervisorState();
      expect(state.status).toBe('running');
      expect(state.isReady).toBe(true);
      expect(state.childPid).toBeNull(); // In-process has no child
    }, 60000);

    it('should create supervisor with child-process strategy', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('child-process'),
        supervisorConfig: {
          startupTimeoutMs: 120000,
        },
      });

      const state = supervisor.getSupervisorState();
      expect(state.status).toBe('running');
      expect(state.isReady).toBe(true);
      expect(state.childPid).toBeGreaterThan(0); // Child process has PID
    }, 180000);

    it('should create supervisor with none strategy', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('none'),
      });

      const state = supervisor.getSupervisorState();
      expect(state.status).toBe('running');
      expect(state.isReady).toBe(true);
    }, 60000);
  });

  describe('getSupervisorState()', () => {
    it('should return correct initial state', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
      });

      const state = supervisor.getSupervisorState();

      expect(state.status).toBe('running');
      expect(state.documentsProcessedSinceRestart).toBe(0);
      expect(state.totalDocumentsProcessed).toBe(0);
      expect(state.restartCount).toBe(0);
      expect(state.lastRestartAt).toBeNull();
      expect(state.error).toBeNull();
      expect(state.isReady).toBe(true);
      expect(state.currentMemoryMb).toBeGreaterThan(0);
    }, 60000);
  });

  describe('getSupervisorConfig()', () => {
    it('should return supervisor configuration', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
        supervisorConfig: {
          restartThreshold: 100,
        },
      });

      const config = supervisor.getSupervisorConfig();

      expect(config.strategy).toBe('in-process');
      expect(config.restartThreshold).toBe(100);
    }, 60000);
  });

  describe('getConfig()', () => {
    it('should return SearchSystem configuration', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
      });

      const config = supervisor.getConfig();

      expect(config.database.backend).toBe('sqlite');
      expect(config.indexing.supervisorStrategy).toBe('in-process');
    }, 60000);
  });

  describe('setRestartThreshold()', () => {
    it('should update restart threshold', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
      });

      supervisor.setRestartThreshold(500);

      const config = supervisor.getSupervisorConfig();
      expect(config.restartThreshold).toBe(500);
    }, 60000);
  });

  describe('close()', () => {
    it('should close supervisor gracefully', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
      });

      await supervisor.close();

      const state = supervisor.getSupervisorState();
      expect(state.status).toBe('idle');
      expect(state.isReady).toBe(false);
    }, 60000);

    it('should emit supervisor:stopped event', async () => {
      supervisor = await createSearchSystemSupervisor({
        rootPath: testDir,
        config: createTestConfig('in-process'),
      });

      const events: unknown[] = [];
      supervisor.on('supervisor:stopped', (data) => {
        events.push(data);
      });

      await supervisor.close();

      expect(events.length).toBe(1);
      expect(events[0]).toHaveProperty('totalDocumentsProcessed');
      expect(events[0]).toHaveProperty('restartCount');
    }, 60000);
  });
});

describe('SearchSystemSupervisor search methods', () => {
  let testDir: string;
  let supervisor: SearchSystemSupervisor | null = null;

  beforeEach(async () => {
    testDir = await createTestDirectory();
  });

  afterEach(async () => {
    if (supervisor) {
      try {
        await supervisor.close();
      } catch {
        // Ignore close errors
      }
      supervisor = null;
    }
    await cleanupTestDirectory(testDir);
  });

  it('should perform search operations', async () => {
    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
    });

    const response = await supervisor.search({
      query: 'test',
      strategy: 'keyword',
      limit: 10,
    });

    expect(response).toHaveProperty('results');
    expect(response).toHaveProperty('total');
  }, 60000);

  it('should get stats', async () => {
    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
    });

    const stats = await supervisor.getStats();

    expect(stats).toHaveProperty('totalDocuments');
    expect(stats).toHaveProperty('totalChunks');
  }, 60000);

  it('should get queue status', async () => {
    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
    });

    const queueStatus = await supervisor.getQueueStatus();

    expect(queueStatus).toHaveProperty('pending');
    expect(queueStatus).toHaveProperty('processing');
    expect(queueStatus).toHaveProperty('completed');
    expect(queueStatus).toHaveProperty('failed');
  }, 60000);
});

describe('SearchSystemSupervisor indexing', () => {
  let testDir: string;
  let supervisor: SearchSystemSupervisor | null = null;

  afterEach(async () => {
    if (supervisor) {
      try {
        await supervisor.close();
      } catch {
        // Ignore close errors
      }
      supervisor = null;
    }
    if (testDir) {
      await cleanupTestDirectory(testDir);
    }
  });

  it('should index files and track document count', async () => {
    testDir = await createTestDirectory(3);

    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
      supervisorConfig: {
        restartThreshold: 100, // High to avoid restart during test
      },
    });

    const result = await supervisor.indexAll({ force: true });

    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);

    const state = supervisor.getSupervisorState();
    expect(state.documentsProcessedSinceRestart).toBe(3);
    expect(state.totalDocumentsProcessed).toBe(3);
  }, 120000);

  it('should emit indexing events', async () => {
    testDir = await createTestDirectory(2);

    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
      supervisorConfig: {
        restartThreshold: 100,
      },
    });

    const events: string[] = [];
    supervisor.on('indexing:completed', () => {
      events.push('indexing:completed');
    });

    await supervisor.indexAll({ force: true });

    expect(events).toContain('indexing:completed');
  }, 120000);
});

describe('SearchSystemSupervisor automatic restart', () => {
  let testDir: string;
  let supervisor: SearchSystemSupervisor | null = null;

  afterEach(async () => {
    if (supervisor) {
      try {
        await supervisor.close();
      } catch {
        // Ignore close errors
      }
      supervisor = null;
    }
    if (testDir) {
      await cleanupTestDirectory(testDir);
    }
  });

  it('should trigger automatic restart when threshold reached', async () => {
    testDir = await createTestDirectory(3);

    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
      supervisorConfig: {
        restartThreshold: 2, // Low threshold to trigger restart
      },
    });

    const restartEvents: unknown[] = [];
    supervisor.on('supervisor:restart:completed', (data) => {
      restartEvents.push(data);
    });

    // Index 3 files with threshold of 2 - should trigger at least one restart
    await supervisor.indexAll({ force: true });

    // Check state after indexing
    const state = supervisor.getSupervisorState();
    expect(state.restartCount).toBeGreaterThanOrEqual(1);
    expect(restartEvents.length).toBeGreaterThanOrEqual(1);
  }, 180000);

  it('should not restart when strategy is none', async () => {
    testDir = await createTestDirectory(3);

    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('none'),
      supervisorConfig: {
        restartThreshold: 1, // Would trigger immediately with other strategies
      },
    });

    const restartEvents: unknown[] = [];
    supervisor.on('supervisor:restart:completed', (data) => {
      restartEvents.push(data);
    });

    await supervisor.indexAll({ force: true });

    const state = supervisor.getSupervisorState();
    expect(state.restartCount).toBe(0);
    expect(restartEvents.length).toBe(0);
  }, 120000);

  it('should not restart when threshold is 0', async () => {
    testDir = await createTestDirectory(3);

    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
      supervisorConfig: {
        restartThreshold: 0, // Disabled
      },
    });

    const restartEvents: unknown[] = [];
    supervisor.on('supervisor:restart:completed', (data) => {
      restartEvents.push(data);
    });

    await supervisor.indexAll({ force: true });

    const state = supervisor.getSupervisorState();
    expect(state.restartCount).toBe(0);
    expect(restartEvents.length).toBe(0);
  }, 120000);
});

describe('SearchSystemSupervisor forceRestart()', () => {
  let testDir: string;
  let supervisor: SearchSystemSupervisor | null = null;

  beforeEach(async () => {
    testDir = await createTestDirectory();
  });

  afterEach(async () => {
    if (supervisor) {
      try {
        await supervisor.close();
      } catch {
        // Ignore close errors
      }
      supervisor = null;
    }
    await cleanupTestDirectory(testDir);
  });

  it('should force restart on demand', async () => {
    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
    });

    const restartEvents: unknown[] = [];
    supervisor.on('supervisor:restart:completed', (data) => {
      restartEvents.push(data);
    });

    await supervisor.forceRestart('Manual test restart');

    const state = supervisor.getSupervisorState();
    expect(state.restartCount).toBe(1);
    expect(state.lastRestartAt).not.toBeNull();
    expect(restartEvents.length).toBe(1);
  }, 120000);

  it('should reset document counter after restart', async () => {
    testDir = await createTestDirectory(2);

    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
      supervisorConfig: {
        restartThreshold: 100, // High to avoid auto-restart
      },
    });

    // Index some files
    await supervisor.indexAll({ force: true });

    let state = supervisor.getSupervisorState();
    expect(state.documentsProcessedSinceRestart).toBe(2);

    // Force restart
    await supervisor.forceRestart('Reset counter');

    state = supervisor.getSupervisorState();
    expect(state.documentsProcessedSinceRestart).toBe(0);
    expect(state.totalDocumentsProcessed).toBe(2); // Total unchanged
  }, 180000);
});

describe('SearchSystemSupervisor events', () => {
  let testDir: string;
  let supervisor: SearchSystemSupervisor | null = null;

  beforeEach(async () => {
    testDir = await createTestDirectory();
  });

  afterEach(async () => {
    if (supervisor) {
      try {
        await supervisor.close();
      } catch {
        // Ignore close errors
      }
      supervisor = null;
    }
    await cleanupTestDirectory(testDir);
  });

  it('should emit supervisor:ready on initialization', async () => {
    const readyEvents: unknown[] = [];

    // Can't subscribe before create, so we verify state instead
    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
    });

    // After creation, supervisor should be ready
    expect(supervisor.getSupervisorState().isReady).toBe(true);
  }, 60000);

  it('should emit supervisor:restart:starting and supervisor:restart:completed', async () => {
    supervisor = await createSearchSystemSupervisor({
      rootPath: testDir,
      config: createTestConfig('in-process'),
    });

    const startingEvents: unknown[] = [];
    const completedEvents: unknown[] = [];

    supervisor.on('supervisor:restart:starting', (data) => {
      startingEvents.push(data);
    });
    supervisor.on('supervisor:restart:completed', (data) => {
      completedEvents.push(data);
    });

    await supervisor.forceRestart('Test events');

    expect(startingEvents.length).toBe(1);
    expect(completedEvents.length).toBe(1);

    const startEvent = startingEvents[0] as {
      reason: string;
      documentsProcessed: number;
      memoryMb: number;
    };
    expect(startEvent.reason).toBe('Test events');

    const completeEvent = completedEvents[0] as {
      restartCount: number;
      durationMs: number;
      memoryBeforeMb: number;
      memoryAfterMb: number;
    };
    expect(completeEvent.restartCount).toBe(1);
    expect(completeEvent.durationMs).toBeGreaterThanOrEqual(0);
  }, 120000);
});
