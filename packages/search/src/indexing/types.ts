/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QueuePriority, DocumentStatus, OcrStatus } from '../types.js';
import type { ChunkerOptions } from '../chunkers/types.js';
import type { ParserOptions } from '../parsers/types.js';

// ============================================================================
// Pipeline Configuration
// ============================================================================

export interface IndexingPipelineOptions {
  /** Root path to index */
  rootPath: string;
  /** Number of data preparation workers (parse/chunk). Default: 2 */
  prepareWorkers?: number;
  /** Number of files to keep prepared ahead for embedding. Default: 4 */
  preparedBufferSize?: number;
  /** Batch size for embedding generation. Default: 16 */
  embeddingBatchSize?: number;
  /** Parser options */
  parserOptions?: Partial<ParserOptions>;
  /** Chunker options */
  chunkerOptions?: Partial<ChunkerOptions>;
  /** File discovery options */
  discoveryOptions?: {
    ignorePaths?: string[];
    includePatterns?: string[];
    fileTypes?: string[];
    maxFileSize?: number;
    respectGitignore?: boolean;
  };
  /** Auto-start processing when items are queued */
  autoStart?: boolean;
  /** Maximum retries for failed documents */
  maxRetries?: number;
  /** Delay between retries (ms) */
  retryDelay?: number;
  /** PDF size threshold for OCR priority classification (bytes). Default: 1MB */
  pdfSizeThreshold?: number;
  /** Maximum parsed text size (bytes) before skipping file entirely. Default: 5MB */
  maxParsedTextSize?: number;
  /** Parsed text size threshold (bytes) for deferring to low-priority queue. Default: 2MB */
  deferParsedTextSize?: number;
  /**
   * Maximum time allowed to parse a deferred queue item before giving up permanently.
   * Applies only when queue priority is 'deferred'. Default: 30 minutes.
   */
  deferredRetryParseTimeoutMs?: number;
  /** Maximum raw file size (bytes) for text-category files before deferring. Default: 10MB */
  maxRawTextFileSize?: number;
  /** Maximum raw file size (bytes) for markup-category files before deferring. Default: 20MB */
  maxRawMarkupFileSize?: number;
  /** Enable binary/garbage file detection via isbinaryfile. Default: true */
  enableGarbageDetection?: boolean;
}

// ============================================================================
// Embedder Interface
// ============================================================================

/**
 * Interface for embedding generators.
 * Implementations can use local models (Transformers.js) or API-based services.
 */
export interface Embedder {
  /** Unique name for this embedder */
  readonly name: string;
  /** Embedding dimension size */
  readonly dimensions: number;

  /**
   * Initialize the embedder (load model, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Check if the embedder is ready.
   */
  isReady(): boolean;

  /**
   * Generate embedding for a single text.
   */
  embed(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts (batch).
   * Uses automatic batch size fallback on failure.
   */
  embedBatch(texts: string[]): Promise<number[][]>;

  /**
   * Generate embeddings for multiple document/passages (batch).
   * For E5 models, adds "passage:" prefix to each text.
   * Uses automatic batch size fallback on failure.
   * Optional - falls back to embedBatch if not implemented.
   */
  embedBatchDocuments?(texts: string[]): Promise<number[][]>;

  /**
   * Stream embeddings for multiple documents/passages.
   * Yields batches of embeddings for memory efficiency - prevents accumulation
   * of all embeddings in memory at once.
   * Optional - falls back to embedBatchDocuments if not implemented.
   * @param texts - Array of document/passage texts
   * @param batchSize - Optional batch size override (defaults to embedder's configured batch size)
   */
  embedBatchDocumentsStreaming?(
    texts: string[],
    batchSize?: number,
  ): AsyncGenerator<{ startIndex: number; embeddings: number[][] }>;

  /**
   * Release resources.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Pipeline Events
// ============================================================================

export interface PipelineEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;

  /** Fired when pipeline starts processing */
  'pipeline:started': undefined;
  /** Fired when pipeline stops (all items processed) */
  'pipeline:stopped': undefined;
  /** Fired when pipeline is paused */
  'pipeline:paused': undefined;
  /** Fired when pipeline is resumed */
  'pipeline:resumed': undefined;

  /** Fired when maintenance (reconnect) completes - safe point for backup */
  'maintenance:completed': {
    processedCount: number;
  };

  /** Fired when a document starts processing */
  'document:started': {
    documentId: string;
    filePath: string;
    queueItemId: string;
  };
  /** Fired when parsing starts */
  'document:parsing': {
    documentId: string;
    filePath: string;
  };
  /** Fired when chunking starts */
  'document:chunking': {
    documentId: string;
    filePath: string;
    textLength: number;
  };
  /** Fired when embedding starts */
  'document:embedding': {
    documentId: string;
    filePath: string;
    chunkCount: number;
  };
  /** Fired when document is successfully indexed */
  'document:completed': {
    documentId: string;
    filePath: string;
    chunksCreated: number;
    duration: number;
  };
  /** Fired when document processing fails */
  'document:failed': {
    documentId: string;
    filePath: string;
    error: Error;
    attempts: number;
  };
  /** Fired when document needs OCR */
  'document:ocr_needed': {
    documentId: string;
    filePath: string;
    regions: number;
  };

  /** Fired when sync detects changes */
  'sync:changes_detected': {
    added: string[];
    modified: string[];
    deleted: string[];
  };
  /** Fired when sync completes */
  'sync:completed': {
    added: number;
    modified: number;
    deleted: number;
    duration: number;
  };

  /** Progress update for batch operations */
  progress: {
    stage: 'discovery' | 'parsing' | 'chunking' | 'embedding' | 'storing';
    current: number;
    total: number;
    percentage: number;
  };
}

export type PipelineEventName = keyof PipelineEvents;

// ============================================================================
// Pipeline State
// ============================================================================

export type PipelineState = 'idle' | 'running' | 'paused' | 'stopping';

export interface PipelineStatus {
  /** Current pipeline state */
  state: PipelineState;
  /** Number of documents currently being processed */
  activeDocuments: number;
  /** Total documents queued */
  queuedDocuments: number;
  /** Documents processed in current session */
  processedDocuments: number;
  /** Documents failed in current session */
  failedDocuments: number;
  /** Current processing speed (docs/minute) */
  processingSpeed: number;
  /** Estimated time remaining (seconds) */
  estimatedTimeRemaining: number | null;
}

// ============================================================================
// Processing Results
// ============================================================================

export interface ProcessingResult {
  /** Document ID */
  documentId: string;
  /** File path */
  filePath: string;
  /** Whether processing was successful */
  success: boolean;
  /** Number of chunks created */
  chunksCreated: number;
  /** Processing duration in ms */
  duration: number;
  /** Error if failed */
  error?: Error;
  /** Document status after processing */
  status: DocumentStatus;
  /** OCR status after processing */
  ocrStatus: OcrStatus;
}

export interface BatchProcessingResult {
  /** Number of documents processed */
  processed: number;
  /** Number of documents that succeeded */
  succeeded: number;
  /** Number of documents that failed */
  failed: number;
  /** Total duration in ms */
  duration: number;
  /** Individual results */
  results: ProcessingResult[];
}

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncOptions {
  /** Force re-index all files (ignore hashes) */
  forceReindex?: boolean;
  /** Priority for queued items */
  priority?: QueuePriority;
  /** Delete documents for removed files */
  deleteRemoved?: boolean;
}

export interface SyncChanges {
  /** New files to add */
  added: string[];
  /** Modified files to re-index */
  modified: string[];
  /** Deleted files to remove */
  deleted: string[];
}
