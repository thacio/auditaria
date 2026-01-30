/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC message types for the thin storage writer child process.
 *
 * This child process ONLY handles PGlite storage operations (writes).
 * The main process handles discovery, parsing, chunking, and embedding.
 * This separation allows:
 * - Embedders to stay in main process (already optimized with workers)
 * - PGlite write operations (the main memory hog) in child process
 * - Child exits after N writes, releasing all WASM memory
 *
 * Protocol: JSONL (JSON Lines) over stdin/stdout
 */

import type {
  CreateDocumentInput,
  CreateChunkInput,
  UpdateChunkEmbeddingInput,
} from '../storage/types.js';
import type { DeepPartial, SearchSystemConfig } from '../config.js';

// ============================================================================
// Main -> Child Messages
// ============================================================================

/**
 * Initialize the storage writer with database configuration.
 */
export interface StorageInitMessage {
  type: 'init';
  id: string;
  databasePath: string;
  rootPath: string;
  config: DeepPartial<SearchSystemConfig>;
}

/**
 * Write a complete document with its chunks and embeddings.
 * This is the main write operation - bundles everything for a single document.
 */
export interface WriteDocumentMessage {
  type: 'write_document';
  id: string;
  /** Document metadata */
  document: CreateDocumentInput;
  /** Chunks with text (embeddings are separate) */
  chunks: CreateChunkInput[];
  /** Embeddings for each chunk (parallel array with chunks) */
  embeddings: number[][];
  /** Whether to delete existing chunks first (for re-indexing) */
  isReindex: boolean;
}

/**
 * Update document status.
 */
export interface UpdateDocumentStatusMessage {
  type: 'update_document_status';
  id: string;
  documentId: string;
  status: 'pending' | 'parsing' | 'chunking' | 'embedding' | 'indexed' | 'failed';
  indexedAt?: string; // ISO date string
  metadata?: Record<string, unknown>;
}

/**
 * Force a checkpoint to ensure data is persisted.
 */
export interface CheckpointMessage {
  type: 'checkpoint';
  id: string;
}

/**
 * Request current memory usage and stats.
 */
export interface StatsMessage {
  type: 'stats';
  id: string;
}

/**
 * Gracefully shut down the storage writer.
 */
export interface ShutdownMessage {
  type: 'shutdown';
  id: string;
}

/**
 * Union of all main -> child messages.
 */
export type StorageWriterRequest =
  | StorageInitMessage
  | WriteDocumentMessage
  | UpdateDocumentStatusMessage
  | CheckpointMessage
  | StatsMessage
  | ShutdownMessage;

// ============================================================================
// Child -> Main Messages
// ============================================================================

/**
 * Storage writer is ready to receive commands.
 */
export interface StorageReadyMessage {
  type: 'ready';
  memoryUsageMb: number;
}

/**
 * Initialization complete.
 */
export interface StorageInitCompleteMessage {
  type: 'init_complete';
  id: string;
  success: boolean;
  error?: string;
  memoryUsageMb: number;
}

/**
 * Document write complete.
 */
export interface DocumentWrittenMessage {
  type: 'document_written';
  id: string;
  documentId: string;
  chunkIds: string[];
  chunksWritten: number;
  embeddingsWritten: number;
  memoryUsageMb: number;
}

/**
 * Document status updated.
 */
export interface DocumentStatusUpdatedMessage {
  type: 'document_status_updated';
  id: string;
  documentId: string;
  memoryUsageMb: number;
}

/**
 * Checkpoint complete.
 */
export interface CheckpointCompleteMessage {
  type: 'checkpoint_complete';
  id: string;
  memoryUsageMb: number;
}

/**
 * Current stats.
 */
export interface StatsResponseMessage {
  type: 'stats_response';
  id: string;
  documentsWritten: number;
  chunksWritten: number;
  embeddingsWritten: number;
  memoryUsageMb: number;
}

/**
 * Error occurred.
 */
export interface StorageErrorMessage {
  type: 'error';
  id?: string;
  error: string;
  fatal: boolean;
}

/**
 * Union of all child -> main messages.
 */
export type StorageWriterResponse =
  | StorageReadyMessage
  | StorageInitCompleteMessage
  | DocumentWrittenMessage
  | DocumentStatusUpdatedMessage
  | CheckpointCompleteMessage
  | StatsResponseMessage
  | StorageErrorMessage;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get current memory usage in megabytes.
 */
export function getMemoryUsageMb(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

/**
 * Serialize a message to JSONL format.
 */
export function serializeStorageMessage(
  message: StorageWriterRequest | StorageWriterResponse,
): string {
  return JSON.stringify(message);
}

/**
 * Parse a JSONL message.
 */
export function parseStorageMessage(line: string): StorageWriterResponse {
  return JSON.parse(line) as StorageWriterResponse;
}

// ============================================================================
// Batch Types (for collecting data before sending to child)
// ============================================================================

/**
 * Prepared document data ready to be written to storage.
 * Collected by the main process pipeline, sent to child for writing.
 */
export interface PreparedDocumentWrite {
  /** Document metadata for createDocument */
  document: CreateDocumentInput;
  /** Chunks for createChunks */
  chunks: CreateChunkInput[];
  /** Embeddings (parallel array with chunks) */
  embeddings: number[][];
  /** Whether this is a re-index (existing document modified) */
  isReindex: boolean;
  /** Queue item ID for status updates */
  queueItemId?: string;
  /** Processing start time for duration tracking */
  startTime: number;
}
