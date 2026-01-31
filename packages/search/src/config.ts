/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// eslint-disable-next-line no-restricted-imports -- search package is independent of cli-core
import { homedir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Supported storage backends.
 *
 * - `'sqlite'`: SQLite with vectorlite and FTS5 (default)
 *   - Best for: Cross-platform compatibility, native performance
 *   - Uses: better-sqlite3, vectorlite extension, FTS5
 *
 * - `'pglite'`: PostgreSQL-compatible with pgvector
 *   - Best for: PostgreSQL compatibility, advanced features
 *   - Uses: PGlite (WASM), pgvector extension
 */
export type StorageBackend = 'sqlite' | 'pglite';

/** Array of all supported storage backends (for validation/UI) */
export const STORAGE_BACKENDS: readonly StorageBackend[] = [
  'sqlite',
  'pglite',
] as const;

/**
 * Hybrid search implementation strategies.
 *
 * - `'application'`: Application-level RRF fusion (default)
 *   - Runs semantic and keyword searches in parallel
 *   - Merges results using RRF in TypeScript code
 *   - Simpler, easier to debug, works with all backends
 *
 * - `'sql'`: SQL-based fusion with temp tables
 *   - Attempts to replicate PostgreSQL CTE approach
 *   - May have better performance for large result sets
 *   - More complex, backend-specific implementation
 */
export type HybridSearchStrategy = 'application' | 'sql';

/** Array of all supported hybrid search strategies (for validation/UI) */
export const HYBRID_SEARCH_STRATEGIES: readonly HybridSearchStrategy[] = [
  'application',
  'sql',
] as const;

export interface DatabaseConfig {
  /**
   * Storage backend to use. Default: 'sqlite'
   * - 'sqlite': SQLite with vectorlite and FTS5 (recommended)
   * - 'pglite': PostgreSQL-compatible with pgvector (legacy)
   */
  backend: StorageBackend;
  /** Path to the database file. Default: .auditaria/search.db */
  path: string;
  /** Whether to use in-memory database (for testing). Default: false */
  inMemory: boolean;
  /** Enable automatic backups on close and during indexing. Default: true */
  backupEnabled: boolean;
}

export interface IndexingConfig {
  /** Additional paths to ignore beyond .gitignore */
  ignorePaths: string[];
  /** If set, only index these paths (relative to root) */
  includePaths: string[];
  /** File extensions to index (with leading dot) */
  fileTypes: string[];
  /** Skip files larger than this (in bytes). Default: 50MB */
  maxFileSize: number;
  /** Enable OCR processing. Default: true */
  ocrEnabled: boolean;
  /** OCR processing priority. Default: 'low' */
  ocrPriority: 'high' | 'low' | 'skip';
  /** Respect .gitignore file. Default: true */
  respectGitignore: boolean;
  /** Number of data preparation workers (parse/chunk). Default: 2 */
  prepareWorkers: number;
  /** Number of files to keep prepared ahead for embedding. Default: 4 */
  preparedBufferSize: number;

  // Child process options for WASM memory management
  /**
   * Use child process for indexing to prevent WASM memory accumulation. Default: true
   * When enabled, indexing runs in a child process that exits after each batch,
   * completely releasing all WASM memory (which cannot shrink in-process).
   */
  useChildProcess: boolean;
  /**
   * Documents to process per child batch before respawning. Default: 500
   * Lower values = more frequent memory release but more overhead.
   */
  childProcessBatchSize: number;
  /**
   * Memory threshold (MB) for early child respawn. Default: 3000
   * If child memory exceeds this, it will exit early to release memory.
   */
  childProcessMemoryThresholdMb: number;
}

export interface ChunkingConfig {
  /** Chunking strategy. Default: 'recursive' */
  strategy: 'recursive' | 'semantic' | 'fixed';
  /** Maximum chunk size in characters. Default: 1000 */
  maxChunkSize: number;
  /** Overlap between chunks in characters. Default: 200 */
  chunkOverlap: number;
  /** Preserve sentence boundaries. Default: true */
  preserveSentences: boolean;
  /** Preserve paragraph boundaries. Default: true */
  preserveParagraphs: boolean;
}

export interface EmbeddingsConfig {
  /** Model identifier for Transformers.js. Default: 'Xenova/multilingual-e5-small' */
  model: string;
  /** Batch size for embedding generation. Default: 10 */
  batchSize: number;
  /** Embedding dimensions (must match model). Default: 384 */
  dimensions: number;
  /** Prefix for query embeddings (E5 models need this). Default: 'query: ' */
  queryPrefix: string;
  /** Prefix for document embeddings. Default: 'passage: ' */
  documentPrefix: string;
  /**
   * Use worker thread for embeddings. Default: true
   * When enabled, ML inference runs in a separate thread, keeping the CLI responsive.
   * Set to false to run embeddings on the main thread (legacy behavior).
   */
  useWorkerThread: boolean;
  /**
   * Device for embeddings. Default: 'auto'
   * - 'auto': Automatically detect best device (DirectML on Windows, CUDA on Linux, CPU on macOS)
   * - 'cpu': Force CPU execution
   * - 'dml': Force DirectML (Windows only)
   * - 'cuda': Force CUDA (Linux only, requires CUDA toolkit)
   */
  device: 'auto' | 'cpu' | 'dml' | 'cuda';
  /**
   * Quantization/precision for embeddings. Default: 'q8'
   * - 'auto': Use fp16 for GPU, q8 for CPU
   * - 'fp32': Full precision (slowest, most accurate)
   * - 'fp16': Half precision (fast on GPU)
   * - 'q8': 8-bit quantization (fast on CPU, recommended)
   * - 'q4': 4-bit quantization (fastest, lower accuracy)
   *
   * Benchmarks show Q8 provides identical search quality to FP16
   * (0.9996 rank correlation) while being 2.2x faster on CPU.
   */
  quantization: 'auto' | 'fp32' | 'fp16' | 'q8' | 'q4';
  /**
   * Prefer GPU for indexing operations. Default: false
   * When enabled, indexing will use GPU acceleration if available.
   * Search queries always use CPU for simplicity.
   * If GPU initialization fails, silently falls back to CPU.
   *
   * NOTE: Benchmarks show CPU with Q8 is 6.5x faster than GPU (DirectML)
   * for small embedding models like multilingual-e5-small due to
   * CPU-GPU transfer overhead. GPU only benefits larger models.
   */
  preferGpuForIndexing: boolean;
  /**
   * Maximum heap size for the embedding worker thread in MB. Default: 4096 (4GB)
   * Worker threads don't inherit NODE_OPTIONS from the main process,
   * so this must be set explicitly. Increase for large indexing jobs.
   * Common values: 2048 (2GB), 4096 (4GB), 8192 (8GB), 16384 (16GB)
   */
  workerHeapSizeMb: number;
  /**
   * Prefer Python embedder over Node.js embedder. Default: false
   * When enabled and Python 3.8+ is available with required packages,
   * embeddings will be generated using Python's ONNX runtime instead of
   * Node.js Transformers.js. Both produce IDENTICAL embeddings.
   *
   * Benefits of Python embedder:
   * - Better memory management for large indexing jobs
   * - More mature ML ecosystem
   * - Potentially better performance for some configurations
   *
   * Requirements:
   * - Python 3.8+
   * - pip install onnxruntime transformers numpy huggingface_hub
   *
   * Falls back to Node.js if Python is not available.
   */
  preferPythonEmbedder: boolean;
  /**
   * Cache directory for downloaded models. Default: ~/.auditaria/models
   * Using a fixed path in the user's home directory ensures models are
   * shared across projects and consistent regardless of runtime (node/bun).
   */
  cacheDir: string;
}

export interface SearchConfig {
  /** Default number of results. Default: 10 */
  defaultLimit: number;
  /** Default search strategy. Default: 'hybrid' */
  defaultStrategy: 'hybrid' | 'semantic' | 'keyword';
  /** Weight for semantic search in hybrid mode (0-1). Default: 0.5 */
  semanticWeight: number;
  /** Weight for keyword search in hybrid mode (0-1). Default: 0.5 */
  keywordWeight: number;
  /** RRF constant k. Default: 60 */
  rrfK: number;
  /**
   * Hybrid search implementation strategy. Default: 'application'
   * - 'application': Run semantic/keyword in parallel, merge with RRF in code
   * - 'sql': Use SQL temp tables to compute RRF (PostgreSQL CTE-style)
   */
  hybridStrategy: HybridSearchStrategy;
}

/**
 * Supported vector index types.
 *
 * - `'hnsw'`: Hierarchical Navigable Small World
 *   - Best for: High query throughput, high recall requirements
 *   - Trade-off: Higher memory usage (2-3x vector size), slower build time
 *
 * - `'ivfflat'`: Inverted File with Flat compression
 *   - Best for: Memory-constrained environments, large datasets
 *   - Trade-off: Slower queries (tunable via probes), requires data for index creation
 *
 * - `'none'`: No index (exact search)
 *   - Best for: Small datasets (<10k vectors), maximum accuracy
 *   - Trade-off: O(n) search time, not suitable for large datasets
 */
export type VectorIndexType = 'hnsw' | 'ivfflat' | 'none';

/** Array of all supported vector index types (for validation/UI) */
export const VECTOR_INDEX_TYPES: readonly VectorIndexType[] = [
  'hnsw',
  'ivfflat',
  'none',
] as const;

export interface VectorIndexConfig {
  /**
   * Index type for vector similarity search. Default: 'hnsw'
   * - 'hnsw': Hierarchical Navigable Small World - fast queries, higher memory
   * - 'ivfflat': Inverted File Flat - lower memory, faster build, tunable recall via probes
   * - 'none': No index - exact search (slow for large datasets)
   */
  type: VectorIndexType;
  /**
   * Defer index creation until after bulk indexing completes. Default: true
   * When true:
   * - Index is NOT created during initialize()
   * - Searches use sequential scan during indexing (slower but works)
   * - Index is created after indexAll() completes
   * - Better memory usage and faster bulk indexing
   * When false:
   * - Index is created immediately in initialize()
   * - HNSW: each insert updates index (overhead per insert)
   * - IVFFlat: new rows go to heap, need manual REINDEX
   */
  deferIndexCreation?: boolean;
  /**
   * Whether to create the vector index at all. Default: true
   * When false:
   * - No index is ever created, regardless of 'type' setting
   * - All searches use brute force (sequential scan)
   * - Useful if index creation crashes or for small databases (<50k vectors)
   * - The 'type' setting is preserved so you can re-enable later
   * This setting is stored in metadata, so it persists with the database.
   */
  createIndex?: boolean;
  /**
   * Use half-precision vectors (halfvec). Reduces storage by 50%. Default: false
   * Near-identical accuracy for most use cases. Works with both HNSW and IVFFlat.
   * Note: No conflict with Q8 quantization - Q8 affects model inference,
   * halfvec affects database storage.
   */
  useHalfVec: boolean;

  // HNSW parameters
  /**
   * HNSW: Max edges per node (m parameter). Default: 16
   * Higher = better recall, more memory. Typical range: 8-64.
   */
  hnswM?: number;
  /**
   * HNSW: Construction effort (ef_construction). Default: 64
   * Higher = better index quality, slower build. Typical range: 32-256.
   */
  hnswEfConstruction?: number;

  // IVFFlat parameters
  /**
   * IVFFlat: Number of lists/clusters. Default: 'auto'
   * - 'auto': Calculated from row count (rows/1000 for <1M, sqrt(rows) for >1M)
   * - number: Fixed number of lists
   */
  ivfflatLists?: number | 'auto';
  /**
   * IVFFlat: Probes for search (clusters to search). Default: 40
   * Higher = better recall, slower search. Start with sqrt(lists) or 40.
   * This is set before each query via SET ivfflat.probes.
   */
  ivfflatProbes?: number;
}

export interface LoggingConfig {
  /** Enable debug logging. Default: false */
  enabled: boolean;
  /** Log file path. Default: undefined (no file logging) */
  filePath?: string;
  /** Log to console. Default: true */
  console: boolean;
  /** Include memory stats in logs. Default: true when enabled */
  includeMemory: boolean;
}

export interface OcrConfig {
  /** Enable OCR processing. Default: true */
  enabled: boolean;
  /** Maximum concurrent OCR jobs. Default: 1 */
  concurrency: number;
  /** Maximum retry attempts for failed OCR jobs. Default: 3 */
  maxRetries: number;
  /** Delay between retries in milliseconds. Default: 5000 */
  retryDelay: number;
  /** Process OCR only after main indexing queue is empty. Default: true */
  processAfterMainQueue: boolean;
  /**
   * Automatically detect script/language before OCR. Default: true
   * When enabled, uses Tesseract OSD to detect the writing system and
   * selects appropriate languages automatically. This provides better
   * accuracy for multilingual documents but adds ~2-3 seconds overhead.
   * Downloads required language data automatically on first use.
   */
  autoDetectLanguage: boolean;
  /** Default languages for OCR (ISO 639-1 codes). Default: ['en'] */
  defaultLanguages: string[];
  /** Minimum confidence threshold for OCR results (0-1). Default: 0.5 */
  minConfidence: number;
}

export interface SearchSystemConfig {
  database: DatabaseConfig;
  indexing: IndexingConfig;
  chunking: ChunkingConfig;
  embeddings: EmbeddingsConfig;
  search: SearchConfig;
  ocr: OcrConfig;
  vectorIndex: VectorIndexConfig;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = {
  backend: 'pglite', // SQLite with vectorlite is the default
  path: '.auditaria/search.db',
  inMemory: false,
  backupEnabled: true,
};

export const DEFAULT_INDEXING_CONFIG: IndexingConfig = {
  ignorePaths: ['node_modules', '.git', 'dist', 'build', '*.log', '.auditaria'],
  includePaths: [],
  fileTypes: [
    // Documents
    '.pdf',
    '.docx',
    '.pptx',
    '.xlsx',
    '.txt',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.csv',
    '.html',
    '.htm',
    '.xml',
    '.rtf',
    '.odt',
    '.odp',
    '.ods',
    // Images (for OCR)
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.bmp',
    '.tiff',
    '.tif',
    '.webp',
  ],
  maxFileSize: 100 * 1024 * 1024, // 50MB
  ocrEnabled: true,
  ocrPriority: 'low',
  respectGitignore: true,
  prepareWorkers: 1,
  preparedBufferSize: 1,
  // Child process options
  useChildProcess: false,
  childProcessBatchSize: 500,
  childProcessMemoryThresholdMb: 3000,
};

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  strategy: 'recursive',
  maxChunkSize: 1000,
  chunkOverlap: 200,
  preserveSentences: true,
  preserveParagraphs: true,
};

export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = {
  model: 'Xenova/multilingual-e5-small', // 'Xenova/multilingual-e5-small', 'Xenova/multilingual-e5-base', 'Xenova/multilingual-e5-large'
  batchSize: 8, // Power of 2, conservative for memory
  dimensions: 384, // 384, 768, 1024
  queryPrefix: 'query: ',
  documentPrefix: 'passage: ',
  useWorkerThread: true,
  device: 'cpu', // CPU is faster than GPU for small models (see benchmarks)
  quantization: 'q8', // Q8 is 2.2x faster than FP16 with identical quality
  preferGpuForIndexing: false, // GPU is 6.5x slower for this model size
  workerHeapSizeMb: 4096, // 4GB heap for worker thread (V8 default is ~2GB)
  preferPythonEmbedder: false, // Use Node.js by default, Python as alternative
  cacheDir: join(homedir(), '.auditaria', 'models'), // Consistent path across runtimes
};

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  defaultLimit: 10,
  defaultStrategy: 'hybrid',
  semanticWeight: 0.5,
  keywordWeight: 0.5,
  rrfK: 60,
  hybridStrategy: 'application', // Application-level RRF fusion is the default
};

