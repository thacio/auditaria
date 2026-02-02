/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getMemoryUsageMb,
  getDetailedMemoryUsage,
  serializeMessage,
  parseMessage,
  generateMessageId,
  createPendingCall,
} from './supervisor-ipc-types.js';
import type {
  SupervisorCallMessage,
  SupervisorResultMessage,
} from './supervisor-ipc-types.js';

describe('Supervisor IPC Types', () => {
  describe('getMemoryUsageMb()', () => {
    it('should return positive integer', () => {
      const memoryMb = getMemoryUsageMb();
      expect(memoryMb).toBeGreaterThan(0);
      expect(Number.isInteger(memoryMb)).toBe(true);
    });
  });

  describe('getDetailedMemoryUsage()', () => {
    it('should return all memory fields', () => {
      const memory = getDetailedMemoryUsage();

      expect(memory).toHaveProperty('heapUsedMb');
      expect(memory).toHaveProperty('heapTotalMb');
      expect(memory).toHaveProperty('externalMb');
      expect(memory).toHaveProperty('rssMb');

      expect(memory.heapUsedMb).toBeGreaterThan(0);
      expect(memory.heapTotalMb).toBeGreaterThanOrEqual(memory.heapUsedMb);
      expect(memory.rssMb).toBeGreaterThan(0);
    });
  });

  describe('serializeMessage()', () => {
    it('should serialize call message to JSON', () => {
      const msg: SupervisorCallMessage = {
        type: 'supervisor_call',
        id: 'test-id',
        method: 'getStats',
        args: [],
      };

      const serialized = serializeMessage(msg);

      expect(typeof serialized).toBe('string');
      expect(JSON.parse(serialized)).toEqual(msg);
    });

    it('should serialize result message to JSON', () => {
      const msg: SupervisorResultMessage = {
        type: 'supervisor_result',
        id: 'test-id',
        success: true,
        result: { count: 42 },
      };

      const serialized = serializeMessage(msg);

      expect(typeof serialized).toBe('string');
      expect(JSON.parse(serialized)).toEqual(msg);
    });

    it('should handle complex nested objects', () => {
      const msg: SupervisorCallMessage = {
        type: 'supervisor_call',
        id: 'test-id',
        method: 'search',
        args: [{ query: 'test', options: { limit: 10, filters: { tags: ['a', 'b'] } } }],
      };

      const serialized = serializeMessage(msg);
      const parsed = JSON.parse(serialized);

      expect(parsed).toEqual(msg);
    });
  });

  describe('parseMessage()', () => {
    it('should parse valid JSON', () => {
      const msg: SupervisorResultMessage = {
        type: 'supervisor_result',
        id: 'test-id',
        success: true,
        result: { data: 'test' },
      };

      const parsed = parseMessage(JSON.stringify(msg));

      expect(parsed).toEqual(msg);
    });

    it('should return null for invalid JSON', () => {
      const parsed = parseMessage('not valid json');

      expect(parsed).toBeNull();
    });

    it('should return null for empty string', () => {
      const parsed = parseMessage('');

      expect(parsed).toBeNull();
    });

    it('should handle partial JSON', () => {
      const parsed = parseMessage('{ "type": "test"');

      expect(parsed).toBeNull();
    });
  });

  describe('generateMessageId()', () => {
    it('should generate unique IDs', () => {
      const ids = new Set<string>();

      for (let i = 0; i < 100; i++) {
        ids.add(generateMessageId());
      }

      expect(ids.size).toBe(100);
    });

    it('should generate valid UUID format', () => {
      const id = generateMessageId();

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('createPendingCall()', () => {
    it('should create pending call with promise', () => {
      let timeoutCalled = false;
      const { pendingCall, promise } = createPendingCall(
        'test-id',
        'getStats',
        1000,
        () => {
          timeoutCalled = true;
        },
      );

      expect(pendingCall.id).toBe('test-id');
      expect(pendingCall.method).toBe('getStats');
      expect(pendingCall.timeout).toBeDefined();
      expect(pendingCall.startTime).toBeLessThanOrEqual(Date.now());
      expect(promise).toBeInstanceOf(Promise);

      // Clean up timeout
      clearTimeout(pendingCall.timeout);
    });

    it('should call timeout callback after timeout', async () => {
      let timeoutCalled = false;
      const { pendingCall } = createPendingCall(
        'test-id',
        'getStats',
        10, // Very short timeout
        () => {
          timeoutCalled = true;
        },
      );

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(timeoutCalled).toBe(true);

      // Clean up
      clearTimeout(pendingCall.timeout);
    });

    it('should track start time', () => {
      const before = Date.now();
      const { pendingCall } = createPendingCall('test-id', 'getStats', 1000, () => {});
      const after = Date.now();

      expect(pendingCall.startTime).toBeGreaterThanOrEqual(before);
      expect(pendingCall.startTime).toBeLessThanOrEqual(after);

      // Clean up
      clearTimeout(pendingCall.timeout);
    });
  });
});
