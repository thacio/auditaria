/**
 * Tests for RecursiveChunker.
 */

import { describe, it, expect } from 'vitest';
import {
  RecursiveChunker,
  createRecursiveChunker,
} from './RecursiveChunker.js';

describe('RecursiveChunker', () => {
  describe('basic chunking', () => {
    it('should have correct name and priority', () => {
      const chunker = new RecursiveChunker();
      expect(chunker.name).toBe('recursive');
      expect(chunker.priority).toBe(100);
    });

    it('should return empty array for empty text', async () => {
      const chunker = new RecursiveChunker();
      const chunks = await chunker.chunk('');
      expect(chunks).toEqual([]);
    });

    it('should return empty array for whitespace only', async () => {
      const chunker = new RecursiveChunker();
      const chunks = await chunker.chunk('   \n\n   ');
      expect(chunks).toEqual([]);
    });

    it('should return single chunk for small text', async () => {
      const chunker = new RecursiveChunker();
      const text = 'Hello world. This is a test.';
      const chunks = await chunker.chunk(text, { maxChunkSize: 1000 });

      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toBe(text);
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(text.length);
    });

    it('should split text at paragraph boundaries', async () => {
      const chunker = new RecursiveChunker();
      const text =
        'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
      const chunks = await chunker.chunk(text, {
        maxChunkSize: 30,
        chunkOverlap: 0,
      });

      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should not exceed max size
      chunks.forEach((chunk) => {
        expect(chunk.text.length).toBeLessThanOrEqual(30);
      });
    });

    it('should include token count in metadata', async () => {
      const chunker = new RecursiveChunker();
      const text = 'Hello world. This is a test.';
      const chunks = await chunker.chunk(text);

      expect(chunks[0].metadata.tokenCount).toBeDefined();
      expect(chunks[0].metadata.tokenCount).toBeGreaterThan(0);
    });
  });

  describe('overlap handling', () => {
    it('should create overlapping chunks', async () => {
      const chunker = new RecursiveChunker();
      const text =
        'A'.repeat(100) + '. ' + 'B'.repeat(100) + '. ' + 'C'.repeat(100);
      const chunks = await chunker.chunk(text, {
        maxChunkSize: 120,
        chunkOverlap: 20,
      });

      expect(chunks.length).toBeGreaterThan(1);
    });

    it('should throw for invalid overlap', async () => {
      const chunker = new RecursiveChunker();
      await expect(
        chunker.chunk('test', { maxChunkSize: 100, chunkOverlap: 150 }),
      ).rejects.toThrow();
    });
  });

  describe('section tracking', () => {
    it('should detect markdown headings', async () => {
      const chunker = new RecursiveChunker();
      const text =
        '# Introduction\n\nThis is the intro.\n\n## Details\n\nMore details here.';
      const chunks = await chunker.chunk(text, {
        maxChunkSize: 50,
        chunkOverlap: 10,
        trackSections: true,
      });

      // Should have detected at least one section
      const hasSection = chunks.some((c) => c.metadata.section !== undefined);
      expect(hasSection).toBe(true);
    });
  });

  describe('factory function', () => {
    it('should create chunker instance', () => {
      const chunker = createRecursiveChunker();
      expect(chunker).toBeInstanceOf(RecursiveChunker);
    });
  });
});
