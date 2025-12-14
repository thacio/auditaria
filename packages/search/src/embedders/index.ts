/**
 * Embedders module.
 * Provides text embedding capabilities for semantic search.
 */

// Types
export type {
  TextEmbedder,
  EmbeddingResult,
  ProgressCallback,
  ProgressInfo,
  TransformersJsEmbedderConfig,
  EmbedderEvents,
} from './types.js';

// Registry
export {
  EmbedderRegistry,
  createEmbedderRegistry,
  createEmbedderRegistryAsync,
} from './EmbedderRegistry.js';

// Implementations
export {
  TransformersJsEmbedder,
  createTransformersJsEmbedder,
  MockEmbedder,
} from './TransformersJsEmbedder.js';

// Worker-based embedder (non-blocking)
export { WorkerEmbedder, createWorkerEmbedder } from './WorkerEmbedder.js';

// Extended types from implementations
export type {
  TransformersJsEmbedderFullConfig,
  WarningCallback,
  WarningInfo,
  MockEmbedderConfig,
} from './TransformersJsEmbedder.js';

export type { WorkerEmbedderConfig } from './WorkerEmbedder.js';

// Worker communication types (for advanced use)
export type { WorkerRequest, WorkerResponse } from './worker-types.js';
