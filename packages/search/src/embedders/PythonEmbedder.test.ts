/**
 * Tests for PythonEmbedder.
 *
 * Note: Integration tests require Python 3.8+ with required packages installed.
 * Tests will be skipped if Python is not available.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { PythonEmbedder, createPythonEmbedder } from './PythonEmbedder.js';
import { detectPython } from './python-detection.js';

// Check if Python is available before running tests
let pythonAvailable = false;
let skipReason = '';

beforeAll(async () => {
  const result = await detectPython();
  pythonAvailable = result.available;
  if (!result.available) {
    skipReason = result.error ?? 'Python not available';
  }
});

describe('PythonEmbedder', () => {
  describe('properties', () => {
    it('should have correct default properties', () => {
      const embedder = new PythonEmbedder();

      expect(embedder.name).toBe('python-onnx');
      expect(embedder.modelId).toBe('Xenova/multilingual-e5-small');
      expect(embedder.dimensions).toBe(384);
      expect(embedder.maxTokens).toBe(512);
      expect(embedder.isMultilingual).toBe(true);
      expect(embedder.priority).toBe(90);
      expect(embedder.quantization).toBe('q8');
    });

    it('should allow custom model configuration', () => {
      const embedder = new PythonEmbedder({
        modelId: 'Xenova/multilingual-e5-base',
        quantization: 'fp16',
        batchSize: 32,
      });

      expect(embedder.modelId).toBe('Xenova/multilingual-e5-base');
      expect(embedder.dimensions).toBe(768);
      expect(embedder.quantization).toBe('fp16');
    });

    it('should not be ready before initialization', () => {
      const embedder = new PythonEmbedder();
      expect(embedder.isReady()).toBe(false);
    });
  });

  describe('factory function', () => {
    it('should create embedder with createPythonEmbedder', () => {
      const embedder = createPythonEmbedder();

      expect(embedder).toBeInstanceOf(PythonEmbedder);
      expect(embedder.name).toBe('python-onnx');
    });

    it('should pass config to createPythonEmbedder', () => {
      const embedder = createPythonEmbedder({
        modelId: 'Xenova/multilingual-e5-large',
        batchSize: 8,
      });

      expect(embedder.modelId).toBe('Xenova/multilingual-e5-large');
      expect(embedder.dimensions).toBe(1024);
    });
  });

  describe('batch size management', () => {
    it('should have default batch size of 16', () => {
      const embedder = new PythonEmbedder();
      expect(embedder.getCurrentBatchSize()).toBe(16);
    });

    it('should use configured batch size', () => {
      const embedder = new PythonEmbedder({ batchSize: 32 });
      expect(embedder.getCurrentBatchSize()).toBe(32);
    });

    it('should reset batch size', () => {
      const embedder = new PythonEmbedder({ batchSize: 24 });
      embedder.resetBatchSize();
      expect(embedder.getCurrentBatchSize()).toBe(24);
    });
  });
});

// Integration tests - require Python with dependencies
// Each test initializes its own embedder to avoid shared state issues
describe('PythonEmbedder Integration', () => {
  // Helper to create and initialize embedder
  async function createInitializedEmbedder(): Promise<PythonEmbedder | null> {
    if (!pythonAvailable) {
      return null;
    }

    const embedder = new PythonEmbedder();
    await embedder.initialize();
    return embedder;
  }

  describe('lifecycle', () => {
    it('should be ready after initialization', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      expect(embedder).not.toBeNull();
      expect(embedder!.isReady()).toBe(true);
      await embedder!.dispose();
    }, 60000);

    it('should not be ready after disposal', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      expect(embedder!.isReady()).toBe(true);

      await embedder!.dispose();
      expect(embedder!.isReady()).toBe(false);
    }, 60000);
  });

  describe('embed', () => {
    it('should generate embedding with correct dimensions', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      const embedding = await embedder!.embed('test text');

      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding).toHaveLength(384);

      await embedder!.dispose();
    }, 60000);

    it('should generate normalized embeddings', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      const embedding = await embedder!.embed('test text');

      // Check magnitude is approximately 1 (normalized)
      const magnitude = Math.sqrt(
        embedding.reduce((sum, val) => sum + val * val, 0),
      );
      expect(magnitude).toBeCloseTo(1, 3);

      await embedder!.dispose();
    }, 60000);

    it('should generate deterministic embeddings for same text', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();

      const embedding1 = await embedder!.embed('hello world');
      const embedding2 = await embedder!.embed('hello world');

      // Check each value is close
      for (let i = 0; i < embedding1.length; i++) {
        expect(embedding1[i]).toBeCloseTo(embedding2[i], 5);
      }

      await embedder!.dispose();
    }, 60000);
  });

  describe('embedBatch', () => {
    it('should return empty array for empty input', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      const embeddings = await embedder!.embedBatch([]);

      expect(embeddings).toEqual([]);

      await embedder!.dispose();
    }, 60000);

    it('should generate embeddings for multiple texts', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      const texts = ['text one', 'text two', 'text three'];
      const embeddings = await embedder!.embedBatch(texts);

      expect(embeddings).toHaveLength(3);
      embeddings.forEach((embedding) => {
        expect(embedding).toHaveLength(384);
      });

      await embedder!.dispose();
    }, 60000);
  });

  describe('embedQuery and embedDocument', () => {
    it('should add E5 prefixes', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();

      // embedQuery and embedDocument should produce different results than raw embed
      // because they add "query: " and "passage: " prefixes for E5 models
      const queryEmbedding = await embedder!.embedQuery('test');
      const docEmbedding = await embedder!.embedDocument('test');
      const rawEmbedding = await embedder!.embed('test');

      // Query and doc embeddings should differ from raw
      const querySim = cosineSimilarity(queryEmbedding, rawEmbedding);
      const docSim = cosineSimilarity(docEmbedding, rawEmbedding);

      expect(querySim).toBeLessThan(0.99);
      expect(docSim).toBeLessThan(0.99);

      await embedder!.dispose();
    }, 60000);
  });

  describe('embedWithDetails', () => {
    it('should return embedding with metadata', async () => {
      if (!pythonAvailable) {
        console.log(`Skipping: ${skipReason}`);
        return;
      }

      const embedder = await createInitializedEmbedder();
      const result = await embedder!.embedWithDetails('test text');

      expect(result.embedding).toHaveLength(384);
      expect(result.model).toBe('Xenova/multilingual-e5-small');
      expect(result.dimensions).toBe(384);
      expect(result.tokenCount).toBeGreaterThan(0);

      await embedder!.dispose();
    }, 60000);
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