export const DEFAULT_OCR_CONFIG: OcrConfig = {
  enabled: true,
  concurrency: 2, // Process 2 OCR jobs in parallel (OCR is CPU/memory intensive)
  maxRetries: 3,
  retryDelay: 5000,
  processAfterMainQueue: true,
  autoDetectLanguage: true,
  defaultLanguages: ['en'],
  minConfidence: 0.5,
};

export const DEFAULT_VECTOR_INDEX_CONFIG: VectorIndexConfig = {
  type: 'none', // 'hnsw', 'ivfflat', 'none'
  useHalfVec: true,
  deferIndexCreation: false, // Better performance for bulk indexing
  createIndex: false, // Set to false to disable index entirely (use brute force)
  // HNSW defaults (used if type is changed to 'hnsw')
  hnswM: 16,
  hnswEfConstruction: 64,
  // IVFFlat defaults
  ivfflatLists: 'auto',
  ivfflatProbes: 40,
};

export const DEFAULT_CONFIG: SearchSystemConfig = {
  database: DEFAULT_DATABASE_CONFIG,
  indexing: DEFAULT_INDEXING_CONFIG,
  chunking: DEFAULT_CHUNKING_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  search: DEFAULT_SEARCH_CONFIG,
  ocr: DEFAULT_OCR_CONFIG,
  vectorIndex: DEFAULT_VECTOR_INDEX_CONFIG,
};

