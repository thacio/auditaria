/**
 * Indexing pipeline module exports.
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
