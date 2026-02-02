/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// Types
export type {
  IndexingPipelineOptions,
  Embedder,
  PipelineEvents,
  PipelineEventName,
  PipelineState,
  PipelineStatus,
  ProcessingResult,
  BatchProcessingResult,
  SyncOptions,
  SyncChanges,
} from './types.js';

// Pipeline
export {
  IndexingPipeline,
  createIndexingPipeline,
} from './IndexingPipeline.js';

// Priority Classification
export {
  FilePriorityClassifier,
  createFilePriorityClassifier,
  type FilePriorityClassifierConfig,
  type ClassifiedFile,
  type ClassificationSummary,
  type FileCategory,
} from './FilePriorityClassifier.js';

// Child Process Indexing (for WASM memory management)
export {
  IndexingChildManager,
  type ChildManagerConfig,
  type IndexingChildEvents,
} from './IndexingChildManager.js';

// Child process types (for IPC communication)
export type {
  MainToChildMessage,
  ChildToMainMessage,
  StartIndexingMessage,
  BatchCompleteMessage,
  ProgressMessage,
  ErrorMessage,
} from './child-process-types.js';

export { getMemoryUsageMb, serializeMessage } from './child-process-types.js';

// Storage Writer (thin child for PGlite-only writes)
export {
  StorageWriterManager,
  type StorageWriterConfig,
  type StorageWriterEvents,
} from './StorageWriterManager.js';

// Storage Writer types (for IPC communication)
export type {
  StorageWriterRequest,
  StorageWriterResponse,
  PreparedDocumentWrite,
} from './storage-writer-types.js';

export {
  getMemoryUsageMb as getStorageWriterMemoryUsageMb,
  serializeStorageMessage,
  parseStorageMessage,
} from './storage-writer-types.js';
