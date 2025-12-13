/**
 * Auditaria Search - Local document search with hybrid search capabilities.
 *
 * @packageDocumentation
 */

// Core types
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

// Configuration
export type {
  SearchSystemConfig,
  DatabaseConfig,
  IndexingConfig,
  ChunkingConfig,
  EmbeddingsConfig,
  SearchConfig,
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

// Registry
export type { Provider, SupportCheckProvider } from './src/core/Registry.js';
export { Registry, createRegistry } from './src/core/Registry.js';

// Event Emitter
export {
  SearchEventEmitter,
  createEventEmitter,
} from './src/core/EventEmitter.js';

// Storage
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

export { PGliteStorage } from './src/storage/PGliteStorage.js';
export { SCHEMA_SQL, SCHEMA_VERSION } from './src/storage/schema.js';
