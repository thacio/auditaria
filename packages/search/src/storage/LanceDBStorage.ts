/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import type {
  StorageAdapter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateChunkInput,
  UpdateChunkEmbeddingInput,
  CreateQueueItemInput,
  UpdateQueueItemInput,
  HybridSearchWeights,
  KeywordSearchOptions,
} from './types.js';
import type {
  Document,
  DocumentChunk,
  SearchFilters,
  SearchResult,
  SearchStats,
  TagCount,
  QueueItem,
  QueuePriority,
  QueueStatus,
} from '../types.js';
import type { DatabaseConfig, VectorIndexConfig } from '../config.js';
import { DEFAULT_VECTOR_INDEX_CONFIG } from '../config.js';
import { createModuleLogger } from '../core/Logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createModuleLogger('LanceDBStorage');

// ============================================================================
// Constants
// ============================================================================

/**
 * LanceDB defaults to returning only 10 rows when query().toArray() is called
 * without a limit. We use a large limit to fetch all rows.
 */
const QUERY_ALL_LIMIT = 1_000_000;

// ============================================================================
// Helper Functions
// ============================================================================

function generateId(): string {
  return crypto.randomUUID();
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

// ============================================================================
// Row Types (LanceDB representation - denormalized)
// ============================================================================

/**
 * Denormalized chunk row that includes document metadata.
 * LanceDB doesn't support joins, so we store document fields in each chunk.
 * Index signature required for LanceDB compatibility.
 *
 * Note: LanceDB can't infer types from null values, so we use:
 * - 0 for nullable numbers (page, page_count, token_count, indexed_at)
 * - '' (empty string) for nullable strings (section, mime_type, title, etc.)
 */
interface ChunkRow {
  [key: string]: unknown;
  // Chunk fields
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  vector: number[];
  start_offset: number;
  end_offset: number;
  page: number; // 0 = null
  section: string; // '' = null
  token_count: number; // 0 = null
  chunk_created_at: number;

  // Document fields (denormalized)
  file_path: string;
  file_name: string;
  file_extension: string;
  file_size: number;
  file_hash: string;
  mime_type: string; // '' = null
  title: string; // '' = null
  author: string; // '' = null
  language: string; // '' = null
  page_count: number; // 0 = null
  status: string;
  ocr_status: string;
  indexed_at: number; // 0 = null
  file_modified_at: number;
  doc_created_at: number;
  doc_updated_at: number;
  metadata: string; // JSON string
  tags: string; // JSON array string
}

interface QueueRow {
  [key: string]: unknown;
  id: string;
  file_path: string;
  file_size: number;
  priority: string;
  status: string;
  attempts: number;
  last_error: string; // Empty string represents null
  created_at: number;
  started_at: number; // 0 represents null
  completed_at: number; // 0 represents null
}

interface ConfigRow {
  [key: string]: unknown;
  key: string;
  value: string;
  updated_at: number;
}

/**
 * Pending document data stored in memory before chunks are created.
 * LanceDB requires at least one row to create a table, so we defer
 * document creation until chunks are added.
 */
interface PendingDocument {
  id: string;
  input: CreateDocumentInput;
  createdAt: Date;
  tags: string[];
}

// ============================================================================
// LanceDB Storage Adapter
// ============================================================================

export class LanceDBStorage implements StorageAdapter {
  private db: lancedb.Connection | null = null;
  private chunksTable: lancedb.Table | null = null;
  private queueTable: lancedb.Table | null = null;
  private configTable: lancedb.Table | null = null;

  private config: DatabaseConfig;
  private vectorIndexConfig: VectorIndexConfig;
  private embeddingDimensions: number;
  private _initialized = false;
  private _dirty = false;
  private _readOnly = false;
  private _suspended = false;
  private _ftsIndexCreated = false;
  private _reconnecting = false;
  private _reconnectPromise: Promise<void> | null = null;

  /** Pending documents waiting for chunks to be created */
  private pendingDocuments = new Map<string, PendingDocument>();

  /** Recently created documents - cache updates until status=indexed to avoid repeated chunk updates */
  private recentDocuments = new Map<string, { status: string; indexedAt: Date | null }>();

  constructor(
    config: DatabaseConfig,
    vectorIndexConfig?: VectorIndexConfig,
    embeddingDimensions?: number,
  ) {
    this.config = config;
    this.vectorIndexConfig = vectorIndexConfig ?? DEFAULT_VECTOR_INDEX_CONFIG;
    this.embeddingDimensions = embeddingDimensions ?? 384;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this._initialized) return;

    log.info('initialize:start', {
      path: this.config.path,
      inMemory: this.config.inMemory,
      dimensions: this.embeddingDimensions,
    });

    // Ensure directory exists
    const dbPath = this.getDbPath();
    if (!this.config.inMemory && dbPath) {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    // Connect to LanceDB (creates directory if doesn't exist)
    this.db = await lancedb.connect(dbPath);

    // Open or create tables
    await this.openOrCreateTables();

    this._initialized = true;
    log.info('initialize:complete');
  }

  private getDbPath(): string {
    if (this.config.inMemory) {
      // LanceDB doesn't have true in-memory mode, use temp directory
      const tempDir = path.join(
        require('os').tmpdir(),
        `lancedb-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      fs.mkdirSync(tempDir, { recursive: true });
      return tempDir;
    }
    // LanceDB uses a directory path - use the configured path directly
    return this.config.path;
  }

  private async openOrCreateTables(): Promise<void> {
    if (!this.db) return;

    const tableNames = await this.db.tableNames();

    // Open chunks table if exists
    if (tableNames.includes('chunks')) {
      this.chunksTable = await this.db.openTable('chunks');
      log.info('openOrCreateTables:chunks:opened');

      // Try to create FTS index if not exists (will fail silently if already exists)
      await this.ensureFtsIndex();
    }

    // Open or create queue table
    if (tableNames.includes('queue')) {
      this.queueTable = await this.db.openTable('queue');
      log.info('openOrCreateTables:queue:opened');
    } else {
      // Create with dummy data, then delete
      // Note: Use empty strings instead of null for schema inference
      const dummyQueue: QueueRow = {
        id: '__dummy__',
        file_path: '',
        file_size: 0,
        priority: 'text',
        status: 'pending',
        attempts: 0,
        last_error: '', // Empty string instead of null for schema inference
        created_at: Date.now(),
        started_at: 0, // 0 instead of null for schema inference
        completed_at: 0, // 0 instead of null for schema inference
      };
      this.queueTable = await this.db.createTable('queue', [dummyQueue]);
      await this.queueTable.delete("id = '__dummy__'");
      log.info('openOrCreateTables:queue:created');
    }

    // Open or create config table
    if (tableNames.includes('config')) {
      this.configTable = await this.db.openTable('config');
      log.info('openOrCreateTables:config:opened');
    } else {
      const dummyConfig: ConfigRow = {
        key: '__dummy__',
        value: '{}',
        updated_at: Date.now(),
      };
      this.configTable = await this.db.createTable('config', [dummyConfig]);
      await this.configTable.delete("key = '__dummy__'");
      log.info('openOrCreateTables:config:created');
    }
  }

  private async ensureFtsIndex(): Promise<void> {
    if (!this.chunksTable || this._ftsIndexCreated) return;

    try {
      await this.chunksTable.createIndex('text', {
        config: lancedb.Index.fts(),
      });
      this._ftsIndexCreated = true;
      log.info('ensureFtsIndex:created');
    } catch (error) {
      // Index might already exist or table is empty
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('already exists') || msg.includes('Index already exists')) {
        this._ftsIndexCreated = true;
        log.info('ensureFtsIndex:alreadyExists');
      } else {
        log.warn('ensureFtsIndex:failed', { error: msg });
      }
    }
  }

  async close(): Promise<void> {
    log.info('close:start');

    // LanceDB doesn't have explicit close, just null references
    this.chunksTable = null;
    this.queueTable = null;
    this.configTable = null;
    this.db = null;
    this._initialized = false;
    this._ftsIndexCreated = false;

    log.info('close:complete');
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  async checkpoint(): Promise<void> {
    // LanceDB handles persistence automatically
    log.debug('checkpoint:noop');
  }

  async vacuum(): Promise<void> {
    // LanceDB doesn't have explicit vacuum
    log.debug('vacuum:noop');
  }

  /**
   * Reconnect to the database by closing and reopening the connection.
   * This helps release memory and ensures data is persisted.
   *
   * This method is safe to call even with concurrent operations - they will
   * wait for reconnection to complete before proceeding.
   */
  async reconnect(): Promise<void> {
    if (!this.db || !this._initialized) {
      // Not initialized, nothing to reconnect
      return;
    }

    // If already reconnecting, wait for that to complete
    if (this._reconnecting && this._reconnectPromise) {
      await this._reconnectPromise;
      return;
    }

    log.info('reconnect:start');
    log.logMemory('reconnect:memoryBefore');

    // Set reconnecting flag and create a promise that others can wait on
    this._reconnecting = true;
    let resolveReconnect: () => void;
    this._reconnectPromise = new Promise<void>((resolve) => {
      resolveReconnect = resolve;
    });

    try {
      // Close current connection (nulls references)
      this.chunksTable = null;
      this.queueTable = null;
      this.configTable = null;
      this.db = null;
      this._initialized = false;
      this._ftsIndexCreated = false;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      log.logMemory('reconnect:afterClose');

      // Reopen connection
      const dbPath = this.getDbPath();
      this.db = await lancedb.connect(dbPath);

      // Reopen tables
      await this.openOrCreateTables();

      this._initialized = true;

      log.info('reconnect:complete');
      log.logMemory('reconnect:memoryAfter');
    } catch (error) {
      log.error('reconnect:error', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Try to recover by reinitializing
      this.db = null;
      this._initialized = false;
      try {
        await this.initialize();
        log.info('reconnect:recovered');
      } catch (initError) {
        log.error('reconnect:recoveryFailed', {
          error: initError instanceof Error ? initError.message : String(initError),
        });
        throw initError;
      }
    } finally {
      // Always clear reconnecting state
      this._reconnecting = false;
      this._reconnectPromise = null;
      resolveReconnect!();
    }
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    this._readOnly = readOnly;
  }

  isReadOnly(): boolean {
    return this._readOnly;
  }

  async suspend(): Promise<void> {
    if (this._suspended) return;

    log.info('suspend:start');
    await this.close();
    this._suspended = true;
    log.info('suspend:complete');
  }

  async resume(): Promise<void> {
    if (!this._suspended) return;

    log.info('resume:start');
    this._suspended = false;
    await this.initialize();
    log.info('resume:complete');
  }

  isSuspended(): boolean {
    return this._suspended;
  }

  async refresh(): Promise<void> {
    // LanceDB auto-refreshes on query
    log.debug('refresh:noop');
  }

  /**
   * Waits for any ongoing reconnection to complete, then checks initialization.
   * This is safe to call from concurrent operations during reconnect.
   */
  private async waitForReady(): Promise<void> {
    // Wait for any ongoing reconnection to complete
    if (this._reconnecting && this._reconnectPromise) {
      await this._reconnectPromise;
    }
    if (!this.db || !this._initialized) {
      throw new Error('Storage not initialized');
    }
  }

  private ensureWritable(): void {
    if (this._readOnly) {
      throw new Error('Storage is in read-only mode');
    }
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async createDocument(input: CreateDocumentInput): Promise<Document> {
    await this.waitForReady();
    this.ensureWritable();

    const id = generateId();
    const now = new Date();

    // Store in pending documents until chunks are created
    this.pendingDocuments.set(id, {
      id,
      input,
      createdAt: now,
      tags: [],
    });

    this._dirty = true;

    log.debug('createDocument:pending', { id, filePath: input.filePath });

    return {
      id,
      filePath: input.filePath,
      fileName: input.fileName,
      fileExtension: input.fileExtension,
      fileSize: input.fileSize,
      fileHash: input.fileHash,
      mimeType: input.mimeType ?? null,
      title: input.title ?? null,
      author: input.author ?? null,
      language: input.language ?? null,
      pageCount: input.pageCount ?? null,
      status: input.status ?? 'pending',
      ocrStatus: input.ocrStatus ?? 'not_needed',
      indexedAt: null,
      fileModifiedAt: input.fileModifiedAt,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata ?? {},
      tags: [],
    };
  }

  async getDocument(id: string): Promise<Document | null> {
    await this.waitForReady();

    // Check pending documents first
    const pending = this.pendingDocuments.get(id);
    if (pending) {
      return {
        id: pending.id,
        filePath: pending.input.filePath,
        fileName: pending.input.fileName,
        fileExtension: pending.input.fileExtension,
        fileSize: pending.input.fileSize,
        fileHash: pending.input.fileHash,
        mimeType: pending.input.mimeType ?? null,
        title: pending.input.title ?? null,
        author: pending.input.author ?? null,
        language: pending.input.language ?? null,
        pageCount: pending.input.pageCount ?? null,
        status: pending.input.status ?? 'pending',
        ocrStatus: pending.input.ocrStatus ?? 'not_needed',
        indexedAt: null,
        fileModifiedAt: pending.input.fileModifiedAt,
        createdAt: pending.createdAt,
        updatedAt: pending.createdAt,
        metadata: pending.input.metadata ?? {},
        tags: pending.tags,
      };
    }

    if (!this.chunksTable) return null;

    try {
      // Query first chunk for this document
      const results = await this.chunksTable
        .query()
        .where(`document_id = '${this.escapeString(id)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      const doc = this.rowToDocument(results[0] as ChunkRow);

      // Apply cached status from recentDocuments if available
      const recent = this.recentDocuments.get(id);
      if (recent) {
        doc.status = recent.status as typeof doc.status;
        if (recent.indexedAt) {
          doc.indexedAt = recent.indexedAt;
        }
      }

      return doc;
    } catch (error) {
      log.warn('getDocument:failed', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async getDocumentByPath(filePath: string): Promise<Document | null> {
    await this.waitForReady();

    // Check pending documents
    for (const pending of this.pendingDocuments.values()) {
      if (pending.input.filePath === filePath) {
        return this.getDocument(pending.id);
      }
    }

    if (!this.chunksTable) return null;

    try {
      const results = await this.chunksTable
        .query()
        .where(`file_path = '${this.escapeString(filePath)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      return this.rowToDocument(results[0] as ChunkRow);
    } catch (error) {
      log.warn('getDocumentByPath:failed', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async updateDocument(id: string, updates: UpdateDocumentInput): Promise<Document> {
    await this.waitForReady();
    this.ensureWritable();

    // Check pending documents (before chunks created)
    const pending = this.pendingDocuments.get(id);
    if (pending) {
      // Update pending document - in memory only
      if (updates.filePath !== undefined) pending.input.filePath = updates.filePath;
      if (updates.fileName !== undefined) pending.input.fileName = updates.fileName;
      if (updates.fileExtension !== undefined) pending.input.fileExtension = updates.fileExtension;
      if (updates.fileSize !== undefined) pending.input.fileSize = updates.fileSize;
      if (updates.fileHash !== undefined) pending.input.fileHash = updates.fileHash;
      if (updates.mimeType !== undefined) pending.input.mimeType = updates.mimeType;
      if (updates.title !== undefined) pending.input.title = updates.title;
      if (updates.author !== undefined) pending.input.author = updates.author;
      if (updates.language !== undefined) pending.input.language = updates.language;
      if (updates.pageCount !== undefined) pending.input.pageCount = updates.pageCount;
      if (updates.status !== undefined) pending.input.status = updates.status;
      if (updates.ocrStatus !== undefined) pending.input.ocrStatus = updates.ocrStatus;
      if (updates.metadata !== undefined) pending.input.metadata = updates.metadata;

      const doc = await this.getDocument(id);
      if (!doc) throw new Error('Document not found after update');
      return doc;
    }

    // Check if this is a recent document - cache intermediate status updates
    const recent = this.recentDocuments.get(id);
    if (recent) {
      // Cache status updates - only write to DB on final status (indexed/failed)
      if (updates.status !== undefined) {
        recent.status = updates.status;
      }
      if (updates.indexedAt !== undefined) {
        recent.indexedAt = updates.indexedAt;
      }

      // If status is indexed or failed, flush to database and remove from cache
      if (updates.status === 'indexed' || updates.status === 'failed') {
        this.recentDocuments.delete(id);
        // Fall through to do the actual DB update
      } else {
        // Intermediate status - return cached document without DB update
        const doc = await this.getDocument(id);
        if (!doc) throw new Error('Document not found after update');
        // Override status from cache
        doc.status = recent.status as typeof doc.status;
        return doc;
      }
    }

    if (!this.chunksTable) {
      throw new Error('Document not found');
    }

    // Build update values
    const values: Record<string, unknown> = {
      doc_updated_at: Date.now(),
    };

    if (updates.filePath !== undefined) values.file_path = updates.filePath;
    if (updates.fileName !== undefined) values.file_name = updates.fileName;
    if (updates.fileExtension !== undefined) values.file_extension = updates.fileExtension;
    if (updates.fileSize !== undefined) values.file_size = updates.fileSize;
    if (updates.fileHash !== undefined) values.file_hash = updates.fileHash;
    if (updates.mimeType !== undefined) values.mime_type = updates.mimeType;
    if (updates.title !== undefined) values.title = updates.title;
    if (updates.author !== undefined) values.author = updates.author;
    if (updates.language !== undefined) values.language = updates.language;
    if (updates.pageCount !== undefined) values.page_count = updates.pageCount;
    if (updates.status !== undefined) values.status = updates.status;
    if (updates.ocrStatus !== undefined) values.ocr_status = updates.ocrStatus;
    if (updates.indexedAt !== undefined) {
      values.indexed_at = updates.indexedAt?.getTime() ?? null;
    }
    if (updates.metadata !== undefined) values.metadata = JSON.stringify(updates.metadata);

    // Update all chunks for this document
    await this.chunksTable.update({
      where: `document_id = '${this.escapeString(id)}'`,
      values: values as Record<string, lancedb.IntoSql>,
    });

    this._dirty = true;

    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Document not found after update');
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    // Remove from pending
    this.pendingDocuments.delete(id);

    // Delete all chunks for this document
    if (this.chunksTable) {
      try {
        await this.chunksTable.delete(`document_id = '${this.escapeString(id)}'`);
      } catch (error) {
        log.warn('deleteDocument:failed', {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this._dirty = true;
  }

  async listDocuments(filters?: Partial<SearchFilters>): Promise<Document[]> {
    await this.waitForReady();

    const documents: Document[] = [];
    const seenIds = new Set<string>();

    // Include pending documents
    for (const pending of this.pendingDocuments.values()) {
      const doc = await this.getDocument(pending.id);
      if (doc && this.matchesFilters(doc, filters)) {
        documents.push(doc);
        seenIds.add(doc.id);
      }
    }

    if (!this.chunksTable) return documents;

    try {
      // Build filter where clause
      const whereClause = this.buildDocumentFilterWhere(filters);

      // Get all chunks and group by document_id
      let query = this.chunksTable.query();
      if (whereClause) {
        query = query.where(whereClause);
      }

      const results = await query.limit(QUERY_ALL_LIMIT).toArray();

      for (const row of results) {
        const chunkRow = row as ChunkRow;
        if (!seenIds.has(chunkRow.document_id)) {
          seenIds.add(chunkRow.document_id);
          documents.push(this.rowToDocument(chunkRow));
        }
      }
    } catch (error) {
      log.warn('listDocuments:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return documents.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  async countDocuments(filters?: Partial<SearchFilters>): Promise<number> {
    const docs = await this.listDocuments(filters);
    return docs.length;
  }

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  async createChunks(documentId: string, chunks: CreateChunkInput[]): Promise<DocumentChunk[]> {
    await this.waitForReady();
    this.ensureWritable();

    log.debug('createChunks:start', { documentId, chunkCount: chunks.length });

    // Get document metadata
    const pending = this.pendingDocuments.get(documentId);
    let docData: {
      filePath: string;
      fileName: string;
      fileExtension: string;
      fileSize: number;
      fileHash: string;
      mimeType: string | null;
      title: string | null;
      author: string | null;
      language: string | null;
      pageCount: number | null;
      status: string;
      ocrStatus: string;
      indexedAt: number | null;
      fileModifiedAt: number;
      docCreatedAt: number;
      docUpdatedAt: number;
      metadata: string;
      tags: string;
    };

    if (pending) {
      docData = {
        filePath: pending.input.filePath,
        fileName: pending.input.fileName,
        fileExtension: pending.input.fileExtension,
        fileSize: pending.input.fileSize,
        fileHash: pending.input.fileHash,
        mimeType: pending.input.mimeType ?? null,
        title: pending.input.title ?? null,
        author: pending.input.author ?? null,
        language: pending.input.language ?? null,
        pageCount: pending.input.pageCount ?? null,
        status: pending.input.status ?? 'pending',
        ocrStatus: pending.input.ocrStatus ?? 'not_needed',
        indexedAt: null,
        fileModifiedAt: pending.input.fileModifiedAt.getTime(),
        docCreatedAt: pending.createdAt.getTime(),
        docUpdatedAt: pending.createdAt.getTime(),
        metadata: JSON.stringify(pending.input.metadata ?? {}),
        tags: JSON.stringify(pending.tags),
      };
      // Remove from pending since we're now persisting
      this.pendingDocuments.delete(documentId);
    } else {
      // Try to get from existing chunks
      const existingDoc = await this.getDocument(documentId);
      if (!existingDoc) {
        throw new Error(`Document ${documentId} not found`);
      }
      docData = {
        filePath: existingDoc.filePath,
        fileName: existingDoc.fileName,
        fileExtension: existingDoc.fileExtension,
        fileSize: existingDoc.fileSize,
        fileHash: existingDoc.fileHash,
        mimeType: existingDoc.mimeType,
        title: existingDoc.title,
        author: existingDoc.author,
        language: existingDoc.language,
        pageCount: existingDoc.pageCount,
        status: existingDoc.status,
        ocrStatus: existingDoc.ocrStatus,
        indexedAt: existingDoc.indexedAt?.getTime() ?? null,
        fileModifiedAt: existingDoc.fileModifiedAt.getTime(),
        docCreatedAt: existingDoc.createdAt.getTime(),
        docUpdatedAt: existingDoc.updatedAt.getTime(),
        metadata: JSON.stringify(existingDoc.metadata),
        tags: JSON.stringify(existingDoc.tags),
      };
    }

    const now = Date.now();
    const createdChunks: DocumentChunk[] = [];

    // Build chunk rows
    const rows: ChunkRow[] = chunks.map((chunk) => {
      const id = generateId();
      createdChunks.push({
        id,
        documentId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding: null,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        page: chunk.page ?? null,
        section: chunk.section ?? null,
        tokenCount: chunk.tokenCount ?? null,
        createdAt: new Date(now),
      });

      return {
        chunk_id: id,
        document_id: documentId,
        chunk_index: chunk.chunkIndex,
        text: chunk.text,
        vector: new Array(this.embeddingDimensions).fill(0), // Placeholder until embedding
        start_offset: chunk.startOffset,
        end_offset: chunk.endOffset,
        page: chunk.page ?? 0, // 0 = null
        section: chunk.section ?? '', // '' = null
        token_count: chunk.tokenCount ?? 0, // 0 = null
        chunk_created_at: now,
        file_path: docData.filePath,
        file_name: docData.fileName,
        file_extension: docData.fileExtension,
        file_size: docData.fileSize,
        file_hash: docData.fileHash,
        mime_type: docData.mimeType ?? '', // '' = null
        title: docData.title ?? '', // '' = null
        author: docData.author ?? '', // '' = null
        language: docData.language ?? '', // '' = null
        page_count: docData.pageCount ?? 0, // 0 = null
        status: docData.status,
        ocr_status: docData.ocrStatus,
        indexed_at: docData.indexedAt ?? 0, // 0 = null
        file_modified_at: docData.fileModifiedAt,
        doc_created_at: docData.docCreatedAt,
        doc_updated_at: docData.docUpdatedAt,
        metadata: docData.metadata,
        tags: docData.tags,
      };
    });

    // Create or add to chunks table
    if (!this.chunksTable) {
      this.chunksTable = await this.db!.createTable('chunks', rows);
      log.info('createChunks:table:created', { rowCount: rows.length });
      // Create FTS index after first data
      await this.ensureFtsIndex();
    } else {
      await this.chunksTable.add(rows);
      // Ensure FTS index exists
      await this.ensureFtsIndex();
    }

    this._dirty = true;

    // Add to recentDocuments cache - we'll batch status updates until indexed
    this.recentDocuments.set(documentId, { status: 'chunking', indexedAt: null });

    log.debug('createChunks:complete', { documentId, chunkCount: chunks.length });
    return createdChunks;
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    await this.waitForReady();

    if (!this.chunksTable) return [];

    try {
      const results = await this.chunksTable
        .query()
        .where(`document_id = '${this.escapeString(documentId)}'`)
        .limit(QUERY_ALL_LIMIT)
        .toArray();

      return results
        .map((row) => this.rowToChunk(row as ChunkRow))
        .sort((a, b) => a.chunkIndex - b.chunkIndex);
    } catch (error) {
      log.warn('getChunks:failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async deleteChunks(documentId: string): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.chunksTable) return;

    try {
      await this.chunksTable.delete(`document_id = '${this.escapeString(documentId)}'`);
      this._dirty = true;
    } catch (error) {
      log.warn('deleteChunks:failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async updateChunkEmbeddings(updates: UpdateChunkEmbeddingInput[]): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.chunksTable || updates.length === 0) {
      return;
    }

    log.debug('updateChunkEmbeddings:start', { updateCount: updates.length });

    // Build embedding map for quick lookup
    const embeddingMap = new Map(updates.map((u) => [u.id, u.embedding]));
    const chunkIds = new Set(updates.map((u) => u.id));

    try {
      // Fetch all recently created chunks (they should be at the end of the table)
      // Use a reasonable limit since these chunks were just created
      const results = await this.chunksTable
        .query()
        .limit(updates.length * 2) // Fetch a bit more than needed
        .toArray();

      // Filter to only the chunks we need to update
      const existingRows = (results as ChunkRow[]).filter((row) =>
        chunkIds.has(row.chunk_id),
      );

      if (existingRows.length === 0) {
        log.warn('updateChunkEmbeddings:noRowsFound');
        return;
      }

      // Update vectors in the rows
      const updatedRows = existingRows.map((row) => ({
        ...row,
        vector: embeddingMap.get(row.chunk_id) ?? row.vector,
      }));

      // Use mergeInsert for batch update
      await this.chunksTable
        .mergeInsert('chunk_id')
        .whenMatchedUpdateAll()
        .execute(updatedRows);

      this._dirty = true;
      log.debug('updateChunkEmbeddings:complete', { updateCount: updates.length });
    } catch (error) {
      // Fallback to individual updates if mergeInsert fails
      log.warn('updateChunkEmbeddings:mergeInsertFailed, falling back', {
        error: error instanceof Error ? error.message : String(error),
      });

      for (const update of updates) {
        try {
          await this.chunksTable.update({
            where: `chunk_id = '${this.escapeString(update.id)}'`,
            values: { vector: update.embedding } as Record<string, lancedb.IntoSql>,
          });
        } catch (err) {
          log.warn('updateChunkEmbeddings:chunkFailed', {
            chunkId: update.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this._dirty = true;
    }
  }

  async countChunks(): Promise<number> {
    await this.waitForReady();

    if (!this.chunksTable) return 0;

    try {
      return await this.chunksTable.countRows();
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async addTags(documentId: string, tags: string[]): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    // Check pending documents
    const pending = this.pendingDocuments.get(documentId);
    if (pending) {
      const existingTags = new Set(pending.tags);
      for (const tag of tags) {
        existingTags.add(tag);
      }
      pending.tags = Array.from(existingTags);
      return;
    }

    if (!this.chunksTable) return;

    try {
      // Get current tags
      const results = await this.chunksTable
        .query()
        .where(`document_id = '${this.escapeString(documentId)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return;

      const row = results[0] as ChunkRow;
      const currentTags = new Set<string>(JSON.parse(row.tags || '[]'));
      for (const tag of tags) {
        currentTags.add(tag);
      }

      // Update all chunks
      await this.chunksTable.update({
        where: `document_id = '${this.escapeString(documentId)}'`,
        values: { tags: JSON.stringify(Array.from(currentTags)) } as Record<string, lancedb.IntoSql>,
      });

      this._dirty = true;
    } catch (error) {
      log.warn('addTags:failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async removeTags(documentId: string, tags: string[]): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    // Check pending documents
    const pending = this.pendingDocuments.get(documentId);
    if (pending) {
      pending.tags = pending.tags.filter((t) => !tags.includes(t));
      return;
    }

    if (!this.chunksTable) return;

    try {
      const results = await this.chunksTable
        .query()
        .where(`document_id = '${this.escapeString(documentId)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return;

      const row = results[0] as ChunkRow;
      const currentTags = new Set<string>(JSON.parse(row.tags || '[]'));
      for (const tag of tags) {
        currentTags.delete(tag);
      }

      await this.chunksTable.update({
        where: `document_id = '${this.escapeString(documentId)}'`,
        values: { tags: JSON.stringify(Array.from(currentTags)) } as Record<string, lancedb.IntoSql>,
      });

      this._dirty = true;
    } catch (error) {
      log.warn('removeTags:failed', {
        documentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getDocumentTags(documentId: string): Promise<string[]> {
    await this.waitForReady();

    // Check pending documents
    const pending = this.pendingDocuments.get(documentId);
    if (pending) {
      return pending.tags;
    }

    if (!this.chunksTable) return [];

    try {
      const results = await this.chunksTable
        .query()
        .where(`document_id = '${this.escapeString(documentId)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return [];

      const row = results[0] as ChunkRow;
      return JSON.parse(row.tags || '[]');
    } catch {
      return [];
    }
  }

  async getAllTags(): Promise<TagCount[]> {
    await this.waitForReady();

    const tagCounts = new Map<string, Set<string>>();

    // Count from pending documents
    for (const pending of this.pendingDocuments.values()) {
      for (const tag of pending.tags) {
        if (!tagCounts.has(tag)) {
          tagCounts.set(tag, new Set());
        }
        tagCounts.get(tag)!.add(pending.id);
      }
    }

    if (this.chunksTable) {
      try {
        // Get all chunks and aggregate tags
        const results = await this.chunksTable.query().limit(QUERY_ALL_LIMIT).toArray();
        const seenDocs = new Set<string>();

        for (const row of results) {
          const chunkRow = row as ChunkRow;
          if (seenDocs.has(chunkRow.document_id)) continue;
          seenDocs.add(chunkRow.document_id);

          const tags: string[] = JSON.parse(chunkRow.tags || '[]');
          for (const tag of tags) {
            if (!tagCounts.has(tag)) {
              tagCounts.set(tag, new Set());
            }
            tagCounts.get(tag)!.add(chunkRow.document_id);
          }
        }
      } catch (error) {
        log.warn('getAllTags:failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Array.from(tagCounts.entries())
      .map(([tag, docs]) => ({ tag, count: docs.size }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit = 10,
    _options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    await this.waitForReady();

    if (!this.chunksTable) return [];

    log.debug('searchKeyword:start', { queryLength: query.length, limit });

    try {
      // Ensure FTS index exists
      await this.ensureFtsIndex();

      // Use LanceDB FTS search
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchQuery = (this.chunksTable as any)
        .search(query, { queryType: 'fts' })
        .where("status = 'indexed'")
        .limit(limit * 2);

      const results = await searchQuery.toArray();

      // Apply additional filters in code
      const filtered = results
        .map((row: Record<string, unknown>) => {
          const chunkRow = row as ChunkRow & { _score?: number; score?: number };
          return {
            row: chunkRow,
            score: chunkRow._score ?? chunkRow.score ?? 0.5,
          };
        })
        .filter(({ row }: { row: ChunkRow }) => this.matchesSearchFilters(row, filters))
        .slice(0, limit);

      const searchResults = filtered.map(
        ({ row, score }: { row: ChunkRow; score: number }) =>
          this.rowToSearchResult(row, score, 'keyword'),
      );

      log.debug('searchKeyword:complete', { resultCount: searchResults.length });
      return searchResults;
    } catch (error) {
      log.warn('searchKeyword:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback to LIKE-style search
      return this.searchKeywordFallback(query, filters, limit);
    }
  }

  private async searchKeywordFallback(
    query: string,
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    if (!this.chunksTable) return [];

    try {
      // Get all indexed chunks and filter in code
      const results = await this.chunksTable
        .query()
        .where("status = 'indexed'")
        .limit(QUERY_ALL_LIMIT)
        .toArray();

      const queryLower = query.toLowerCase();
      const terms = queryLower.split(/\s+/).filter((t) => t.length > 0);

      const matched = results
        .filter((row) => {
          const chunkRow = row as ChunkRow;
          const textLower = chunkRow.text.toLowerCase();
          return (
            terms.every((term) => textLower.includes(term)) &&
            this.matchesSearchFilters(chunkRow, filters)
          );
        })
        .slice(0, limit);

      return matched.map((row) =>
        this.rowToSearchResult(row as ChunkRow, 0.5, 'keyword'),
      );
    } catch (error) {
      log.warn('searchKeywordFallback:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    await this.waitForReady();

    if (!this.chunksTable) return [];

    log.debug('searchSemantic:start', { embeddingDim: embedding.length, limit });

    try {
      // Vector search with cosine distance
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchQuery = (this.chunksTable as any)
        .search(embedding)
        .distanceType('cosine')
        .where("status = 'indexed'")
        .limit(limit * 2);

      const results = await searchQuery.toArray();

      // Apply additional filters and convert distance to score
      const filtered = results
        .map((row: Record<string, unknown>) => {
          const chunkRow = row as ChunkRow & { _distance?: number };
          const distance = chunkRow._distance ?? 0;
          const score = 1 - distance; // Convert cosine distance to similarity
          return { row: chunkRow, score };
        })
        .filter(({ row }: { row: ChunkRow }) => this.matchesSearchFilters(row, filters))
        .slice(0, limit);

      const searchResults = filtered.map(
        ({ row, score }: { row: ChunkRow; score: number }) =>
          this.rowToSearchResult(row, score, 'semantic'),
      );

      log.debug('searchSemantic:complete', { resultCount: searchResults.length });
      return searchResults;
    } catch (error) {
      log.warn('searchSemantic:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async searchHybrid(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
    weights: HybridSearchWeights = { semantic: 0.5, keyword: 0.5 },
    rrfK = 60,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    await this.waitForReady();

    if (!this.chunksTable) return [];

    log.debug('searchHybrid:start', { limit });

    try {
      // Ensure FTS index exists
      await this.ensureFtsIndex();

      // Try native hybrid search first
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchQuery = (this.chunksTable as any)
        .search(query, { queryType: 'hybrid' })
        .vector(embedding)
        .where("status = 'indexed'")
        .limit(limit * 2);

      const results = await searchQuery.toArray();

      // Apply additional filters
      const filtered = results
        .map((row: Record<string, unknown>) => {
          const chunkRow = row as ChunkRow & { _score?: number; _distance?: number };
          const score = chunkRow._score ?? (1 - (chunkRow._distance ?? 0));
          return { row: chunkRow, score };
        })
        .filter(({ row }: { row: ChunkRow }) => this.matchesSearchFilters(row, filters))
        .slice(0, limit);

      const searchResults = filtered.map(
        ({ row, score }: { row: ChunkRow; score: number }) =>
          this.rowToSearchResult(row, score, 'hybrid'),
      );

      log.debug('searchHybrid:complete:native', { resultCount: searchResults.length });
      return searchResults;
    } catch (error) {
      log.warn('searchHybrid:native:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback to application-level fusion
      return this.searchHybridFallback(query, embedding, filters, limit, weights, rrfK, options);
    }
  }

  private async searchHybridFallback(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
    weights: HybridSearchWeights = { semantic: 0.5, keyword: 0.5 },
    rrfK = 60,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    // Run semantic and keyword searches in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.searchSemantic(embedding, filters, 50),
      this.searchKeyword(query, filters, 50, options),
    ]);

    // Merge using RRF
    return this.fuseWithRRF(semanticResults, keywordResults, weights, rrfK, limit);
  }

  private fuseWithRRF(
    semanticResults: SearchResult[],
    keywordResults: SearchResult[],
    weights: HybridSearchWeights,
    rrfK: number,
    limit: number,
  ): SearchResult[] {
    // Create maps for rank lookup
    const semanticRank = new Map<string, number>();
    const keywordRank = new Map<string, number>();

    semanticResults.forEach((r, i) => semanticRank.set(r.chunkId, i + 1));
    keywordResults.forEach((r, i) => keywordRank.set(r.chunkId, i + 1));

    // Collect all unique chunks
    const allChunks = new Map<string, SearchResult>();
    for (const r of semanticResults) allChunks.set(r.chunkId, r);
    for (const r of keywordResults) {
      if (!allChunks.has(r.chunkId)) {
        allChunks.set(r.chunkId, r);
      }
    }

    // Calculate RRF scores
    const scored: Array<{ result: SearchResult; score: number; matchType: string }> = [];

    for (const [chunkId, result] of allChunks) {
      const semRank = semanticRank.get(chunkId);
      const kwRank = keywordRank.get(chunkId);

      const semScore = semRank ? weights.semantic / (rrfK + semRank) : 0;
      const kwScore = kwRank ? weights.keyword / (rrfK + kwRank) : 0;
      const totalScore = semScore + kwScore;

      let matchType = 'keyword';
      if (semRank && kwRank) matchType = 'hybrid';
      else if (semRank) matchType = 'semantic';

      scored.push({
        result: { ...result, matchType: matchType as 'hybrid' | 'semantic' | 'keyword' },
        score: totalScore,
        matchType,
      });
    }

    // Sort by score and return top results
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map((s) => ({
      ...s.result,
      score: s.score,
    }));
  }

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  async enqueueItem(input: CreateQueueItemInput): Promise<QueueItem> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) {
      throw new Error('Queue table not initialized');
    }

    const id = generateId();
    const now = Date.now();

    // Check if item already exists
    const existing = await this.getQueueItemByPath(input.filePath);
    if (existing) {
      // Update existing
      return this.updateQueueItem(existing.id, {
        status: 'pending',
        attempts: 0,
        lastError: null,
        startedAt: null,
        completedAt: null,
      });
    }

    const row: QueueRow = {
      id,
      file_path: input.filePath,
      file_size: input.fileSize ?? 0,
      priority: input.priority ?? 'markup',
      status: 'pending',
      attempts: 0,
      last_error: '', // Empty string represents null
      created_at: now,
      started_at: 0, // 0 represents null
      completed_at: 0, // 0 represents null
    };

    await this.queueTable.add([row]);
    this._dirty = true;

    return this.rowToQueueItem(row);
  }

  async enqueueItems(inputs: CreateQueueItemInput[]): Promise<QueueItem[]> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) {
      throw new Error('Queue table not initialized');
    }

    if (inputs.length === 0) {
      return [];
    }

    log.debug('enqueueItems', { count: inputs.length });

    // The sync logic already filters to only new/modified files,
    // so we can just insert directly without deduplication
    const now = Date.now();
    const rows: QueueRow[] = inputs.map((input) => ({
      id: generateId(),
      file_path: input.filePath,
      file_size: input.fileSize ?? 0,
      priority: input.priority ?? 'markup',
      status: 'pending',
      attempts: 0,
      last_error: '',
      created_at: now,
      started_at: 0,
      completed_at: 0,
    }));

    // Single batch insert - LanceDB handles this efficiently
    await this.queueTable.add(rows);
    this._dirty = true;

    log.debug('enqueueItems:done', { count: rows.length });

    return rows.map((row) => this.rowToQueueItem(row));
  }

  async dequeueItem(): Promise<QueueItem | null> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) {
      return null;
    }

    try {
      // Query pending items by priority order (most important first)
      // We query each priority level until we find items, avoiding full table scans
      const priorities = ['text', 'markup', 'pdf', 'image', 'ocr'];

      let item: QueueRow | null = null;

      for (const priority of priorities) {
        const results = await this.queueTable
          .query()
          .where(`status = 'pending' AND priority = '${priority}'`)
          .limit(100) // Small limit - we just need one, but get a few to sort by size
          .toArray();

        if (results.length > 0) {
          // Sort by file size (smallest first) and pick the first
          const sorted = (results as QueueRow[]).sort((a, b) => a.file_size - b.file_size);
          item = sorted[0];
          break;
        }
      }

      if (!item) return null;

      // Update to processing
      await this.queueTable.update({
        where: `id = '${this.escapeString(item.id)}'`,
        values: {
          status: 'processing',
          started_at: Date.now(),
          attempts: item.attempts + 1,
        } as Record<string, lancedb.IntoSql>,
      });

      this._dirty = true;

      return this.rowToQueueItem({
        ...item,
        status: 'processing',
        started_at: Date.now(),
        attempts: item.attempts + 1,
      });
    } catch (error) {
      log.warn('dequeueItem:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async updateQueueItem(id: string, updates: UpdateQueueItemInput): Promise<QueueItem> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) {
      throw new Error('Queue table not initialized');
    }

    const values: Record<string, unknown> = {};

    if (updates.status !== undefined) values.status = updates.status;
    if (updates.attempts !== undefined) values.attempts = updates.attempts;
    if (updates.lastError !== undefined) values.last_error = updates.lastError ?? '';
    if (updates.startedAt !== undefined) {
      values.started_at = updates.startedAt?.getTime() ?? 0;
    }
    if (updates.completedAt !== undefined) {
      values.completed_at = updates.completedAt?.getTime() ?? 0;
    }

    await this.queueTable.update({
      where: `id = '${this.escapeString(id)}'`,
      values: values as Record<string, lancedb.IntoSql>,
    });

    this._dirty = true;

    // Construct result from updates without querying
    // This is faster and the caller usually doesn't need the full item
    const now = Date.now();
    return {
      id,
      filePath: '', // Not needed by callers
      fileSize: 0,
      priority: 'text' as QueuePriority,
      status: (updates.status ?? 'pending') as QueueItem['status'],
      attempts: updates.attempts ?? 0,
      lastError: updates.lastError ?? null,
      createdAt: new Date(now),
      startedAt: updates.startedAt ?? null,
      completedAt: updates.completedAt ?? null,
    };
  }

  async deleteQueueItem(id: string): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) return;

    await this.queueTable.delete(`id = '${this.escapeString(id)}'`);
    this._dirty = true;
  }

  async getQueueItemByPath(filePath: string): Promise<QueueItem | null> {
    await this.waitForReady();

    if (!this.queueTable) return null;

    try {
      const results = await this.queueTable
        .query()
        .where(`file_path = '${this.escapeString(filePath)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      return this.rowToQueueItem(results[0] as QueueRow);
    } catch {
      return null;
    }
  }

  async getQueueStatus(): Promise<QueueStatus> {
    await this.waitForReady();

    const statusCounts: Record<string, number> = {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
    };

    const priorityCounts: Record<QueuePriority, number> = {
      text: 0,
      markup: 0,
      pdf: 0,
      image: 0,
      ocr: 0,
    };

    if (this.queueTable) {
      try {
        // Fast check: just see if there are any pending or processing items
        // This is the common case when the pipeline checks if it should exit
        const pendingCheck = await this.queueTable
          .query()
          .where("status = 'pending'")
          .limit(1)
          .toArray();

        const processingCheck = await this.queueTable
          .query()
          .where("status = 'processing'")
          .limit(1)
          .toArray();

        // If there are pending or processing items, use countRows for accurate count
        // Otherwise return zeros quickly
        if (pendingCheck.length > 0 || processingCheck.length > 0) {
          // Get total count
          const totalCount = await this.queueTable.countRows();

          // Count completed and failed (usually smaller sets)
          const completedResults = await this.queueTable
            .query()
            .where("status = 'completed'")
            .limit(QUERY_ALL_LIMIT)
            .toArray();
          statusCounts.completed = completedResults.length;

          const failedResults = await this.queueTable
            .query()
            .where("status = 'failed'")
            .limit(QUERY_ALL_LIMIT)
            .toArray();
          statusCounts.failed = failedResults.length;

          // Derive pending and processing from total
          statusCounts.processing = processingCheck.length > 0 ? 1 : 0; // Approximate
          statusCounts.pending = totalCount - statusCounts.completed - statusCounts.failed - statusCounts.processing;

          // For priority counts, we don't need accurate counts during indexing
          // Just note that there are pending items
          if (statusCounts.pending > 0) {
            priorityCounts.text = statusCounts.pending; // Approximate
          }
        }
      } catch {
        // Ignore errors
      }
    }

    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    return {
      total,
      pending: statusCounts.pending,
      processing: statusCounts.processing,
      completed: statusCounts.completed,
      failed: statusCounts.failed,
      byPriority: priorityCounts,
    };
  }

  async clearCompletedQueueItems(): Promise<number> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) return 0;

    try {
      const results = await this.queueTable
        .query()
        .where("status = 'completed'")
        .limit(QUERY_ALL_LIMIT)
        .toArray();

      const count = results.length;

      if (count > 0) {
        await this.queueTable.delete("status = 'completed'");
        this._dirty = true;
      }

      return count;
    } catch {
      return 0;
    }
  }

  async clearQueue(): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.queueTable) return;

    try {
      // Delete all by using a true condition
      const results = await this.queueTable.query().limit(QUERY_ALL_LIMIT).toArray();
      for (const row of results as QueueRow[]) {
        await this.queueTable.delete(`id = '${this.escapeString(row.id)}'`);
      }
      this._dirty = true;
    } catch (error) {
      log.warn('clearQueue:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async getFileHashes(): Promise<Map<string, string>> {
    await this.waitForReady();

    const map = new Map<string, string>();

    // Include pending documents
    for (const pending of this.pendingDocuments.values()) {
      map.set(pending.input.filePath, pending.input.fileHash);
    }

    if (this.chunksTable) {
      try {
        const results = await this.chunksTable.query().limit(QUERY_ALL_LIMIT).toArray();
        const seenDocs = new Set<string>();

        for (const row of results) {
          const chunkRow = row as ChunkRow;
          if (!seenDocs.has(chunkRow.document_id)) {
            seenDocs.add(chunkRow.document_id);
            map.set(chunkRow.file_path, chunkRow.file_hash);
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return map;
  }

  async getDocumentsModifiedSince(date: Date): Promise<Document[]> {
    await this.waitForReady();

    const timestamp = date.getTime();
    const documents: Document[] = [];
    const seenIds = new Set<string>();

    // Include pending documents
    for (const pending of this.pendingDocuments.values()) {
      if (pending.input.fileModifiedAt.getTime() > timestamp) {
        const doc = await this.getDocument(pending.id);
        if (doc) {
          documents.push(doc);
          seenIds.add(doc.id);
        }
      }
    }

    if (this.chunksTable) {
      try {
        const results = await this.chunksTable
          .query()
          .where(`file_modified_at > ${timestamp}`)
          .limit(QUERY_ALL_LIMIT)
          .toArray();

        for (const row of results) {
          const chunkRow = row as ChunkRow;
          if (!seenIds.has(chunkRow.document_id)) {
            seenIds.add(chunkRow.document_id);
            documents.push(this.rowToDocument(chunkRow));
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return documents.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async getStats(): Promise<SearchStats> {
    await this.waitForReady();

    let totalDocuments = 0;
    let totalChunks = 0;
    let indexedDocuments = 0;
    let pendingDocuments = 0;
    let failedDocuments = 0;
    let ocrPending = 0;
    let totalFileSize = 0;
    let totalTags = 0;

    const seenDocs = new Set<string>();
    const seenTags = new Set<string>();

    // Count pending documents
    for (const pending of this.pendingDocuments.values()) {
      totalDocuments++;
      totalFileSize += pending.input.fileSize;
      if (pending.input.status === 'indexed') indexedDocuments++;
      else if (pending.input.status === 'pending') pendingDocuments++;
      else if (pending.input.status === 'failed') failedDocuments++;
      if (pending.input.ocrStatus === 'pending') ocrPending++;
      for (const tag of pending.tags) seenTags.add(tag);
      seenDocs.add(pending.id);
    }

    if (this.chunksTable) {
      try {
        totalChunks = await this.chunksTable.countRows();

        const results = await this.chunksTable.query().limit(QUERY_ALL_LIMIT).toArray();

        for (const row of results) {
          const chunkRow = row as ChunkRow;
          if (!seenDocs.has(chunkRow.document_id)) {
            seenDocs.add(chunkRow.document_id);
            totalDocuments++;
            totalFileSize += chunkRow.file_size;
            if (chunkRow.status === 'indexed') indexedDocuments++;
            else if (chunkRow.status === 'pending') pendingDocuments++;
            else if (chunkRow.status === 'failed') failedDocuments++;
            if (chunkRow.ocr_status === 'pending') ocrPending++;
            const tags: string[] = JSON.parse(chunkRow.tags || '[]');
            for (const tag of tags) seenTags.add(tag);
          }
        }
      } catch {
        // Ignore errors
      }
    }

    totalTags = seenTags.size;

    return {
      totalDocuments,
      totalChunks,
      indexedDocuments,
      pendingDocuments,
      failedDocuments,
      ocrPending,
      totalTags,
      databaseSize: totalFileSize,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  async getConfigValue<T>(key: string): Promise<T | null> {
    await this.waitForReady();

    if (!this.configTable) return null;

    try {
      const results = await this.configTable
        .query()
        .where(`key = '${this.escapeString(key)}'`)
        .limit(1)
        .toArray();

      if (results.length === 0) return null;

      const row = results[0] as ConfigRow;
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  async setConfigValue<T>(key: string, value: T): Promise<void> {
    await this.waitForReady();
    this.ensureWritable();

    if (!this.configTable) return;

    const now = Date.now();
    const jsonValue = JSON.stringify(value);

    try {
      // Check if exists
      const results = await this.configTable
        .query()
        .where(`key = '${this.escapeString(key)}'`)
        .limit(1)
        .toArray();

      if (results.length > 0) {
        await this.configTable.update({
          where: `key = '${this.escapeString(key)}'`,
          values: { value: jsonValue, updated_at: now } as Record<string, lancedb.IntoSql>,
        });
      } else {
        await this.configTable.add([
          { key, value: jsonValue, updated_at: now } as Record<string, unknown>,
        ]);
      }

      this._dirty = true;
    } catch (error) {
      log.warn('setConfigValue:failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Raw Query
  // -------------------------------------------------------------------------

  async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    // LanceDB doesn't support raw SQL queries
    log.warn('query:notSupported', { reason: 'LanceDB does not support raw SQL' });
    return [];
  }

  async execute(_sql: string, _params?: unknown[]): Promise<void> {
    // LanceDB doesn't support raw SQL execution
    log.warn('execute:notSupported', { reason: 'LanceDB does not support raw SQL' });
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  async recoverStuckDocuments(): Promise<number> {
    await this.waitForReady();

    if (!this.chunksTable) return 0;

    try {
      // Find documents stuck in intermediate states
      const results = await this.chunksTable.query().limit(QUERY_ALL_LIMIT).toArray();
      const stuckDocs = new Map<string, ChunkRow>();

      for (const row of results) {
        const chunkRow = row as ChunkRow;
        const status = chunkRow.status;
        if (['parsing', 'chunking', 'embedding'].includes(status)) {
          if (!stuckDocs.has(chunkRow.document_id)) {
            stuckDocs.set(chunkRow.document_id, chunkRow);
          }
        }
      }

      if (stuckDocs.size === 0) return 0;

      log.info('recoverStuckDocuments:found', { count: stuckDocs.size });

      let recoveredCount = 0;

      for (const [docId, row] of stuckDocs) {
        try {
          // Delete chunks
          await this.chunksTable.delete(`document_id = '${this.escapeString(docId)}'`);

          // Re-queue for indexing
          await this.enqueueItem({
            filePath: row.file_path,
            fileSize: row.file_size,
            priority: 'text',
          });

          recoveredCount++;
          log.info('recoverStuckDocuments:recovered', {
            documentId: docId,
            filePath: row.file_path,
          });
        } catch (error) {
          log.error('recoverStuckDocuments:error', {
            documentId: docId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (recoveredCount > 0) this._dirty = true;

      return recoveredCount;
    } catch (error) {
      log.error('recoverStuckDocuments:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private escapeString(value: string): string {
    // Escape single quotes for SQL-like where clauses
    return value.replace(/'/g, "''");
  }

  private rowToDocument(row: ChunkRow): Document {
    return {
      id: row.document_id,
      filePath: row.file_path,
      fileName: row.file_name,
      fileExtension: row.file_extension,
      fileSize: row.file_size,
      fileHash: row.file_hash,
      mimeType: row.mime_type || null, // '' -> null
      title: row.title || null, // '' -> null
      author: row.author || null, // '' -> null
      language: row.language || null, // '' -> null
      pageCount: row.page_count || null, // 0 -> null
      status: row.status as Document['status'],
      ocrStatus: row.ocr_status as Document['ocrStatus'],
      indexedAt: row.indexed_at ? new Date(row.indexed_at) : null, // 0 -> null
      fileModifiedAt: new Date(row.file_modified_at),
      createdAt: new Date(row.doc_created_at),
      updatedAt: new Date(row.doc_updated_at),
      metadata: JSON.parse(row.metadata || '{}'),
      tags: JSON.parse(row.tags || '[]'),
    };
  }

  private rowToChunk(row: ChunkRow): DocumentChunk {
    return {
      id: row.chunk_id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      embedding: null, // Don't return full vectors for performance
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      page: row.page || null, // 0 -> null
      section: row.section || null, // '' -> null
      tokenCount: row.token_count || null, // 0 -> null
      createdAt: new Date(row.chunk_created_at),
    };
  }

  private rowToQueueItem(row: QueueRow): QueueItem {
    return {
      id: row.id,
      filePath: row.file_path,
      fileSize: row.file_size,
      priority: row.priority as QueuePriority,
      status: row.status as QueueItem['status'],
      attempts: row.attempts,
      lastError: row.last_error || null, // Empty string -> null
      createdAt: new Date(row.created_at),
      startedAt: row.started_at ? new Date(row.started_at) : null, // 0 -> null
      completedAt: row.completed_at ? new Date(row.completed_at) : null, // 0 -> null
    };
  }

  private rowToSearchResult(
    row: ChunkRow,
    score: number,
    matchType: 'semantic' | 'keyword' | 'hybrid',
  ): SearchResult {
    return {
      documentId: row.document_id,
      chunkId: row.chunk_id,
      filePath: row.file_path,
      fileName: row.file_name,
      chunkText: row.text,
      score,
      matchType,
      highlights: [],
      metadata: {
        page: row.page,
        section: row.section,
        tags: JSON.parse(row.tags || '[]'),
      },
    };
  }

  private matchesFilters(doc: Document, filters?: Partial<SearchFilters>): boolean {
    if (!filters) return true;

    if (filters.folders && filters.folders.length > 0) {
      const normalizedPath = doc.filePath.replace(/\\/g, '/');
      if (!filters.folders.some((f) => normalizedPath.includes(f.replace(/\\/g, '/')))) {
        return false;
      }
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const ext = doc.fileExtension.toLowerCase();
      if (!filters.fileTypes.some((t) => {
        const normalized = t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`;
        return ext === normalized;
      })) {
        return false;
      }
    }

    if (filters.status && filters.status.length > 0) {
      if (!filters.status.includes(doc.status)) {
        return false;
      }
    }

    if (filters.dateFrom && doc.fileModifiedAt < filters.dateFrom) {
      return false;
    }

    if (filters.dateTo && doc.fileModifiedAt > filters.dateTo) {
      return false;
    }

    if (filters.languages && filters.languages.length > 0) {
      if (!doc.language || !filters.languages.includes(doc.language)) {
        return false;
      }
    }

    return true;
  }

  private matchesSearchFilters(row: ChunkRow, filters?: SearchFilters): boolean {
    if (!filters) return true;

    if (filters.folders && filters.folders.length > 0) {
      const normalizedPath = row.file_path.replace(/\\/g, '/');
      if (!filters.folders.some((f) => normalizedPath.includes(f.replace(/\\/g, '/')))) {
        return false;
      }
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const ext = row.file_extension.toLowerCase();
      if (!filters.fileTypes.some((t) => {
        const normalized = t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`;
        return ext === normalized;
      })) {
        return false;
      }
    }

    if (filters.tags && filters.tags.length > 0) {
      const rowTags: string[] = JSON.parse(row.tags || '[]');
      if (!filters.tags.some((t) => rowTags.includes(t))) {
        return false;
      }
    }

    if (filters.dateFrom) {
      if (row.file_modified_at < filters.dateFrom.getTime()) {
        return false;
      }
    }

    if (filters.dateTo) {
      if (row.file_modified_at > filters.dateTo.getTime()) {
        return false;
      }
    }

    if (filters.languages && filters.languages.length > 0) {
      if (!row.language || !filters.languages.includes(row.language)) {
        return false;
      }
    }

    return true;
  }

  private buildDocumentFilterWhere(filters?: Partial<SearchFilters>): string | null {
    if (!filters) return null;

    const conditions: string[] = [];

    if (filters.status && filters.status.length > 0) {
      const statusConditions = filters.status.map(
        (s) => `status = '${this.escapeString(s)}'`,
      );
      conditions.push(`(${statusConditions.join(' OR ')})`);
    }

    if (filters.languages && filters.languages.length > 0) {
      const langConditions = filters.languages.map(
        (l) => `language = '${this.escapeString(l)}'`,
      );
      conditions.push(`(${langConditions.join(' OR ')})`);
    }

    if (conditions.length === 0) return null;

    return conditions.join(' AND ');
  }
}
