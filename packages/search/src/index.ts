/**
 * Auditaria Search Package
 *
 * Local document search with hybrid search capabilities.
 * Supports keyword, semantic, and hybrid search strategies.
 */

// ============================================================================
// Main Entry Point - SearchSystem
// ============================================================================

export {
  SearchSystem,
  initializeSearchSystem,
  loadSearchSystem,
  searchDatabaseExists,
  SEARCH_DB_VERSION,
  type SearchSystemInitOptions,
  type SearchSystemState,
  type StoredEmbedderConfig,
  type LoggingOptions,
} from './core/SearchSystem.js';

// ============================================================================
// Core Types
// ============================================================================

export type {
  // Document types
  Document,
  DocumentChunk,
  DocumentStatus,
  OcrStatus,
  // Search types
  SearchFilters,
  SearchResult,
  SearchOptions,
  SearchResponse,
  MatchType,
  // Queue types
  QueueItem,
  QueuePriority,
  QueueItemStatus,
  QueueStatus,
  // Stats types
  SearchStats,
  TagCount,
  // Discovery types
  DiscoveredFile,
  // Event types
  SearchSystemEvents,
  SearchSystemEventName,
} from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export {
  createConfig,
  validateConfig,
  DEFAULT_CONFIG,
  DEFAULT_DATABASE_CONFIG,
  DEFAULT_INDEXING_CONFIG,
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_OCR_CONFIG,
} from './config.js';

export type {
  SearchSystemConfig,
  DatabaseConfig,
  IndexingConfig,
  ChunkingConfig,
  EmbeddingsConfig,
  SearchConfig,
  OcrConfig,
  DeepPartial,
} from './config.js';

// ============================================================================
// Sync Module
// ============================================================================

export {
  StartupSync,
  createStartupSync,
  FileWatcher,
  createFileWatcher,
} from './sync/index.js';

export type {
  SyncResult,
  SyncOptions,
  FileWatcherConfig,
  FileChangeType,
  FileChangeEvent,
  FileWatcherEvents,
} from './sync/index.js';

// ============================================================================
// Search Engine (Direct Access)
// ============================================================================

export {
  SearchEngine,
  createSearchEngine,
  FilterBuilder,
  createFilterBuilder,
} from './search/index.js';

export type {
  SearchEngineConfig,
  NormalizedSearchParams,
  SearchEngineEvents,
  FilterBuildResult,
} from './search/index.js';

// ============================================================================
// Indexing Pipeline (Direct Access)
// ============================================================================

export {
  IndexingPipeline,
  createIndexingPipeline,
  FilePriorityClassifier,
  createFilePriorityClassifier,
} from './indexing/index.js';

export type {
  IndexingPipelineOptions,
  Embedder,
  PipelineEvents,
  PipelineState,
  PipelineStatus,
  ProcessingResult,
  BatchProcessingResult,
  FilePriorityClassifierConfig,
  ClassifiedFile,
  ClassificationSummary,
  FileCategory,
} from './indexing/index.js';

// ============================================================================
// Storage (Direct Access)
// ============================================================================

export { PGliteStorage } from './storage/PGliteStorage.js';

export type {
  StorageAdapter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateChunkInput,
  UpdateChunkEmbeddingInput,
  CreateQueueItemInput,
  UpdateQueueItemInput,
  HybridSearchWeights,
} from './storage/types.js';

// ============================================================================
// Parsers (Direct Access)
// ============================================================================

export {
  createParserRegistry,
  ParserRegistry,
  PlainTextParser,
  OfficeParserAdapter,
  PdfParseAdapter,
  MarkitdownParser,
} from './parsers/index.js';

export type {
  DocumentParser,
  ParsedDocument,
  ParserOptions,
  OcrRegion,
} from './parsers/types.js';

// ============================================================================
// Chunkers (Direct Access)
// ============================================================================

export {
  createChunkerRegistry,
  ChunkerRegistry,
  RecursiveChunker,
  FixedSizeChunker,
} from './chunkers/index.js';

export type {
  DocumentChunker,
  Chunk,
  ChunkerOptions,
} from './chunkers/types.js';

// ============================================================================
// Embedders (Direct Access)
// ============================================================================

export {
  createEmbedderRegistry,
  EmbedderRegistry,
  TransformersJsEmbedder,
  createTransformersJsEmbedder,
  MockEmbedder,
  WorkerEmbedder,
  createWorkerEmbedder,
  createEmbedders,
  createSingleEmbedder,
  resolveDevice,
  resolveQuantization,
  isGpuDevice,
} from './embedders/index.js';

export type {
  TextEmbedder,
  EmbeddingResult,
  ProgressCallback,
  ProgressInfo,
  TransformersJsEmbedderConfig,
  EmbedderEvents,
  WorkerEmbedderConfig,
  EmbedderDevice,
  EmbedderQuantization,
  EmbedderFactoryConfig,
  EmbedderFactoryResult,
  ResolvedEmbedderConfig,
  GpuDetectionResult,
} from './embedders/index.js';

// ============================================================================
// File Discovery (Direct Access)
// ============================================================================

export { FileDiscovery, createFileDiscovery } from './discovery/index.js';

export type {
  DiscoveryOptions,
  FileDiscoveryStats,
} from './discovery/FileDiscovery.js';

// ============================================================================
// OCR (Direct Access)
// ============================================================================

export {
  OcrRegistry,
  createOcrRegistry,
  createOcrRegistryAsync,
  TesseractJsProvider,
  createTesseractJsProvider,
  isTesseractAvailable,
  OcrQueueManager,
  createOcrQueueManager,
} from './ocr/index.js';

export type {
  OcrProvider,
  OcrResult,
  OcrTextRegion,
  OcrWord,
  OcrOptions,
  OcrRegistryOptions,
  OcrJob,
  OcrJobStatus,
  OcrQueueConfig,
  OcrProgressCallback,
  OcrProgressInfo,
  OcrEvents,
  OcrMergeOptions,
  OcrMergeResult,
  TesseractJsProviderConfig,
  OcrQueueState,
  OcrQueueStatus,
} from './ocr/index.js';

// ============================================================================
// Core Utilities
// ============================================================================

export { EventEmitter } from './core/EventEmitter.js';
export { Registry } from './core/Registry.js';

// ============================================================================
// Logging
// ============================================================================

export {
  Logger,
  ModuleLogger,
  LogLevel,
  globalLogger,
  createModuleLogger,
  parseLogLevel,
} from './core/Logger.js';

export type {
  LoggerConfig,
  LogEntry,
  MemorySnapshot,
  BenchmarkStats,
} from './core/Logger.js';
