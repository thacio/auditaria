/**
 * Tests for MockEmbedder.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MockEmbedder } from './TransformersJsEmbedder.js';
import type { WarningInfo } from './TransformersJsEmbedder.js';

describe('MockEmbedder', () => {
  let embedder: MockEmbedder;

  beforeEach(() => {
    embedder = new MockEmbedder();
  });

  describe('properties', () => {
    it('should have correct default properties', () => {
      expect(embedder.name).toBe('mock');
      expect(embedder.modelId).toBe('mock-model');
      expect(embedder.dimensions).toBe(384);
      expect(embedder.maxTokens).toBe(512);
      expect(embedder.isMultilingual).toBe(true);
      expect(embedder.priority).toBe(0);
    });

    it('should allow custom dimensions', () => {
      const customEmbedder = new MockEmbedder(768);
      expect(customEmbedder.dimensions).toBe(768);
    });
  });

  describe('lifecycle', () => {
    it('should not be ready before initialization', () => {
      expect(embedder.isReady()).toBe(false);
    });

    it('should be ready after initialization', async () => {
      await embedder.initialize();
      expect(embedder.isReady()).toBe(true);
    });

    it('should not be ready after disposal', async () => {
      await embedder.initialize();
      await embedder.dispose();
      expect(embedder.isReady()).toBe(false);
    });
  });

  describe('embed', () => {
    beforeEach(async () => {
      await embedder.initialize();
    });

    it('should generate embedding with correct dimensions', async () => {
      const embedding = await embedder.embed('test text');
      expect(embedding).toHaveLength(384);
    });

    it('should generate normalized embeddings', async () => {
      const embedding = await embedder.embed('test text');

      // Check magnitude is approximately 1
      const magnitude = Math.sqrt(
        embedding.reduce((sum, val) => sum + val * val, 0),
      );
      expect(magnitude).toBeCloseTo(1, 5);
    });

    it('should generate deterministic embeddings for same text', async () => {
      const embedding1 = await embedder.embed('hello world');
      const embedding2 = await embedder.embed('hello world');

      expect(embedding1).toEqual(embedding2);
    });

    it('should generate different embeddings for different texts', async () => {
      const embedding1 = await embedder.embed('hello world');
      const embedding2 = await embedder.embed('goodbye world');

      expect(embedding1).not.toEqual(embedding2);
    });
  });

  describe('embedBatch', () => {
    beforeEach(async () => {
      await embedder.initialize();
    });

    it('should return empty array for empty input', async () => {
      const embeddings = await embedder.embedBatch([]);
      expect(embeddings).toEqual([]);
    });

    it('should generate embeddings for multiple texts', async () => {
      const texts = ['text one', 'text two', 'text three'];
      const embeddings = await embedder.embedBatch(texts);

      expect(embeddings).toHaveLength(3);
      embeddings.forEach((embedding) => {
        expect(embedding).toHaveLength(384);
      });
    });

    it('should be equivalent to calling embed for each text', async () => {
      const texts = ['text one', 'text two'];
      const batchEmbeddings = await embedder.embedBatch(texts);

      for (let i = 0; i < texts.length; i++) {
        const singleEmbedding = await embedder.embed(texts[i]);
        expect(batchEmbeddings[i]).toEqual(singleEmbedding);
      }
    });
  });

  describe('embedQuery', () => {
    beforeEach(async () => {
      await embedder.initialize();
    });

    it('should add "query:" prefix', async () => {
      const queryEmbedding = await embedder.embedQuery('search term');
      const directEmbedding = await embedder.embed('query: search term');

      expect(queryEmbedding).toEqual(directEmbedding);
    });
  });

  describe('embedDocument', () => {
    beforeEach(async () => {
      await embedder.initialize();
    });

    it('should add "passage:" prefix', async () => {
      const docEmbedding = await embedder.embedDocument('document text');
      const directEmbedding = await embedder.embed('passage: document text');

      expect(docEmbedding).toEqual(directEmbedding);
    });
  });

  describe('embedWithDetails', () => {
    beforeEach(async () => {
      await embedder.initialize();
    });

    it('should return embedding with metadata', async () => {
      const result = await embedder.embedWithDetails('test text');

      expect(result.embedding).toHaveLength(384);
      expect(result.model).toBe('mock-model');
      expect(result.dimensions).toBe(384);
      expect(result.tokenCount).toBeGreaterThan(0);
    });

    it('should estimate token count based on character length', async () => {
      const shortText = 'hi';
      const longText =
        'This is a much longer piece of text that should have more tokens';

      const shortResult = await embedder.embedWithDetails(shortText);
      const longResult = await embedder.embedWithDetails(longText);

      expect(longResult.tokenCount!).toBeGreaterThan(shortResult.tokenCount!);
    });
  });

  describe('similarity', () => {
    beforeEach(async () => {
      await embedder.initialize();
    });

    it('should have high similarity for same text', async () => {
      const embedding1 = await embedder.embed('machine learning');
      const embedding2 = await embedder.embed('machine learning');

      const similarity = cosineSimilarity(embedding1, embedding2);
      expect(similarity).toBeCloseTo(1, 5);
    });

    it('should have lower similarity for different texts', async () => {
      const embedding1 = await embedder.embed('machine learning');
      const embedding2 = await embedder.embed('cooking recipes');

      const similarity = cosineSimilarity(embedding1, embedding2);
      expect(similarity).toBeLessThan(1);
    });
  });
});

/**
 * Calculate cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describe('MockEmbedder batch fallback', () => {
  it('should use configured batch size by default', async () => {
    const embedder = new MockEmbedder({ batchSize: 16 });
    await embedder.initialize();

    expect(embedder.getCurrentBatchSize()).toBe(16);
  });

  it('should reduce batch size on failure and warn', async () => {
    const warnings: WarningInfo[] = [];
    const embedder = new MockEmbedder({
      batchSize: 8,
      failUntilBatchSize: 2, // Fail until batch size <= 2
      onWarning: (warning) => warnings.push(warning),
    });
    await embedder.initialize();

    // Process 10 texts - will trigger fallbacks
    const texts = Array.from({ length: 10 }, (_, i) => `text ${i}`);
    const embeddings = await embedder.embedBatch(texts);

    // Should still return all embeddings despite fallback
    expect(embeddings).toHaveLength(10);

    // Should have warned about batch size reduction
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.type === 'batch_size_fallback')).toBe(true);

    // Batch size should have been reduced
    expect(embedder.getCurrentBatchSize()).toBeLessThanOrEqual(2);
  });

  it('should be able to reset batch size', async () => {
    const embedder = new MockEmbedder({
      batchSize: 16,
      failUntilBatchSize: 4,
    });
    await embedder.initialize();

    // Trigger batch reduction
    await embedder.embedBatch(['a', 'b', 'c', 'd', 'e']);
    expect(embedder.getCurrentBatchSize()).toBeLessThan(16);

    // Reset
    embedder.resetBatchSize();
    expect(embedder.getCurrentBatchSize()).toBe(16);
  });

  it('should successfully process after reducing to valid batch size', async () => {
    const warnings: WarningInfo[] = [];
    const embedder = new MockEmbedder({
      batchSize: 4,
      failUntilBatchSize: 1, // Fail until batch size <= 1, which is the minimum
      onWarning: (warning) => warnings.push(warning),
    });
    await embedder.initialize();

    // Process a single text - will reduce batch size but eventually succeed
    const embeddings = await embedder.embedBatch(['test']);

    expect(embeddings).toHaveLength(1);
    // Should have warned about fallback
    expect(warnings.some((w) => w.type === 'batch_size_fallback')).toBe(true);
    // Batch size should be at minimum
    expect(embedder.getCurrentBatchSize()).toBe(1);
  });

  it('should handle embedBatchDocuments with prefix', async () => {
    const embedder = new MockEmbedder({ batchSize: 5 });
    await embedder.initialize();

    const texts = ['doc1', 'doc2', 'doc3'];
    const embeddings = await embedder.embedBatchDocuments(texts);

    expect(embeddings).toHaveLength(3);

    // Verify prefixes are applied - embeddings should match embedDocument
    for (let i = 0; i < texts.length; i++) {
      const singleDoc = await embedder.embedDocument(texts[i]);
      expect(embeddings[i]).toEqual(singleDoc);
    }
  });
});
