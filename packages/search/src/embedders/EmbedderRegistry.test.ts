/**
 * Tests for EmbedderRegistry.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EmbedderRegistry } from './EmbedderRegistry.js';
import { MockEmbedder } from './TransformersJsEmbedder.js';

describe('EmbedderRegistry', () => {
  let registry: EmbedderRegistry;

  beforeEach(() => {
    registry = new EmbedderRegistry();
  });

  describe('register', () => {
    it('should register an embedder', () => {
      const embedder = new MockEmbedder();
      registry.register(embedder);

      expect(registry.has('mock')).toBe(true);
      expect(registry.get('mock')).toBe(embedder);
    });

    it('should set the embedder as default if it has highest priority', () => {
      const lowPriority = new MockEmbedder();
      (lowPriority as unknown as { priority: number }).priority = 10;
      (lowPriority as unknown as { name: string }).name = 'low';

      const highPriority = new MockEmbedder();
      (highPriority as unknown as { priority: number }).priority = 100;
      (highPriority as unknown as { name: string }).name = 'high';

      registry.register(lowPriority);
      expect(registry.getDefault()?.name).toBe('low');

      registry.register(highPriority);
      expect(registry.getDefault()?.name).toBe('high');
    });
  });

  describe('unregister', () => {
    it('should remove an embedder', () => {
      const embedder = new MockEmbedder();
      registry.register(embedder);
      registry.unregister('mock');

      expect(registry.has('mock')).toBe(false);
    });

    it('should update default when removing the default embedder', () => {
      const embedder1 = new MockEmbedder();
      (embedder1 as unknown as { name: string }).name = 'emb1';
      (embedder1 as unknown as { priority: number }).priority = 100;

      const embedder2 = new MockEmbedder();
      (embedder2 as unknown as { name: string }).name = 'emb2';
      (embedder2 as unknown as { priority: number }).priority = 50;

      registry.register(embedder2);
      registry.register(embedder1);

      expect(registry.getDefault()?.name).toBe('emb1');

      registry.unregister('emb1');

      expect(registry.getDefault()?.name).toBe('emb2');
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent embedder', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('should return all registered embedders', () => {
      const embedder1 = new MockEmbedder();
      (embedder1 as unknown as { name: string }).name = 'emb1';

      const embedder2 = new MockEmbedder();
      (embedder2 as unknown as { name: string }).name = 'emb2';

      registry.register(embedder1);
      registry.register(embedder2);

      const all = registry.getAll();
      expect(all).toHaveLength(2);
    });
  });

  describe('getNames', () => {
    it('should return all embedder names', () => {
      const embedder1 = new MockEmbedder();
      (embedder1 as unknown as { name: string }).name = 'emb1';

      const embedder2 = new MockEmbedder();
      (embedder2 as unknown as { name: string }).name = 'emb2';

      registry.register(embedder1);
      registry.register(embedder2);

      const names = registry.getNames();
      expect(names).toContain('emb1');
      expect(names).toContain('emb2');
    });
  });

  describe('size', () => {
    it('should return the number of registered embedders', () => {
      expect(registry.size).toBe(0);

      registry.register(new MockEmbedder());
      expect(registry.size).toBe(1);
    });
  });

  describe('initializeDefault', () => {
    it('should initialize the default embedder', async () => {
      const embedder = new MockEmbedder();
      registry.register(embedder);

      expect(embedder.isReady()).toBe(false);

      await registry.initializeDefault();

      expect(embedder.isReady()).toBe(true);
    });

    it('should throw if no embedders are registered', async () => {
      await expect(registry.initializeDefault()).rejects.toThrow(
        'No embedders registered',
      );
    });
  });

  describe('initialize', () => {
    it('should initialize a specific embedder', async () => {
      const embedder = new MockEmbedder();
      registry.register(embedder);

      await registry.initialize('mock');

      expect(embedder.isReady()).toBe(true);
    });

    it('should throw for non-existent embedder', async () => {
      await expect(registry.initialize('nonexistent')).rejects.toThrow(
        'Embedder not found: nonexistent',
      );
    });
  });

  describe('getAsEmbedder', () => {
    it('should return the default embedder as Embedder interface', async () => {
      const mockEmbedder = new MockEmbedder();
      registry.register(mockEmbedder);
      await mockEmbedder.initialize();

      const embedder = registry.getAsEmbedder();

      expect(embedder).toBeDefined();
      expect(embedder?.name).toBe('mock');
      expect(embedder?.dimensions).toBe(384);
      expect(embedder?.isReady()).toBe(true);
    });

    it('should return undefined if no embedders registered', () => {
      expect(registry.getAsEmbedder()).toBeUndefined();
    });
  });

  describe('disposeAll', () => {
    it('should dispose all embedders', async () => {
      const embedder1 = new MockEmbedder();
      (embedder1 as unknown as { name: string }).name = 'emb1';
      await embedder1.initialize();

      const embedder2 = new MockEmbedder();
      (embedder2 as unknown as { name: string }).name = 'emb2';
      await embedder2.initialize();

      registry.register(embedder1);
      registry.register(embedder2);

      expect(embedder1.isReady()).toBe(true);
      expect(embedder2.isReady()).toBe(true);

      await registry.disposeAll();

      expect(embedder1.isReady()).toBe(false);
      expect(embedder2.isReady()).toBe(false);
    });
  });
});
