/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Document,
  DocumentChunk,
  DocumentStatus,
  OcrStatus,
  SearchFilters,
  SearchResult,
  SearchStats,
  TagCount,
  QueueItem,
  QueuePriority,
  QueueItemStatus,
  QueueStatus,
} from '../types.js';

// ============================================================================
// Document Operations
// ============================================================================

export interface CreateDocumentInput {
  filePath: string;
  fileName: string;
  fileExtension: string;
  fileSize: number;
  fileHash: string;
  mimeType?: string | null;
  title?: string | null;
  author?: string | null;
  language?: string | null;
  pageCount?: number | null;
  status?: DocumentStatus;
  ocrStatus?: OcrStatus;
  fileModifiedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface UpdateDocumentInput {
  filePath?: string;
  fileName?: string;
  fileExtension?: string;
  fileSize?: number;
  fileHash?: string;
  mimeType?: string | null;
  title?: string | null;
  author?: string | null;
  language?: string | null;
  pageCount?: number | null;
  status?: DocumentStatus;
  ocrStatus?: OcrStatus;
  indexedAt?: Date | null;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Chunk Operations
// ============================================================================

export interface CreateChunkInput {
  chunkIndex: number;
  text: string;
  startOffset: number;
  endOffset: number;
  page?: number | null;
  section?: string | null;
  tokenCount?: number | null;
}

export interface UpdateChunkEmbeddingInput {
  id: string;
  embedding: number[];
}

// ============================================================================
// Queue Operations
// ============================================================================

export interface CreateQueueItemInput {
  filePath: string;
  fileSize?: number;
  priority?: QueuePriority;
}

export interface UpdateQueueItemInput {
  status?: QueueItemStatus;
  attempts?: number;
  lastError?: string | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

// ============================================================================
// Search Operations
// ============================================================================

export interface HybridSearchWeights {
  semantic: number;
  keyword: number;
}

/**
 * Options for keyword search behavior.
 */
export interface KeywordSearchOptions {
  /**
   * Use Google-style web search syntax (websearch_to_tsquery) instead of
   * PostgreSQL's plainto_tsquery.
   * When true, supports: "quoted phrase", OR, -exclusion
   * When false (default), all terms are AND'ed together.
   */
  useWebSearchSyntax?: boolean;
}

// ============================================================================
// Storage Adapter Interface
// ============================================================================

/**
 * Abstract storage adapter interface.
 * Implementations can use PGlite, SQLite, or other backends.
 */
export interface StorageAdapter {
  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the storage (create tables, indexes, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Close the storage connection.
   */
  close(): Promise<void>;

  /**
   * Check if the storage is initialized.
   */
  isInitialized(): boolean;

  /**
   * Force a checkpoint to flush data to disk and release memory.
   * Optional - implementations may no-op if not supported.
   */
  checkpoint?(): Promise<void>;

  /**
   * Run vacuum to reclaim space and reduce memory usage.
   * Optional - implementations may no-op if not supported.
   */
  vacuum?(): Promise<void>;

  /**
   * Reconnect to the database by closing and reopening the connection.
   * This is the most aggressive memory release - destroys WASM instance entirely.
   * Only call when no operations are in flight.
   * Optional - implementations may no-op if not supported.
   */
  reconnect?(): Promise<void>;

  /**
   * Set read-only mode for concurrent access during child process indexing.
   * When read-only, the main process can search while a child process indexes.
   * Optional - implementations may no-op if not supported.
   */
  setReadOnly?(readOnly: boolean): Promise<void>;

  /**
   * Check if the storage is in read-only mode.
   * Optional - implementations may return false if not supported.
   */
  isReadOnly?(): boolean;

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Create a new document record.
   */
  createDocument(input: CreateDocumentInput): Promise<Document>;

  /**
   * Get a document by ID.
   */
  getDocument(id: string): Promise<Document | null>;

  /**
   * Get a document by file path.
   */
  getDocumentByPath(filePath: string): Promise<Document | null>;

  /**
   * Update a document.
   */
  updateDocument(id: string, updates: UpdateDocumentInput): Promise<Document>;

  /**
   * Delete a document and its chunks.
   */
  deleteDocument(id: string): Promise<void>;

  /**
   * List documents with optional filters.
   */
  listDocuments(filters?: Partial<SearchFilters>): Promise<Document[]>;

  /**
   * Count documents with optional filters.
   */
  countDocuments(filters?: Partial<SearchFilters>): Promise<number>;

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  /**
   * Create chunks for a document.
   */
  createChunks(
    documentId: string,
    chunks: CreateChunkInput[],
  ): Promise<DocumentChunk[]>;

  /**
   * Get all chunks for a document.
   */
  getChunks(documentId: string): Promise<DocumentChunk[]>;

  /**
   * Delete all chunks for a document.
   */
  deleteChunks(documentId: string): Promise<void>;

  /**
   * Update embeddings for multiple chunks.
   */
  updateChunkEmbeddings(updates: UpdateChunkEmbeddingInput[]): Promise<void>;

  /**
   * Count total chunks.
   */
  countChunks(): Promise<number>;

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  /**
   * Add tags to a document.
   */
  addTags(documentId: string, tags: string[]): Promise<void>;

  /**
   * Remove tags from a document.
   */
  removeTags(documentId: string, tags: string[]): Promise<void>;

  /**
   * Get all tags for a document.
   */
  getDocumentTags(documentId: string): Promise<string[]>;

  /**
   * Get all tags with their document counts.
   */
  getAllTags(): Promise<TagCount[]>;

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Perform keyword (full-text) search.
   */
  searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit?: number,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]>;

  /**
   * Perform semantic (vector) search.
   */
  searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]>;

  /**
   * Perform hybrid search combining keyword and semantic.
   */
  searchHybrid(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit?: number,
    weights?: HybridSearchWeights,
    rrfK?: number,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]>;

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  /**
   * Add an item to the index queue.
   */
  enqueueItem(input: CreateQueueItemInput): Promise<QueueItem>;

  /**
   * Add multiple items to the index queue.
   */
  enqueueItems(inputs: CreateQueueItemInput[]): Promise<QueueItem[]>;

  /**
   * Get the next pending item from the queue.
   */
  dequeueItem(): Promise<QueueItem | null>;

  /**
   * Update a queue item.
   */
  updateQueueItem(
    id: string,
    updates: UpdateQueueItemInput,
  ): Promise<QueueItem>;

  /**
   * Delete a queue item.
   */
  deleteQueueItem(id: string): Promise<void>;

  /**
   * Get queue item by file path.
   */
  getQueueItemByPath(filePath: string): Promise<QueueItem | null>;

  /**
   * Get queue status.
   */
  getQueueStatus(): Promise<QueueStatus>;

  /**
   * Clear completed queue items.
   */
  clearCompletedQueueItems(): Promise<number>;

  /**
   * Clear all queue items.
   */
  clearQueue(): Promise<void>;

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /**
   * Get all file paths and their hashes.
   */
  getFileHashes(): Promise<Map<string, string>>;

  /**
   * Get documents modified since a date.
   */
  getDocumentsModifiedSince(date: Date): Promise<Document[]>;

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  /**
   * Get search system statistics.
   */
  getStats(): Promise<SearchStats>;

  // -------------------------------------------------------------------------
  // Configuration Storage
  // -------------------------------------------------------------------------

  /**
   * Get a configuration value.
   */
  getConfigValue<T>(key: string): Promise<T | null>;

  /**
   * Set a configuration value.
   */
  setConfigValue<T>(key: string, value: T): Promise<void>;

  // -------------------------------------------------------------------------
  // Raw Query (for advanced use cases)
  // -------------------------------------------------------------------------

  /**
   * Execute a raw SQL query (use with caution).
   */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Execute a raw SQL command (use with caution).
   */
  execute(sql: string, params?: unknown[]): Promise<void>;

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Recover documents stuck in intermediate states (parsing, chunking, embedding).
   * This handles crash recovery where indexing was interrupted mid-process.
   * Returns the number of documents recovered.
   * Optional - implementations may return 0 if not supported.
   */
  recoverStuckDocuments?(): Promise<number>;
}