// ============================================================================
// Configuration Utilities
// ============================================================================

/**
 * Deep merge two objects, with source values overriding target values.
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(targetValue, sourceValue as Partial<T[keyof T]>);
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Create a complete configuration by merging partial config with defaults.
 */
export function createConfig(
  partial?: DeepPartial<SearchSystemConfig>,
): SearchSystemConfig {
  if (!partial) {
    return { ...DEFAULT_CONFIG };
  }

  return {
    database: deepMerge(
      DEFAULT_DATABASE_CONFIG,
      (partial.database ?? {}) as Partial<DatabaseConfig>,
    ),
    indexing: deepMerge(
      DEFAULT_INDEXING_CONFIG,
      (partial.indexing ?? {}) as Partial<IndexingConfig>,
    ),
    chunking: deepMerge(
      DEFAULT_CHUNKING_CONFIG,
      (partial.chunking ?? {}) as Partial<ChunkingConfig>,
    ),
    embeddings: deepMerge(
      DEFAULT_EMBEDDINGS_CONFIG,
      (partial.embeddings ?? {}) as Partial<EmbeddingsConfig>,
    ),
    search: deepMerge(
      DEFAULT_SEARCH_CONFIG,
      (partial.search ?? {}) as Partial<SearchConfig>,
    ),
    ocr: deepMerge(
      DEFAULT_OCR_CONFIG,
      (partial.ocr ?? {}) as Partial<OcrConfig>,
    ),
    vectorIndex: deepMerge(
      DEFAULT_VECTOR_INDEX_CONFIG,
      (partial.vectorIndex ?? {}) as Partial<VectorIndexConfig>,
    ),
  };
}

