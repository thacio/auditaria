/**
 * Text embedder using Transformers.js.
 * Runs embedding models locally using ONNX runtime.
 *
 * Features:
 * - Batch size fallback: When batch processing fails, halves batch size until success
 * - Warning callbacks: Reports when fallback is triggered
 * - Progress callbacks: Reports model loading and embedding progress
 */

import type {
  TextEmbedder,
  TransformersJsEmbedderConfig,
  ProgressCallback,
  EmbeddingResult,
  EmbedderDevice,
  EmbedderQuantization,
} from './types.js';
import type { Embedder } from '../indexing/types.js';
import { debugLog } from './gpu-detection.js';

// ============================================================================
// Constants
// ============================================================================

/** Default model for multilingual embeddings */
const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';

/** Model dimensions by model ID */
const MODEL_DIMENSIONS: Record<string, number> = {
  'Xenova/multilingual-e5-small': 384,
  'Xenova/multilingual-e5-base': 768,
  'Xenova/multilingual-e5-large': 1024,
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-mpnet-base-v2': 768,
};

/** Default max tokens */
const DEFAULT_MAX_TOKENS = 512;

/** Default batch size for embedding */
const DEFAULT_BATCH_SIZE = 32;

/** Minimum batch size before failing */
const MIN_BATCH_SIZE = 1;

// ============================================================================
// Warning Callback Type
// ============================================================================

/**
 * Callback for warning messages (e.g., batch size fallback).
 */
export type WarningCallback = (warning: WarningInfo) => void;

/**
 * Warning information structure.
 */
export interface WarningInfo {
  type: 'batch_size_fallback' | 'batch_failed';
  message: string;
  originalBatchSize?: number;
  newBatchSize?: number;
  error?: Error;
}

// ============================================================================
// TransformersJsEmbedder
// ============================================================================

/**
 * Extended configuration with batch settings.
 */
export interface TransformersJsEmbedderFullConfig
  extends TransformersJsEmbedderConfig {
  /** Initial batch size for batch embedding. Default: 32 */
  batchSize?: number;
  /** Callback for warnings (e.g., batch fallback). */
  onWarning?: WarningCallback;
}

/**
 * Embedder implementation using Transformers.js.
 * Supports multilingual E5 and other sentence transformer models.
 *
 * Features automatic batch size fallback when processing fails:
 * - Halves batch size on failure and retries
 * - Warns via callback when fallback is used
 * - Fails loudly when batch size reaches 1 and still fails
 */
export class TransformersJsEmbedder implements TextEmbedder, Embedder {
  readonly name = 'transformers-js';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxTokens: number;
  readonly isMultilingual: boolean;
  readonly priority = 100;

  /** The device this embedder is configured to use */
  readonly device: EmbedderDevice;
  /** The quantization this embedder is configured to use */
  readonly quantization: EmbedderQuantization;

  private config: Required<
    Omit<TransformersJsEmbedderFullConfig, 'onWarning'>
  > & { onWarning?: WarningCallback };
  private pipeline: unknown = null;
  private ready = false;
  private initializingPromise: Promise<void> | null = null;
  private currentBatchSize: number;
  private onWarning?: WarningCallback;

  constructor(config?: TransformersJsEmbedderFullConfig) {
    this.config = {
      modelId: config?.modelId ?? DEFAULT_MODEL_ID,
      quantization: config?.quantization ?? 'q8',
      device: config?.device ?? 'cpu',
      cacheDir: config?.cacheDir ?? (undefined as unknown as string),
      normalize: config?.normalize ?? true,
      pooling: config?.pooling ?? 'mean',
      maxLength: config?.maxLength ?? DEFAULT_MAX_TOKENS,
      batchSize: config?.batchSize ?? DEFAULT_BATCH_SIZE,
      onWarning: config?.onWarning,
    };

    this.modelId = this.config.modelId;
    this.dimensions = MODEL_DIMENSIONS[this.modelId] ?? 384;
    this.maxTokens = this.config.maxLength;
    this.isMultilingual = this.modelId.includes('multilingual');
    this.currentBatchSize = this.config.batchSize;
    this.onWarning = config?.onWarning;
    this.device = this.config.device;
    this.quantization = this.config.quantization;
  }

  /**
   * Set the warning callback.
   */
  setWarningCallback(callback: WarningCallback): void {
    this.onWarning = callback;
  }

  /**
   * Get the current effective batch size.
   */
  getCurrentBatchSize(): number {
    return this.currentBatchSize;
  }

  /**
   * Reset batch size to configured value.
   */
  resetBatchSize(): void {
    this.currentBatchSize = this.config.batchSize;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the embedder by loading the model.
   */
  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.ready) return;

    // Prevent concurrent initialization
    if (this.initializingPromise) {
      await this.initializingPromise;
      return;
    }

