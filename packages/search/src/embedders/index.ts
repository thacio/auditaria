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
  EmbedderDevice,
  EmbedderQuantization,
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

// Factory for creating embedders with GPU support
export { createEmbedders, createSingleEmbedder } from './EmbedderFactory.js';

export type {
  EmbedderFactoryConfig,
  EmbedderFactoryResult,
} from './EmbedderFactory.js';

// GPU detection utilities
export {
  resolveDevice,
  resolveQuantization,
  isGpuDevice,
  debugLog,
} from './gpu-detection.js';

export type {
  GpuDetectionResult,
  ResolvedEmbedderConfig,
} from './gpu-detection.js';

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
