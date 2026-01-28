/**
 * Types for text embedders.
 * Embedders generate vector representations of text for semantic search.
 */

// ============================================================================
// Embedding Result
// ============================================================================

/**
 * Result from generating an embedding.
 */
export interface EmbeddingResult {
  /** The embedding vector */
  embedding: number[];
  /** Model used to generate the embedding */
  model: string;
  /** Dimension of the embedding */
  dimensions: number;
  /** Approximate token count of the input */
  tokenCount?: number;
}

// ============================================================================
// Embedder Interface
// ============================================================================

/**
 * Interface for text embedders.
 * Re-export from indexing/types.ts for convenience.
 */
export { type Embedder } from '../indexing/types.js';

/**
 * Extended embedder interface with additional capabilities.
 */
export interface TextEmbedder {
  /** Unique name for this embedder */
  readonly name: string;
  /** Model identifier */
  readonly modelId: string;
  /** Embedding dimension size */
  readonly dimensions: number;
  /** Maximum tokens per input */
  readonly maxTokens: number;
  /** Whether the model supports multiple languages */
  readonly isMultilingual: boolean;
  /** Priority for registry selection (higher = preferred) */
  readonly priority: number;

  /**
   * Initialize the embedder (load model, etc.).
   * @param onProgress - Optional callback for download/load progress
   */
  initialize(onProgress?: ProgressCallback): Promise<void>;

  /**
   * Check if the embedder is ready to generate embeddings.
   */
  isReady(): boolean;

  /**
   * Generate embedding for a single text.
   * @param text - Input text
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts (batch).
   * More efficient than calling embed() multiple times.
   * @param texts - Array of input texts
   */
  embedBatch(texts: string[]): Promise<number[][]>;

  /**
   * Generate embedding for a search query.
   * May add special prefixes like "query:" for models that require it.
   * @param query - Search query text
   */
  embedQuery(query: string): Promise<number[]>;

  /**
   * Generate embedding for a document/passage.
   * May add special prefixes like "passage:" for models that require it.
   * @param text - Document/passage text
   */
  embedDocument(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple documents/passages (batch).
   * May add special prefixes like "passage:" for models that require it.
   * Uses automatic batch size fallback on failure.
   * @param texts - Array of document/passage texts
   */
  embedBatchDocuments?(texts: string[]): Promise<number[][]>;

  /**
   * Stream embeddings for multiple documents/passages.
   * Yields batches of embeddings for memory efficiency - prevents accumulation
   * of all embeddings in memory at once.
   * Optional - falls back to embedBatchDocuments if not implemented.
   * @param texts - Array of document/passage texts
   * @param batchSize - Optional batch size override (defaults to embedder's configured batch size)
   */
  embedBatchDocumentsStreaming?(
    texts: string[],
    batchSize?: number,
  ): AsyncGenerator<{ startIndex: number; embeddings: number[][] }>;

  /**
   * Get detailed embedding result with metadata.
   * @param text - Input text
   */
  embedWithDetails(text: string): Promise<EmbeddingResult>;

  /**
   * Release resources (unload model, etc.).
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Progress Callback
// ============================================================================

/**
 * Progress callback for model loading/downloading.
 */
export type ProgressCallback = (progress: ProgressInfo) => void;

/**
 * Progress information for model loading.
 */
export interface ProgressInfo {
  /** Current stage of loading */
  stage: 'download' | 'load' | 'ready';
  /** Progress percentage (0-100) */
  progress: number;
  /** Current file being downloaded (if applicable) */
  file?: string;
  /** Bytes loaded */
  loaded?: number;
  /** Total bytes */
  total?: number;
  /** Status message */
  message?: string;
}

// ============================================================================
// Embedder Configuration
// ============================================================================

/**
 * Supported device types for embedder execution.
 * - 'cpu': CPU execution (default, works everywhere)
 * - 'dml': DirectML on Windows (GPU acceleration)
 * - 'cuda': CUDA on Linux (GPU acceleration, requires CUDA toolkit)
 * - 'webgpu': WebGPU in browsers (not applicable to Node.js)
 * - 'wasm': WebAssembly (fallback)
 */
export type EmbedderDevice = 'cpu' | 'dml' | 'cuda' | 'webgpu' | 'wasm';

/**
 * Supported quantization/precision types.
 * - 'fp32': Full precision (slowest, most accurate)
 * - 'fp16': Half precision (fast on GPU, good accuracy)
 * - 'q8': 8-bit quantization (fast on CPU)
 * - 'q4': 4-bit quantization (fastest, lower accuracy)
 */
export type EmbedderQuantization = 'fp32' | 'fp16' | 'q8' | 'q4';

/**
 * Configuration for TransformersJS embedder.
 */
export interface TransformersJsEmbedderConfig {
  /** Model ID on HuggingFace (e.g., 'Xenova/multilingual-e5-small') */
  modelId?: string;
  /** Quantization type ('fp32', 'fp16', 'q8', 'q4') */
  quantization?: EmbedderQuantization;
  /** Device to run on ('cpu', 'dml', 'cuda', 'webgpu', 'wasm') */
  device?: EmbedderDevice;
  /** Cache directory for downloaded models */
  cacheDir?: string;
  /** Whether to normalize embeddings */
  normalize?: boolean;
  /** Pooling strategy ('mean', 'cls', 'max') */
  pooling?: 'mean' | 'cls' | 'max';
  /** Maximum sequence length (tokens) */
  maxLength?: number;
  /** Batch size for embedding operations. Default: 16 */
  batchSize?: number;
  /** Worker thread heap size in MB. Default: 4096 (4GB) */
  workerHeapSizeMb?: number;
}

// ============================================================================
// Embedder Events
// ============================================================================

/**
 * Events emitted by embedders.
 */
export interface EmbedderEvents {
  [key: string]: unknown;
  'model:downloading': { file: string; progress: number };
  'model:loading': { progress: number };
  'model:ready': undefined;
  'model:error': { error: Error };
  'embedding:started': { textCount: number };
  'embedding:progress': { current: number; total: number };
  'embedding:completed': { textCount: number; duration: number };
}