    this.initializingPromise = this.doInitialize(onProgress);

    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  private async doInitialize(onProgress?: ProgressCallback): Promise<void> {
    try {
      onProgress?.({
        stage: 'download',
        progress: 0,
        message: `Loading model ${this.modelId}...`,
      });

      // Dynamic import to avoid loading transformers.js until needed
      const transformers = await import('@huggingface/transformers');

      // Configure environment
      const env = transformers.env;
      if (this.config.cacheDir) {
        env.cacheDir = this.config.cacheDir;
      }
      // Disable remote models host if needed (use HuggingFace directly)
      env.allowRemoteModels = true;

      const deviceName = this.config.device;
      const dtypeName = this.config.quantization;

      onProgress?.({
        stage: 'load',
        progress: 20,
        message: `Initializing pipeline (device: ${deviceName}, dtype: ${dtypeName})...`,
      });

      debugLog(
        `Creating pipeline: model=${this.modelId}, device=${deviceName}, dtype=${dtypeName}`,
      );

      // Create feature extraction pipeline
      // Note: Type assertion needed because @huggingface/transformers types may not include all options
      const pipelineOptions = {
        // Device selection: 'cpu', 'cuda', 'dml' (DirectML), etc.
        device: deviceName,
        // Data type / quantization: 'fp32', 'fp16', 'q8', 'q4'
        dtype: dtypeName,
        progress_callback: (progressData: unknown) => {
          const data = progressData as {
            status?: string;
            progress?: number;
            file?: string;
            loaded?: number;
            total?: number;
          };

          if (data.status === 'progress' && onProgress) {
            const progressPct = Math.round((data.progress ?? 0) * 0.8) + 20;
            onProgress({
              stage: 'download',
              progress: progressPct,
              file: data.file,
              loaded: data.loaded,
              total: data.total,
              message: `Downloading ${data.file ?? 'model files'}...`,
            });
          }
        },
      } as Parameters<typeof transformers.pipeline>[2];

      this.pipeline = await transformers.pipeline(
        'feature-extraction',
        this.modelId,
        pipelineOptions,
      );

      debugLog(`Pipeline created successfully with device=${deviceName}`);

      this.ready = true;

      onProgress?.({
        stage: 'ready',
        progress: 100,
        message: 'Model loaded successfully',
      });
    } catch (error) {
      this.ready = false;
      throw new Error(
        `Failed to initialize TransformersJsEmbedder: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Check if the embedder is ready.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Dispose of the embedder and release resources.
   */
  async dispose(): Promise<void> {
    if (this.pipeline) {
      // Pipeline doesn't have explicit dispose, but we can clear the reference
      this.pipeline = null;
    }
    this.ready = false;
  }

  // -------------------------------------------------------------------------
  // Embedding Methods
  // -------------------------------------------------------------------------

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<number[]> {
    this.ensureReady();

    const pipelineFn = this.pipeline as (
      texts: string | string[],
      options?: { pooling?: string; normalize?: boolean },
    ) => Promise<{ tolist: () => number[][] }>;

    const result = await pipelineFn(text, {
      pooling: this.config.pooling,
      normalize: this.config.normalize,
    });

    return result.tolist()[0];
  }

  /**
   * Generate embeddings for multiple texts.
   * Uses batch processing with automatic fallback on failure.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.ensureReady();

    // Process in batches with fallback on failure
    const results: number[][] = [];
    let offset = 0;

    while (offset < texts.length) {
      const batchTexts = texts.slice(offset, offset + this.currentBatchSize);
      const batchResult = await this.processBatchWithFallback(batchTexts);
      results.push(...batchResult);
      offset += batchTexts.length;
    }

    return results;
  }

  /**
   * Process a batch with automatic fallback on failure.
   * Halves batch size on failure until batch size = 1.
   * Fails loudly when batch size 1 also fails.
   */
  private async processBatchWithFallback(texts: string[]): Promise<number[][]> {
    const pipelineFn = this.pipeline as (
      texts: string | string[],
      options?: { pooling?: string; normalize?: boolean },
    ) => Promise<{ tolist: () => number[][] }>;

    const currentBatch = texts;
    let localBatchSize = this.currentBatchSize;

    while (currentBatch.length > 0) {
      try {
        // Try processing the current batch
        const result = await pipelineFn(currentBatch, {
          pooling: this.config.pooling,
          normalize: this.config.normalize,
        });

        return result.tolist();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // If batch size is already at minimum, fail loudly
        if (localBatchSize <= MIN_BATCH_SIZE) {
          this.emitWarning({
            type: 'batch_failed',
            message: `Embedding batch failed at minimum batch size (1). Error: ${err.message}`,
            originalBatchSize: this.config.batchSize,
            newBatchSize: MIN_BATCH_SIZE,
            error: err,
          });
          throw new Error(
            `Embedding failed even with batch size 1: ${err.message}`,
          );
        }

        // Halve the batch size
        const newBatchSize = Math.max(
          MIN_BATCH_SIZE,
          Math.floor(localBatchSize / 2),
        );

        this.emitWarning({
          type: 'batch_size_fallback',
          message: `Embedding batch failed, reducing batch size from ${localBatchSize} to ${newBatchSize}. Error: ${err.message}`,
          originalBatchSize: localBatchSize,
          newBatchSize,
          error: err,
        });

        // Update the instance batch size for future calls
        this.currentBatchSize = newBatchSize;
        localBatchSize = newBatchSize;

        // If current batch is larger than new batch size, we need to split and process recursively
        if (currentBatch.length > newBatchSize) {
          const results: number[][] = [];
          for (let i = 0; i < currentBatch.length; i += newBatchSize) {
            const subBatch = currentBatch.slice(i, i + newBatchSize);
            const subResult = await this.processBatchWithFallback(subBatch);
            results.push(...subResult);
          }
          return results;
        }
        // Otherwise, retry with the same batch (now under the new size limit)
      }
    }

    return [];
  }

  /**
   * Emit a warning via the callback.
   */
  private emitWarning(warning: WarningInfo): void {
    if (this.onWarning) {
      try {
        this.onWarning(warning);
      } catch {
        // Ignore errors from warning callback
      }
    }
    // Also log to console for visibility
    console.warn(`[TransformersJsEmbedder] ${warning.message}`);
  }

  /**
   * Generate embedding for a search query.
   * For E5 models, adds "query:" prefix.
   */
  async embedQuery(query: string): Promise<number[]> {
    const prefixedQuery = this.isE5Model() ? `query: ${query}` : query;

    return this.embed(prefixedQuery);
  }

  /**
   * Generate embedding for a document/passage.
   * For E5 models, adds "passage:" prefix.
   */
  async embedDocument(text: string): Promise<number[]> {
    const prefixedText = this.isE5Model() ? `passage: ${text}` : text;

    return this.embed(prefixedText);
  }

  /**
   * Generate embeddings for multiple documents/passages.
   * For E5 models, adds "passage:" prefix to each.
   * Uses batch processing with automatic fallback on failure.
   */
  async embedBatchDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const prefixedTexts = this.isE5Model()
      ? texts.map((text) => `passage: ${text}`)
      : texts;

    return this.embedBatch(prefixedTexts);
  }

  /**
   * Generate embedding with detailed result.
   */
  async embedWithDetails(text: string): Promise<EmbeddingResult> {
    const embedding = await this.embed(text);

    return {
      embedding,
      model: this.modelId,
      dimensions: embedding.length,
      tokenCount: this.estimateTokens(text),
    };
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Ensure the embedder is ready.
   */
  private ensureReady(): void {
    if (!this.ready || !this.pipeline) {
      throw new Error(
        'TransformersJsEmbedder not initialized. Call initialize() first.',
      );
    }
  }

  /**
   * Check if using an E5 model that requires prefixes.
   */
  private isE5Model(): boolean {
    return this.modelId.toLowerCase().includes('e5');
  }

  /**
   * Rough estimate of token count.
   * Uses the common approximation of ~4 characters per token for English.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new TransformersJsEmbedder instance.
 */
export function createTransformersJsEmbedder(
  config?: TransformersJsEmbedderFullConfig,
): TransformersJsEmbedder {
  return new TransformersJsEmbedder(config);
}

// ============================================================================
// Mock Embedder for Testing
// ============================================================================

/**
 * Mock embedder configuration.
 */
export interface MockEmbedderConfig {
  /** Embedding dimensions. Default: 384 */
  dimensions?: number;
  /** Batch size for processing. Default: 32 */
  batchSize?: number;
  /** Callback for warnings. */
  onWarning?: WarningCallback;
  /** If set, embedBatch will fail until batch size <= this value. For testing fallback. */
  failUntilBatchSize?: number;
}

/**
 * Mock embedder for testing purposes.
 * Generates deterministic embeddings based on text hash.
 *
 * Can be configured to simulate batch failures for testing fallback logic.
 */
export class MockEmbedder implements TextEmbedder, Embedder {
  readonly name = 'mock';
  readonly modelId = 'mock-model';
  readonly dimensions: number;
  readonly maxTokens = 512;
  readonly isMultilingual = true;
  readonly priority = 0;

  private ready = false;
  private currentBatchSize: number;
  private readonly configuredBatchSize: number;
  private readonly onWarning?: WarningCallback;
  private readonly failUntilBatchSize: number;

  constructor(configOrDimensions?: number | MockEmbedderConfig) {
    if (typeof configOrDimensions === 'number') {
      this.dimensions = configOrDimensions;
      this.configuredBatchSize = 32;
      this.failUntilBatchSize = 0;
    } else {
      this.dimensions = configOrDimensions?.dimensions ?? 384;
      this.configuredBatchSize = configOrDimensions?.batchSize ?? 32;
      this.onWarning = configOrDimensions?.onWarning;
      this.failUntilBatchSize = configOrDimensions?.failUntilBatchSize ?? 0;
    }
    this.currentBatchSize = this.configuredBatchSize;
  }

  async initialize(_onProgress?: ProgressCallback): Promise<void> {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  async dispose(): Promise<void> {
    this.ready = false;
  }

  getCurrentBatchSize(): number {
    return this.currentBatchSize;
  }

  resetBatchSize(): void {
    this.currentBatchSize = this.configuredBatchSize;
  }

  async embed(text: string): Promise<number[]> {
    return this.generateMockEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Process in batches with fallback on failure
    const results: number[][] = [];
    let offset = 0;

    while (offset < texts.length) {
      const batchTexts = texts.slice(offset, offset + this.currentBatchSize);
      const batchResult = await this.processBatchWithFallback(batchTexts);
      results.push(...batchResult);
      offset += batchTexts.length;
    }

    return results;
  }

  private async processBatchWithFallback(texts: string[]): Promise<number[][]> {
    let localBatchSize = this.currentBatchSize;

    while (texts.length > 0) {
      // Simulate failure if batch size is larger than failUntilBatchSize
      if (
        this.failUntilBatchSize > 0 &&
        localBatchSize > this.failUntilBatchSize
      ) {
        const error = new Error(
          `Simulated batch failure (batch size ${localBatchSize} > ${this.failUntilBatchSize})`,
        );

        // If batch size is already at minimum, fail loudly
        if (localBatchSize <= MIN_BATCH_SIZE) {
          this.emitWarning({
            type: 'batch_failed',
            message: `Embedding batch failed at minimum batch size (1). Error: ${error.message}`,
            originalBatchSize: this.configuredBatchSize,
            newBatchSize: MIN_BATCH_SIZE,
            error,
          });
          throw error;
        }

        // Halve the batch size
        const newBatchSize = Math.max(
          MIN_BATCH_SIZE,
          Math.floor(localBatchSize / 2),
        );

        this.emitWarning({
          type: 'batch_size_fallback',
          message: `Embedding batch failed, reducing batch size from ${localBatchSize} to ${newBatchSize}. Error: ${error.message}`,
          originalBatchSize: localBatchSize,
          newBatchSize,
          error,
        });

        this.currentBatchSize = newBatchSize;
        localBatchSize = newBatchSize;

        // If current batch is larger than new batch size, split and process recursively
        if (texts.length > newBatchSize) {
          const results: number[][] = [];
          for (let i = 0; i < texts.length; i += newBatchSize) {
            const subBatch = texts.slice(i, i + newBatchSize);
            const subResult = await this.processBatchWithFallback(subBatch);
            results.push(...subResult);
          }
          return results;
        }
        // Otherwise, retry with the same batch
        continue;
      }

      // Success: generate embeddings
      return texts.map((text) => this.generateMockEmbedding(text));
    }

    return [];
  }

  private emitWarning(warning: WarningInfo): void {
    if (this.onWarning) {
      try {
        this.onWarning(warning);
      } catch {
        // Ignore errors from warning callback
      }
    }
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embed(`query: ${query}`);
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.embed(`passage: ${text}`);
  }

  async embedBatchDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const prefixedTexts = texts.map((text) => `passage: ${text}`);
    return this.embedBatch(prefixedTexts);
  }

  async embedWithDetails(text: string): Promise<EmbeddingResult> {
    return {
      embedding: await this.embed(text),
      model: this.modelId,
      dimensions: this.dimensions,
      tokenCount: Math.ceil(text.length / 4),
    };
  }

  /**
   * Generate a deterministic mock embedding based on text hash.
   */
  private generateMockEmbedding(text: string): number[] {
    const embedding: number[] = new Array(this.dimensions);

    // Simple hash-based generation for determinism
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }

    // Generate normalized vector
    let magnitude = 0;
    for (let i = 0; i < this.dimensions; i++) {
      // LCG-style pseudo-random from hash
      hash = (hash * 1103515245 + 12345) >>> 0;
      embedding[i] = (hash / 0xffffffff) * 2 - 1;
      magnitude += embedding[i] * embedding[i];
    }

    // Normalize
    magnitude = Math.sqrt(magnitude);
    for (let i = 0; i < this.dimensions; i++) {
      embedding[i] /= magnitude;
    }

    return embedding;
  }
}
