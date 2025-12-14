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
} from './EmbedderRegistry.js';

// Implementations
export {
  TransformersJsEmbedder,
  createTransformersJsEmbedder,
  MockEmbedder,
} from './TransformersJsEmbedder.js';

// Extended types from implementations
export type {
  TransformersJsEmbedderFullConfig,
  WarningCallback,
  WarningInfo,
  MockEmbedderConfig,
} from './TransformersJsEmbedder.js';
