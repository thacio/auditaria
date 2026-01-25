/**
 * Auditaria Search - Local document search with hybrid search capabilities.
 *
 * @packageDocumentation
 */

// ============================================================================
// Main Entry Point - SearchSystem
// ============================================================================

export {
  SearchSystem,
  initializeSearchSystem,
  loadSearchSystem,
  searchDatabaseExists,
  type SearchSystemInitOptions,
  type SearchSystemState,
} from './src/core/SearchSystem.js';

// ============================================================================
// Core types
// ============================================================================

export type {
  Document,
  DocumentChunk,
  DocumentStatus,
  OcrStatus,
  SearchFilters,
  SearchResult,
  SearchOptions,
  SearchResponse,
  MatchType,
  // Diversity types
  DiversityStrategy,
  DiversityOptions,
  AdditionalSource,
  // Queue types
  QueueItem,
  QueuePriority,
  QueueItemStatus,
  SyncResult,
  DiscoveredFile,
  SearchStats,
  QueueStatus,
  TagCount,
  SearchSystemEvents,
  SearchSystemEventName,
} from './src/types.js';

// ============================================================================
// Configuration
// ============================================================================

export type {
  SearchSystemConfig,
  DatabaseConfig,
  IndexingConfig,
  ChunkingConfig,
  EmbeddingsConfig,
  SearchConfig,
  DeepPartial,
} from './src/config.js';

export {
  DEFAULT_CONFIG,
  DEFAULT_DATABASE_CONFIG,
  DEFAULT_INDEXING_CONFIG,
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_SEARCH_CONFIG,
  createConfig,
  validateConfig,
} from './src/config.js';

// ============================================================================
// Sync Module
// ============================================================================

export {
  StartupSync,
  createStartupSync,
  FileWatcher,
  createFileWatcher,
} from './src/sync/index.js';

export type {
  SyncOptions,
  FileWatcherConfig,
  FileChangeType,
  FileChangeEvent,
  FileWatcherEvents,
} from './src/sync/index.js';

// ============================================================================
// Search Engine (Direct Access)
// ============================================================================

export {
  SearchEngine,
  createSearchEngine,
  FilterBuilder,
  createFilterBuilder,
} from './src/search/index.js';

export type {
  SearchEngineConfig,
  NormalizedSearchParams,
  NormalizedDiversityOptions,
  SearchEngineEvents,
  FilterBuildResult,
} from './src/search/index.js';

// ============================================================================
// Indexing Pipeline (Direct Access)
// ============================================================================

export {
  IndexingPipeline,
  createIndexingPipeline,
} from './src/indexing/index.js';

export type {
  IndexingPipelineOptions,
  Embedder,
  PipelineEvents,
  PipelineState,
  PipelineStatus,
  ProcessingResult,
  BatchProcessingResult,
} from './src/indexing/index.js';

// ============================================================================
// Storage (Direct Access)
// ============================================================================

export { PGliteStorage } from './src/storage/PGliteStorage.js';
export { SCHEMA_SQL, SCHEMA_VERSION } from './src/storage/schema.js';

export type {
  StorageAdapter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateChunkInput,
  UpdateChunkEmbeddingInput,
  CreateQueueItemInput,
  UpdateQueueItemInput,
  HybridSearchWeights,
} from './src/storage/types.js';

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
} from './src/parsers/index.js';

export type {
  DocumentParser,
  ParsedDocument,
  ParserOptions,
  OcrRegion,
} from './src/parsers/types.js';

// ============================================================================
// Chunkers (Direct Access)
// ============================================================================

export {
  createChunkerRegistry,
  ChunkerRegistry,
  RecursiveChunker,
  FixedSizeChunker,
} from './src/chunkers/index.js';

export type {
  DocumentChunker,
  Chunk,
  ChunkerOptions,
} from './src/chunkers/types.js';

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
} from './src/embedders/index.js';

export type {
  TextEmbedder,
  EmbeddingResult,
  ProgressCallback,
  ProgressInfo,
  TransformersJsEmbedderConfig,
  EmbedderEvents,
  WorkerEmbedderConfig,
} from './src/embedders/index.js';

// ============================================================================
// File Discovery (Direct Access)
// ============================================================================

export { FileDiscovery, createFileDiscovery } from './src/discovery/index.js';

export type {
  DiscoveryOptions,
  FileDiscoveryStats,
} from './src/discovery/FileDiscovery.js';

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
  ScribeJsProvider,
  createScribeJsProvider,
  isScribeAvailable,
  isScribeSupportedFile,
  OcrQueueManager,
  createOcrQueueManager,
} from './src/ocr/index.js';

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
  ScribeJsProviderConfig,
  OcrQueueState,
  OcrQueueStatus,
} from './src/ocr/index.js';

// ============================================================================
// Core Utilities
// ============================================================================

export { EventEmitter } from './src/core/EventEmitter.js';
export {
  Registry,
  createRegistry,
  type Provider,
  type SupportCheckProvider,
} from './src/core/Registry.js';
