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
 * Configuration for TransformersJS embedder.
 */
export interface TransformersJsEmbedderConfig {
  /** Model ID on HuggingFace (e.g., 'Xenova/multilingual-e5-small') */
  modelId?: string;
  /** Quantization type ('fp32', 'fp16', 'q8', 'q4') */
  quantization?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Device to run on ('cpu', 'webgpu', 'wasm') */
  device?: 'cpu' | 'webgpu' | 'wasm';
  /** Cache directory for downloaded models */
  cacheDir?: string;
  /** Whether to normalize embeddings */
  normalize?: boolean;
  /** Pooling strategy ('mean', 'cls', 'max') */
  pooling?: 'mean' | 'cls' | 'max';
  /** Maximum sequence length (tokens) */
  maxLength?: number;
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