/**
 * Deep partial type for nested partial objects.
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

/**
 * Validate configuration values.
 * Throws an error if configuration is invalid.
 */
export function validateConfig(config: SearchSystemConfig): void {
  // Validate database config
  if (!config.database.path && !config.database.inMemory) {
    throw new Error('Database path is required when not using in-memory mode');
  }
  const validBackends: StorageBackend[] = ['sqlite', 'pglite'];
  if (!validBackends.includes(config.database.backend)) {
    throw new Error(
      `database.backend must be one of: ${validBackends.join(', ')}`,
    );
  }

  // Validate indexing config
  if (config.indexing.maxFileSize <= 0) {
    throw new Error('maxFileSize must be positive');
  }

  // Validate chunking config
  if (config.chunking.maxChunkSize <= 0) {
    throw new Error('maxChunkSize must be positive');
  }
  if (config.chunking.chunkOverlap < 0) {
    throw new Error('chunkOverlap cannot be negative');
  }
  if (config.chunking.chunkOverlap >= config.chunking.maxChunkSize) {
    throw new Error('chunkOverlap must be less than maxChunkSize');
  }

  // Validate embeddings config
  if (config.embeddings.batchSize <= 0) {
    throw new Error('batchSize must be positive');
  }
  if (config.embeddings.dimensions <= 0) {
    throw new Error('dimensions must be positive');
  }

  // Validate search config
  if (config.search.defaultLimit <= 0) {
    throw new Error('defaultLimit must be positive');
  }
  if (config.search.semanticWeight < 0 || config.search.semanticWeight > 1) {
    throw new Error('semanticWeight must be between 0 and 1');
  }
  if (config.search.keywordWeight < 0 || config.search.keywordWeight > 1) {
    throw new Error('keywordWeight must be between 0 and 1');
  }
  if (config.search.rrfK <= 0) {
    throw new Error('rrfK must be positive');
  }
  const validHybridStrategies: HybridSearchStrategy[] = ['application', 'sql'];
  if (!validHybridStrategies.includes(config.search.hybridStrategy)) {
    throw new Error(
      `search.hybridStrategy must be one of: ${validHybridStrategies.join(', ')}`,
    );
  }

  // Validate OCR config
  if (config.ocr.concurrency <= 0) {
    throw new Error('OCR concurrency must be positive');
  }
  if (config.ocr.maxRetries < 0) {
    throw new Error('OCR maxRetries cannot be negative');
  }
  if (config.ocr.retryDelay < 0) {
    throw new Error('OCR retryDelay cannot be negative');
  }
  if (config.ocr.minConfidence < 0 || config.ocr.minConfidence > 1) {
    throw new Error('OCR minConfidence must be between 0 and 1');
  }

  // Validate vector index config
  const validIndexTypes: VectorIndexType[] = ['hnsw', 'ivfflat', 'none'];
  if (!validIndexTypes.includes(config.vectorIndex.type)) {
    throw new Error(
      `vectorIndex.type must be one of: ${validIndexTypes.join(', ')}`,
    );
  }
  if (config.vectorIndex.hnswM !== undefined && config.vectorIndex.hnswM <= 0) {
    throw new Error('vectorIndex.hnswM must be positive');
  }
  if (
    config.vectorIndex.hnswEfConstruction !== undefined &&
    config.vectorIndex.hnswEfConstruction <= 0
  ) {
    throw new Error('vectorIndex.hnswEfConstruction must be positive');
  }
  if (
    config.vectorIndex.ivfflatLists !== undefined &&
    config.vectorIndex.ivfflatLists !== 'auto' &&
    config.vectorIndex.ivfflatLists <= 0
  ) {
    throw new Error('vectorIndex.ivfflatLists must be positive or "auto"');
  }
  if (
    config.vectorIndex.ivfflatProbes !== undefined &&
    config.vectorIndex.ivfflatProbes <= 0
  ) {
    throw new Error('vectorIndex.ivfflatProbes must be positive');
  }
}
