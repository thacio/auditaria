/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect } from 'vitest';
import {
  getMemoryUsageMb,
  serializeMessage,
  parseMessage,
  type StartIndexingMessage,
  type BatchCompleteMessage,
  type ProgressMessage,
  type ErrorMessage,
  type ReadyMessage,
  type PongMessage,
} from './child-process-types.js';

describe('child-process-types', () => {
  describe('getMemoryUsageMb', () => {
    it('should return a positive number', () => {
      const memoryMb = getMemoryUsageMb();
      expect(typeof memoryMb).toBe('number');
      expect(memoryMb).toBeGreaterThan(0);
    });

    it('should return memory in megabytes (reasonable range)', () => {
      const memoryMb = getMemoryUsageMb();
      // Node.js process should use at least a few MB but less than 10GB
      expect(memoryMb).toBeGreaterThan(1);
      expect(memoryMb).toBeLessThan(10000);
    });

    it('should return an integer', () => {
      const memoryMb = getMemoryUsageMb();
      expect(Number.isInteger(memoryMb)).toBe(true);
    });
  });

  describe('serializeMessage', () => {
    it('should serialize StartIndexingMessage correctly', () => {
      const msg: StartIndexingMessage = {
        type: 'start_indexing',
        id: 'test-id-123',
        rootPath: '/test/path',
        databasePath: '/test/path/.auditaria/knowledge-base.db',
        config: {
          embeddings: { model: 'test-model' },
        },
        options: {
          force: true,
          maxDocuments: 100,
        },
      };

      const serialized = serializeMessage(msg);
      expect(typeof serialized).toBe('string');

      const parsed = JSON.parse(serialized);
      expect(parsed.type).toBe('start_indexing');
      expect(parsed.id).toBe('test-id-123');
      expect(parsed.rootPath).toBe('/test/path');
      expect(parsed.options.force).toBe(true);
      expect(parsed.options.maxDocuments).toBe(100);
    });

    it('should serialize BatchCompleteMessage correctly', () => {
      const msg: BatchCompleteMessage = {
        type: 'batch_complete',
        id: 'batch-123',
        stats: {
          processed: 50,
          failed: 2,
          duration: 5000,
          memoryUsageMb: 512,
        },
        hasMore: true,
      };

      const serialized = serializeMessage(msg);
      const parsed = JSON.parse(serialized);

      expect(parsed.type).toBe('batch_complete');
      expect(parsed.stats.processed).toBe(50);
      expect(parsed.stats.failed).toBe(2);
      expect(parsed.hasMore).toBe(true);
    });

    it('should serialize ProgressMessage correctly', () => {
      const msg: ProgressMessage = {
        type: 'progress',
        event: 'document:completed',
        data: { filePath: '/test/file.txt' },
        memoryUsageMb: 256,
        processed: 10,
        total: 100,
      };

      const serialized = serializeMessage(msg);
      const parsed = JSON.parse(serialized);

      expect(parsed.type).toBe('progress');
      expect(parsed.event).toBe('document:completed');
      expect(parsed.processed).toBe(10);
      expect(parsed.total).toBe(100);
    });

    it('should serialize ErrorMessage correctly', () => {
      const msg: ErrorMessage = {
        type: 'error',
        id: 'error-123',
        error: 'Test error message',
        fatal: true,
      };

      const serialized = serializeMessage(msg);
      const parsed = JSON.parse(serialized);

      expect(parsed.type).toBe('error');
      expect(parsed.error).toBe('Test error message');
      expect(parsed.fatal).toBe(true);
    });

    it('should serialize ReadyMessage correctly', () => {
      const msg: ReadyMessage = {
        type: 'ready',
        memoryUsageMb: 128,
      };

      const serialized = serializeMessage(msg);
      const parsed = JSON.parse(serialized);

      expect(parsed.type).toBe('ready');
      expect(parsed.memoryUsageMb).toBe(128);
    });

    it('should serialize PongMessage correctly', () => {
      const msg: PongMessage = {
        type: 'pong',
        id: 'ping-123',
        memoryUsageMb: 256,
      };

      const serialized = serializeMessage(msg);
      const parsed = JSON.parse(serialized);

      expect(parsed.type).toBe('pong');
      expect(parsed.id).toBe('ping-123');
    });
  });

  describe('parseMessage', () => {
    it('should parse ReadyMessage correctly', () => {
      const line = JSON.stringify({
        type: 'ready',
        memoryUsageMb: 100,
      });

      const msg = parseMessage(line);
      expect(msg.type).toBe('ready');
      expect((msg as ReadyMessage).memoryUsageMb).toBe(100);
    });

    it('should parse ProgressMessage correctly', () => {
      const line = JSON.stringify({
        type: 'progress',
        event: 'document:started',
        data: { filePath: '/test.txt' },
        memoryUsageMb: 200,
        processed: 5,
        total: 50,
      });

      const msg = parseMessage(line);
      expect(msg.type).toBe('progress');
      expect((msg as ProgressMessage).event).toBe('document:started');
      expect((msg as ProgressMessage).processed).toBe(5);
    });

    it('should parse BatchCompleteMessage correctly', () => {
      const line = JSON.stringify({
        type: 'batch_complete',
        id: 'test-id',
        stats: {
          processed: 100,
          failed: 5,
          duration: 10000,
          memoryUsageMb: 500,
        },
        hasMore: false,
      });

      const msg = parseMessage(line);
      expect(msg.type).toBe('batch_complete');
      expect((msg as BatchCompleteMessage).stats.processed).toBe(100);
      expect((msg as BatchCompleteMessage).hasMore).toBe(false);
    });

    it('should parse ErrorMessage correctly', () => {
      const line = JSON.stringify({
        type: 'error',
        error: 'Something went wrong',
        fatal: false,
      });

      const msg = parseMessage(line);
      expect(msg.type).toBe('error');
      expect((msg as ErrorMessage).error).toBe('Something went wrong');
      expect((msg as ErrorMessage).fatal).toBe(false);
    });

    it('should throw on invalid JSON', () => {
      expect(() => parseMessage('not valid json')).toThrow();
    });

    it('should handle empty data field in ProgressMessage', () => {
      const line = JSON.stringify({
        type: 'progress',
        event: 'sync:completed',
        data: null,
        memoryUsageMb: 150,
        processed: 0,
        total: 0,
      });

      const msg = parseMessage(line);
      expect(msg.type).toBe('progress');
      expect((msg as ProgressMessage).data).toBeNull();
    });
  });

  describe('message type discriminators', () => {
    it('should correctly identify message types', () => {
      const messages = [
        { type: 'ready', memoryUsageMb: 100 },
        {
          type: 'progress',
          event: 'document:completed',
          data: {},
          memoryUsageMb: 200,
          processed: 1,
          total: 10,
        },
        {
          type: 'batch_complete',
          id: '1',
          stats: { processed: 1, failed: 0, duration: 100, memoryUsageMb: 100 },
          hasMore: false,
        },
        { type: 'error', error: 'test', fatal: false },
        { type: 'pong', id: '1', memoryUsageMb: 100 },
      ];

      for (const msg of messages) {
        const serialized = serializeMessage(msg as never);
        const parsed = parseMessage(serialized);
        expect(parsed.type).toBe(msg.type);
      }
    });
  });
});
