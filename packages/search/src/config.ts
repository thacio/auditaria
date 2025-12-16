/**
 * Configuration types and defaults for the Auditaria Search system.
 */

// ============================================================================
// Configuration Types
// ============================================================================

export interface DatabaseConfig {
  /** Path to the database file. Default: .auditaria/search.db */
  path: string;
  /** Whether to use in-memory database (for testing). Default: false */
  inMemory: boolean;
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
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_DATABASE_CONFIG: DatabaseConfig = {
  path: '.auditaria/search.db',
  inMemory: false,
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
  maxFileSize: 50 * 1024 * 1024, // 50MB
  ocrEnabled: true,
  ocrPriority: 'low',
  respectGitignore: true,
  prepareWorkers: 2,
  preparedBufferSize: 2,
};

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  strategy: 'recursive',
  maxChunkSize: 1000,
  chunkOverlap: 200,
  preserveSentences: true,
  preserveParagraphs: true,
};

export const DEFAULT_EMBEDDINGS_CONFIG: EmbeddingsConfig = {
  model: 'Xenova/multilingual-e5-small',
  batchSize: 16, // Must be power of 2 for optimal ONNX performance
  dimensions: 384,
  queryPrefix: 'query: ',
  documentPrefix: 'passage: ',
  useWorkerThread: true,
  device: 'cpu', // CPU is faster than GPU for small models (see benchmarks)
  quantization: 'q8', // Q8 is 2.2x faster than FP16 with identical quality
  preferGpuForIndexing: false, // GPU is 6.5x slower for this model size
};

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  defaultLimit: 10,
  defaultStrategy: 'hybrid',
  semanticWeight: 0.5,
  keywordWeight: 0.5,
  rrfK: 60,
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

export const DEFAULT_CONFIG: SearchSystemConfig = {
  database: DEFAULT_DATABASE_CONFIG,
  indexing: DEFAULT_INDEXING_CONFIG,
  chunking: DEFAULT_CHUNKING_CONFIG,
  embeddings: DEFAULT_EMBEDDINGS_CONFIG,
  search: DEFAULT_SEARCH_CONFIG,
  ocr: DEFAULT_OCR_CONFIG,
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
}
