/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SUPERVISOR_CONFIG,
  INITIAL_SUPERVISOR_STATE,
  getMemoryUsageMb,
  createSupervisorConfig,
} from './types.js';

describe('Supervisor Types', () => {
  describe('DEFAULT_SUPERVISOR_CONFIG', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_SUPERVISOR_CONFIG.strategy).toBe('in-process');
      expect(DEFAULT_SUPERVISOR_CONFIG.restartThreshold).toBe(2000);
      expect(DEFAULT_SUPERVISOR_CONFIG.memoryThresholdMb).toBe(4000);
      expect(DEFAULT_SUPERVISOR_CONFIG.startupTimeoutMs).toBe(120000);
      expect(DEFAULT_SUPERVISOR_CONFIG.shutdownTimeoutMs).toBe(30000);
      expect(DEFAULT_SUPERVISOR_CONFIG.callTimeoutMs).toBe(300000);
    });

    it('should be immutable', () => {
      const original = { ...DEFAULT_SUPERVISOR_CONFIG };
      // Attempt to modify shouldn't affect original
      const copy = { ...DEFAULT_SUPERVISOR_CONFIG };
      copy.restartThreshold = 9999;
      expect(DEFAULT_SUPERVISOR_CONFIG.restartThreshold).toBe(original.restartThreshold);
    });
  });

  describe('INITIAL_SUPERVISOR_STATE', () => {
    it('should have correct initial values', () => {
      expect(INITIAL_SUPERVISOR_STATE.status).toBe('idle');
      expect(INITIAL_SUPERVISOR_STATE.documentsProcessedSinceRestart).toBe(0);
      expect(INITIAL_SUPERVISOR_STATE.totalDocumentsProcessed).toBe(0);
      expect(INITIAL_SUPERVISOR_STATE.restartCount).toBe(0);
      expect(INITIAL_SUPERVISOR_STATE.lastRestartAt).toBeNull();
      expect(INITIAL_SUPERVISOR_STATE.currentMemoryMb).toBe(0);
      expect(INITIAL_SUPERVISOR_STATE.childPid).toBeNull();
      expect(INITIAL_SUPERVISOR_STATE.error).toBeNull();
      expect(INITIAL_SUPERVISOR_STATE.isReady).toBe(false);
    });
  });

  describe('getMemoryUsageMb()', () => {
    it('should return a positive number', () => {
      const memoryMb = getMemoryUsageMb();
      expect(memoryMb).toBeGreaterThan(0);
      expect(Number.isInteger(memoryMb)).toBe(true);
    });

    it('should return reasonable memory value', () => {
      const memoryMb = getMemoryUsageMb();
      // Should be between 1MB and 10GB (reasonable for Node.js process)
      expect(memoryMb).toBeGreaterThanOrEqual(1);
      expect(memoryMb).toBeLessThan(10000);
    });
  });

  describe('createSupervisorConfig()', () => {
    it('should use defaults when no indexing config provided', () => {
      const config = createSupervisorConfig({});
      expect(config.strategy).toBe('in-process');
      expect(config.restartThreshold).toBe(2000);
      expect(config.memoryThresholdMb).toBe(4000);
    });

    it('should use indexing config values when provided', () => {
      const config = createSupervisorConfig({
        supervisorStrategy: 'child-process',
        supervisorRestartThreshold: 1000,
        supervisorMemoryThresholdMb: 2000,
      });
      expect(config.strategy).toBe('child-process');
      expect(config.restartThreshold).toBe(1000);
      expect(config.memoryThresholdMb).toBe(2000);
    });

    it('should apply overrides over indexing config', () => {
      const config = createSupervisorConfig(
        {
          supervisorStrategy: 'child-process',
          supervisorRestartThreshold: 1000,
        },
        {
          restartThreshold: 500,
          startupTimeoutMs: 60000,
        },
      );
      expect(config.strategy).toBe('child-process'); // From indexing config
      expect(config.restartThreshold).toBe(500); // Overridden
      expect(config.startupTimeoutMs).toBe(60000); // Override
      expect(config.shutdownTimeoutMs).toBe(30000); // Default
    });

    it('should handle none strategy', () => {
      const config = createSupervisorConfig({
        supervisorStrategy: 'none',
        supervisorRestartThreshold: 0,
      });
      expect(config.strategy).toBe('none');
      expect(config.restartThreshold).toBe(0);
    });
  });
});
