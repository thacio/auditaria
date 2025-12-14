/**
 * Tests for ChunkerRegistry.
 */

import { describe, it, expect } from 'vitest';
import {
  ChunkerRegistry,
  createChunkerRegistry,
  createEmptyChunkerRegistry,
} from './ChunkerRegistry.js';
import { RecursiveChunker } from './RecursiveChunker.js';
import { FixedSizeChunker } from './FixedSizeChunker.js';

describe('ChunkerRegistry', () => {
  describe('registration', () => {
    it('should start empty', () => {
      const registry = new ChunkerRegistry();
      expect(registry.size).toBe(0);
      expect(registry.getAll()).toEqual([]);
    });

    it('should register a chunker', () => {
      const registry = new ChunkerRegistry();
      registry.register(new RecursiveChunker());

      expect(registry.size).toBe(1);
      expect(registry.get('recursive')).toBeDefined();
    });

    it('should auto-set default to first registered', () => {
      const registry = new ChunkerRegistry();
      registry.register(new RecursiveChunker());

      expect(registry.getDefaultName()).toBe('recursive');
    });

    it('should unregister a chunker', () => {
      const registry = new ChunkerRegistry();
      registry.register(new RecursiveChunker());

      const result = registry.unregister('recursive');
      expect(result).toBe(true);
      expect(registry.size).toBe(0);
    });
  });

  describe('default chunker', () => {
    it('should get default chunker', () => {
      const registry = createChunkerRegistry();
      const defaultChunker = registry.getDefault();

      expect(defaultChunker).toBeDefined();
      expect(defaultChunker?.name).toBe('recursive');
    });

    it('should set default chunker', () => {
      const registry = createChunkerRegistry();
      registry.setDefault('fixed');

      expect(registry.getDefaultName()).toBe('fixed');
    });

    it('should throw when setting non-existent default', () => {
      const registry = new ChunkerRegistry();
      expect(() => registry.setDefault('nonexistent')).toThrow();
    });
  });

  describe('chunking', () => {
    it('should chunk text with default chunker', async () => {
      const registry = createChunkerRegistry();
      const chunks = await registry.chunk('Hello world. This is a test.');

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].text).toBeDefined();
    });

    it('should chunk text with specific chunker', async () => {
      const registry = createChunkerRegistry();
      const chunks = await registry.chunkWith(
        'fixed',
        'Hello world. This is a test.',
      );

      expect(chunks.length).toBeGreaterThan(0);
    });

    it('should throw when chunking with non-existent chunker', async () => {
      const registry = createChunkerRegistry();
      await expect(registry.chunkWith('nonexistent', 'test')).rejects.toThrow();
    });

    it('should merge options with defaults', async () => {
      const registry = createChunkerRegistry();
      registry.updateDefaultOptions({ maxChunkSize: 500 });

      const chunks = await registry.chunk('A'.repeat(100));
      expect(chunks.length).toBe(1);
    });
  });

  describe('factory functions', () => {
    it('should create registry with default chunkers', () => {
      const registry = createChunkerRegistry();

      expect(registry.size).toBe(2);
      expect(registry.get('recursive')).toBeInstanceOf(RecursiveChunker);
      expect(registry.get('fixed')).toBeInstanceOf(FixedSizeChunker);
    });

    it('should create empty registry', () => {
      const registry = createEmptyChunkerRegistry();
      expect(registry.size).toBe(0);
    });
  });

  describe('options', () => {
    it('should get default options', () => {
      const registry = createChunkerRegistry();
      const options = registry.getDefaultOptions();

      expect(options.maxChunkSize).toBeDefined();
      expect(options.chunkOverlap).toBeDefined();
    });

    it('should update default options', () => {
      const registry = createChunkerRegistry();
      registry.updateDefaultOptions({ maxChunkSize: 500 });

      const options = registry.getDefaultOptions();
      expect(options.maxChunkSize).toBe(500);
    });
  });

  describe('clear', () => {
    it('should clear all chunkers', () => {
      const registry = createChunkerRegistry();
      registry.clear();

      expect(registry.size).toBe(0);
      expect(registry.getDefaultName()).toBeNull();
    });
  });
});
