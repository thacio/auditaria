import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SearchEventEmitter, createEventEmitter } from './EventEmitter.js';

describe('SearchEventEmitter', () => {
  let emitter: SearchEventEmitter;

  beforeEach(() => {
    emitter = createEventEmitter();
  });

  describe('on()', () => {
    it('should register a handler', () => {
      const handler = vi.fn();
      emitter.on('indexing:started', handler);

      expect(emitter.listenerCount('indexing:started')).toBe(1);
    });

    it('should allow multiple handlers for same event', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('indexing:started', handler1);
      emitter.on('indexing:started', handler2);

      expect(emitter.listenerCount('indexing:started')).toBe(2);
    });

    it('should return unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = emitter.on('indexing:started', handler);

      expect(emitter.listenerCount('indexing:started')).toBe(1);

      unsubscribe();

      expect(emitter.listenerCount('indexing:started')).toBe(0);
    });
  });

  describe('once()', () => {
    it('should register a one-time handler', async () => {
      const handler = vi.fn();
      emitter.once('indexing:started', handler);

      expect(emitter.listenerCount('indexing:started')).toBe(1);

      await emitter.emit('indexing:started', {
        documentId: '1',
        filePath: '/test.txt',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(emitter.listenerCount('indexing:started')).toBe(0);
    });

    it('should not call handler after first emit', async () => {
      const handler = vi.fn();
      emitter.once('indexing:started', handler);

      await emitter.emit('indexing:started', {
        documentId: '1',
        filePath: '/test.txt',
      });
      await emitter.emit('indexing:started', {
        documentId: '2',
        filePath: '/test2.txt',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should return unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = emitter.once('indexing:started', handler);

      expect(emitter.listenerCount('indexing:started')).toBe(1);

      unsubscribe();

      expect(emitter.listenerCount('indexing:started')).toBe(0);
    });
  });

  describe('off()', () => {
    it('should remove a specific handler', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('indexing:started', handler1);
      emitter.on('indexing:started', handler2);

      emitter.off('indexing:started', handler1);

      expect(emitter.listenerCount('indexing:started')).toBe(1);
    });

    it('should not throw when removing non-existent handler', () => {
      const handler = vi.fn();
      expect(() => emitter.off('indexing:started', handler)).not.toThrow();
    });
  });

  describe('emit()', () => {
    it('should call all handlers with data', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      emitter.on('indexing:started', handler1);
      emitter.on('indexing:started', handler2);

      const data = { documentId: '123', filePath: '/test.txt' };
      await emitter.emit('indexing:started', data);

      expect(handler1).toHaveBeenCalledWith(data);
      expect(handler2).toHaveBeenCalledWith(data);
    });

    it('should handle async handlers', async () => {
      const results: number[] = [];

      emitter.on('indexing:started', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        results.push(1);
      });

      emitter.on('indexing:started', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        results.push(2);
      });

      await emitter.emit('indexing:started', {
        documentId: '1',
        filePath: '/test.txt',
      });

      expect(results).toContain(1);
      expect(results).toContain(2);
    });

    it('should catch errors in handlers without throwing', async () => {
      const errorHandler = vi.fn().mockImplementation(() => {
        throw new Error('Handler error');
      });
      const successHandler = vi.fn();

      // Suppress console.error for this test
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // noop
      });

      emitter.on('indexing:started', errorHandler);
      emitter.on('indexing:started', successHandler);

      await expect(
        emitter.emit('indexing:started', {
          documentId: '1',
          filePath: '/test.txt',
        }),
      ).resolves.not.toThrow();

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should do nothing when no handlers registered', async () => {
      await expect(
        emitter.emit('indexing:started', {
          documentId: '1',
          filePath: '/test.txt',
        }),
      ).resolves.not.toThrow();
    });
  });

  describe('emitSync()', () => {
    it('should fire and forget', () => {
      const handler = vi.fn();
      emitter.on('indexing:started', handler);

      emitter.emitSync('indexing:started', {
        documentId: '1',
        filePath: '/test.txt',
      });

      // Handler may not have been called yet (async)
      // Just verify it doesn't throw
    });
  });

  describe('removeAllListeners()', () => {
    it('should remove all listeners for a specific event', () => {
      emitter.on('indexing:started', vi.fn());
      emitter.on('indexing:started', vi.fn());
      emitter.on('indexing:completed', vi.fn());

      emitter.removeAllListeners('indexing:started');

      expect(emitter.listenerCount('indexing:started')).toBe(0);
      expect(emitter.listenerCount('indexing:completed')).toBe(1);
    });

    it('should remove all listeners when no event specified', () => {
      emitter.on('indexing:started', vi.fn());
      emitter.on('indexing:completed', vi.fn());
      emitter.on('search:completed', vi.fn());

      emitter.removeAllListeners();

      expect(emitter.listenerCount('indexing:started')).toBe(0);
      expect(emitter.listenerCount('indexing:completed')).toBe(0);
      expect(emitter.listenerCount('search:completed')).toBe(0);
    });
  });

  describe('listenerCount()', () => {
    it('should return 0 for events with no listeners', () => {
      expect(emitter.listenerCount('indexing:started')).toBe(0);
    });

    it('should count both regular and once handlers', () => {
      emitter.on('indexing:started', vi.fn());
      emitter.once('indexing:started', vi.fn());

      expect(emitter.listenerCount('indexing:started')).toBe(2);
    });
  });

  describe('hasListeners()', () => {
    it('should return false when no listeners', () => {
      expect(emitter.hasListeners('indexing:started')).toBe(false);
    });

    it('should return true when listeners exist', () => {
      emitter.on('indexing:started', vi.fn());
      expect(emitter.hasListeners('indexing:started')).toBe(true);
    });
  });

  describe('createEventEmitter factory', () => {
    it('should create a new instance', () => {
      const emitter = createEventEmitter();
      expect(emitter).toBeInstanceOf(SearchEventEmitter);
    });

    it('should create independent instances', () => {
      const emitter1 = createEventEmitter();
      const emitter2 = createEventEmitter();

      emitter1.on('indexing:started', vi.fn());

      expect(emitter1.listenerCount('indexing:started')).toBe(1);
      expect(emitter2.listenerCount('indexing:started')).toBe(0);
    });
  });

  describe('type safety', () => {
    it('should enforce correct event data types', async () => {
      const handler = vi.fn();
      emitter.on('indexing:progress', handler);

      await emitter.emit('indexing:progress', {
        documentId: '123',
        stage: 'chunking',
        progress: 0.5,
      });

      expect(handler).toHaveBeenCalledWith({
        documentId: '123',
        stage: 'chunking',
        progress: 0.5,
      });
    });
  });
});
