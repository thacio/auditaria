/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

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
import {
  LIBSQL_BASE_SCHEMA_SQL,
  getLibSQLChunksTableSQL,
  LIBSQL_FTS5_TABLE_SQL,
  LIBSQL_FTS5_TRIGGERS_SQL,
  getLibSQLVectorIndexSQL,
  LIBSQL_FTS5_REBUILD_SQL,
  LIBSQL_FTS5_OPTIMIZE_SQL,
  LIBSQL_DROP_VECTOR_INDEX_SQL,
  type LibSQLVectorOptions,
  type LibSQLVectorType,
} from './libsql-schema.js';
import {
  readMetadata,
  writeMetadata,
  createMetadata,
  getDatabaseFilePath,
  ensureDatabaseDirectory,
  type MetadataEmbeddings,
  type DatabaseMetadata,
} from './metadata.js';
import type {
  DatabaseConfig,
  VectorIndexConfig,
  HybridSearchStrategy,
} from '../config.js';
import {
  DEFAULT_VECTOR_INDEX_CONFIG,
  DEFAULT_SEARCH_CONFIG,
} from '../config.js';
import { createModuleLogger } from '../core/Logger.js';
import type { LibSQLBackendOptions } from '../config/backend-options.js';
import { DEFAULT_LIBSQL_OPTIONS } from '../config/backend-options.js';

const log = createModuleLogger('LibSQLStorage');

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

/**
 * Convert a number array to a JSON string for libSQL vector() function.
 * libSQL expects vectors in JSON array format: '[1.0, 2.0, 3.0]'
 */
function vectorToJson(embedding: number[]): string {
  return JSON.stringify(embedding);
}

// ============================================================================
// Row Types (database representation)
// ============================================================================

interface DocumentRow {
  id: string;
  file_path: string;
  file_name: string;
  file_extension: string;
  file_size: number;
  file_hash: string;
  mime_type: string | null;
  title: string | null;
  author: string | null;
  language: string | null;
  page_count: number | null;
  status: string;
  ocr_status: string;
  indexed_at: string | null;
  file_modified_at: string;
  created_at: string;
  updated_at: string;
  metadata: string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  rowid: number;
  start_offset: number;
  end_offset: number;
  page: number | null;
  section: string | null;
  token_count: number | null;
  created_at: string;
}

interface QueueItemRow {
  id: string;
  file_path: string;
  file_size: number;
  priority: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface TagCountRow {
  tag: string;
  count: number;
}

interface StatsRow {
  total_documents: number;
  indexed_documents: number;
  pending_documents: number;
  failed_documents: number;
  ocr_pending: number;
  total_file_size: number;
}

interface SearchResultRow {
  chunk_id: string;
  document_id: string;
  file_path: string;
  file_name: string;
  chunk_text: string;
  highlighted_text?: string;
  page: number | null;
  section: string | null;
  score: number;
  match_type: string;
}

interface _VectorResultRow {
  id: number;
  distance: number;
}

// ============================================================================
// LibSQL Database Type (better-sqlite3 compatible API)
// ============================================================================

// Note: libsql package provides a better-sqlite3 compatible API
// but doesn't ship with TypeScript declarations. We define our own interface.
interface LibSQLDatabase {
  prepare(sql: string): LibSQLStatement;
  exec(sql: string): void;
  pragma(pragma: string, options?: { simple?: boolean }): unknown;
  transaction<F extends (...args: unknown[]) => unknown>(fn: F): F;
  close(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function(name: string, fn: (...args: any[]) => any): void;
}

interface LibSQLStatement {
  run(...params: unknown[]): {
    changes: number;
    lastInsertRowid: bigint | number;
  };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ============================================================================
// LibSQL Storage Adapter
// ============================================================================

export class LibSQLStorage implements StorageAdapter {
  private db: LibSQLDatabase | null = null;
  private config: DatabaseConfig;
  private vectorIndexConfig: VectorIndexConfig;
  private embeddingDimensions: number;
  private hybridStrategy: HybridSearchStrategy;
  private backendOptions: LibSQLBackendOptions;
  private _initialized = false;
  private _dirty = false;
  private _readOnly = false;
  private _suspended = false;
  private _vectorIndexCreated = false;
  /** The SQL function to use for vector conversion: 'vector' (F32) or 'vector16' (F16) */
  private _vectorFunc: 'vector' | 'vector16' = 'vector';

  constructor(
    config: DatabaseConfig,
    vectorIndexConfig?: VectorIndexConfig,
    embeddingDimensions?: number,
    hybridStrategy?: HybridSearchStrategy,
    backendOptions?: Partial<LibSQLBackendOptions>,
  ) {
    this.config = config;
    this.vectorIndexConfig = vectorIndexConfig ?? DEFAULT_VECTOR_INDEX_CONFIG;
    this.embeddingDimensions = embeddingDimensions ?? 384;
    this.hybridStrategy =
      hybridStrategy ?? DEFAULT_SEARCH_CONFIG.hybridStrategy;
    this.backendOptions = { ...DEFAULT_LIBSQL_OPTIONS, ...backendOptions };
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

    // Ensure database directory exists (we use directory-based storage like PGlite)
    if (!this.config.inMemory && this.config.path) {
      ensureDatabaseDirectory(this.config.path);
    }

    // Dynamically import libsql (better-sqlite3 compatible API)
    try {
      const { default: Database } = await import('libsql');

      // Get actual database file path (inside the directory)
      const dbFilePath = this.config.inMemory
        ? ':memory:'
        : getDatabaseFilePath(this.config.path, 'libsql');

      this.db = new Database(dbFilePath) as unknown as LibSQLDatabase;
      log.info('initialize:database:opened', { dbFilePath });
    } catch (error) {
      log.error('initialize:database:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Failed to initialize libSQL database: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Memory optimization pragmas
    this.db.pragma('journal_mode = WAL'); // Better write performance, safe with synchronous=normal
    this.db.pragma('synchronous = normal'); // Less fsync, still corruption-safe in WAL mode
    this.db.pragma('cache_size = -16000'); // Limit page cache to ~16MB (negative = KB)
    this.db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O (OS manages efficiently)

    // Note: libsql doesn't support custom functions like better-sqlite3
    // We rely on libSQL's native vector_distance_cos() function instead

    // Create schema
    await this.createSchema();

    // Create metadata file if it doesn't exist (for new databases)
    if (!this.config.inMemory && this.config.path) {
      const existingMetadata = readMetadata(this.config.path);
      if (!existingMetadata) {
        const metadata = createMetadata(
          'libsql',
          {
            type: this.vectorIndexConfig.type,
            useHalfVec: this.vectorIndexConfig.useHalfVec,
            createIndex: this.vectorIndexConfig.createIndex ?? true,
            hnswM: this.vectorIndexConfig.hnswM,
            hnswEfConstruction: this.vectorIndexConfig.hnswEfConstruction,
            ivfflatLists:
              this.vectorIndexConfig.ivfflatLists === 'auto'
                ? undefined
                : this.vectorIndexConfig.ivfflatLists,
            ivfflatProbes: this.vectorIndexConfig.ivfflatProbes,
          },
          {
            model: 'unknown', // Will be updated by SearchSystem
            dimensions: this.embeddingDimensions,
            quantization: 'q8', // Default, will be updated by SearchSystem
          },
          // Save backend-specific options for this database
          { backend: 'libsql', ...this.backendOptions },
        );
        writeMetadata(this.config.path, metadata);
        log.info('initialize:created_metadata', {
          type: this.vectorIndexConfig.type,
          useHalfVec: this.vectorIndexConfig.useHalfVec,
          dimensions: this.embeddingDimensions,
          backendOptions: this.backendOptions,
        });
      }
    }

    this._initialized = true;
    log.info('initialize:complete');
  }

  private async createSchema(): Promise<void> {
    if (!this.db) return;

    // Create base tables
    this.db.exec(LIBSQL_BASE_SCHEMA_SQL);

    // Determine vector type based on useHalfVec config
    const vectorType: LibSQLVectorType = this.vectorIndexConfig.useHalfVec
      ? 'F16_BLOB'
      : 'F32_BLOB';

    // Set the vector function to use for this storage instance
    this._vectorFunc = this.vectorIndexConfig.useHalfVec
      ? 'vector16'
      : 'vector';

    // Create chunks table with vector column
    const chunksSQL = getLibSQLChunksTableSQL(
      this.embeddingDimensions,
      vectorType,
    );
    this.db.exec(chunksSQL);
    log.info('createSchema:chunks:created', {
      dimensions: this.embeddingDimensions,
      vectorType,
      vectorFunc: this._vectorFunc,
    });

    // Create FTS5 virtual table
    try {
      this.db.exec(LIBSQL_FTS5_TABLE_SQL);
      log.info('createSchema:fts5:created');
    } catch (error) {
      log.warn('createSchema:fts5:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Create FTS5 triggers
    try {
      this.db.exec(LIBSQL_FTS5_TRIGGERS_SQL);
      log.info('createSchema:fts5Triggers:created');
    } catch (error) {
      log.warn('createSchema:fts5Triggers:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Create vector index if configured
    const shouldCreateVectorIndex =
      this.vectorIndexConfig.createIndex !== false &&
      this.vectorIndexConfig.type !== 'none';

    if (shouldCreateVectorIndex) {
      await this.createVectorIndex();
    } else {
      log.info('createSchema:vectorIndex:skipped', {
        reason: 'Vector index disabled in config',
      });
    }
  }

  private async createVectorIndex(): Promise<void> {
    if (!this.db || this._vectorIndexCreated) return;

    const vectorType: LibSQLVectorType = this.vectorIndexConfig.useHalfVec
      ? 'F16_BLOB'
      : 'F32_BLOB';

    const options: LibSQLVectorOptions = {
      dimensions: this.embeddingDimensions,
      metric: this.backendOptions.metric,
      createIndex: true,
      vectorType,
      compressNeighbors: this.backendOptions.compressNeighbors,
      maxNeighbors: this.backendOptions.maxNeighbors,
    };

    try {
      const indexSQL = getLibSQLVectorIndexSQL(options);
      log.info('createVectorIndex:sql', { sql: indexSQL });
      this.db.exec(indexSQL);
      this._vectorIndexCreated = true;
      log.info('createVectorIndex:complete', {
        dimensions: this.embeddingDimensions,
        metric: options.metric,
      });
    } catch (error) {
      log.error('createVectorIndex:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Vector index creation failed - will fall back to brute force search
      // Error already logged above via log.error
    }
  }

  async close(): Promise<void> {
    if (!this.db) return;

    log.info('close:start');

    // Optimize FTS5 before closing
    try {
      this.db.exec(LIBSQL_FTS5_OPTIMIZE_SQL);
    } catch {
      // Ignore errors
    }

    // Checkpoint WAL to flush all data to main database file
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Ignore errors
    }

    // Ask SQLite to release as much memory as possible
    try {
      this.db.pragma('shrink_memory');
    } catch {
      // Ignore errors
    }

    this.db.close();
    this.db = null;
    this._initialized = false;

    // Aggressively trigger garbage collection to release the native libsql::Database handle
    // The Rust Drop impl only runs when V8 collects the JS Database object
    if (typeof global.gc === 'function') {
      global.gc();
      // Second pass after a microtask to catch weak refs
      await new Promise((resolve) => setImmediate(resolve));
      global.gc();
    }

    log.info('close:complete');
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Update the embeddings configuration in metadata.
   * Called by SearchSystem after embedder initialization to store full config.
   */
  updateMetadataEmbeddings(embeddings: MetadataEmbeddings): void {
    const dbPath = this.config.path;
    if (!dbPath || this.config.inMemory) return;

    const metadata = readMetadata(dbPath);
    if (metadata) {
      metadata.embeddings = embeddings;
      writeMetadata(dbPath, metadata);
      log.info('updateMetadataEmbeddings:updated', {
        model: embeddings.model,
        quantization: embeddings.quantization,
      });
    }
  }

  /**
   * Get the database metadata.
   */
  getMetadata(): DatabaseMetadata | null {
    const dbPath = this.config.path;
    if (!dbPath || this.config.inMemory) return null;
    return readMetadata(dbPath);
  }

  async checkpoint(): Promise<void> {
    if (!this.db) return;
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    log.debug('checkpoint:complete');
  }

  async vacuum(): Promise<void> {
    if (!this.db) return;
    this.db.exec('VACUUM');
    log.debug('vacuum:complete');
  }

  async reconnect(): Promise<void> {
    if (!this.db || !this._initialized) {
      return;
    }

    log.info('reconnect:start');
    log.logMemory('reconnect:memoryBefore');

    try {
      // Checkpoint WAL to ensure all data is flushed
      this.db.pragma('wal_checkpoint(TRUNCATE)');

      // Ask SQLite to release as much memory as possible before closing
      try {
        this.db.pragma('shrink_memory');
      } catch {
        // Ignore errors
      }

      // Close the database
      // Unlike vectorlite, libSQL vectors are stored in the DB file itself
      // so there's no external index file to worry about
      this.db.close();
      this.db = null;
      this._initialized = false;
      this._vectorIndexCreated = false;

      // Aggressively trigger garbage collection to release the native libsql::Database handle
      // The Rust Drop impl only runs when V8 collects the JS Database object
      if (typeof global.gc === 'function') {
        global.gc();
        // Second pass after a microtask to catch weak refs
        await new Promise((resolve) => setImmediate(resolve));
        global.gc();
      }

      log.logMemory('reconnect:afterClose');

      // Reopen the database
      const { default: Database } = await import('libsql');
      const dbFilePath = this.config.inMemory
        ? ':memory:'
        : getDatabaseFilePath(this.config.path, 'libsql');
      this.db = new Database(dbFilePath) as unknown as LibSQLDatabase;

      // Re-enable foreign keys and memory optimization pragmas
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = normal');
      this.db.pragma('cache_size = -16000');
      this.db.pragma('mmap_size = 268435456');

      // Check if vector index exists
      try {
        const indexCheck = this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunks_embedding'",
          )
          .get() as { name: string } | undefined;
        this._vectorIndexCreated = !!indexCheck;
      } catch {
        this._vectorIndexCreated = false;
      }

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
          error:
            initError instanceof Error ? initError.message : String(initError),
        });
        throw initError;
      }
    }
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    this._readOnly = readOnly;
  }

  isReadOnly(): boolean {
    return this._readOnly;
  }

  async suspend(): Promise<void> {
    if (!this.db || this._suspended) return;

    log.info('suspend:start');
    this.db.close();
    this.db = null;
    this._suspended = true;
    log.info('suspend:complete');
  }

  async resume(): Promise<void> {
    if (!this._suspended) return;

    log.info('resume:start');
    this._suspended = false;
    this._initialized = false;
    await this.initialize();
    log.info('resume:complete');
  }

  isSuspended(): boolean {
    return this._suspended;
  }

  async refresh(): Promise<void> {
    await this.checkpoint();
  }

  private ensureReady(): void {
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
    this.ensureReady();
    this.ensureWritable();

    const id = generateId();
    const now = new Date().toISOString();

    const stmt = this.db!.prepare(`
      INSERT INTO documents (
        id, file_path, file_name, file_extension, file_size, file_hash,
        mime_type, title, author, language, page_count, status, ocr_status,
        file_modified_at, created_at, updated_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      input.filePath,
      input.fileName,
      input.fileExtension,
      input.fileSize,
      input.fileHash,
      input.mimeType ?? null,
      input.title ?? null,
      input.author ?? null,
      input.language ?? null,
      input.pageCount ?? null,
      input.status ?? 'pending',
      input.ocrStatus ?? 'not_needed',
      input.fileModifiedAt.toISOString(),
      now,
      now,
      JSON.stringify(input.metadata ?? {}),
    );

    this._dirty = true;
    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Document not found after creation');
    return doc;
  }

  async getDocument(id: string): Promise<Document | null> {
    this.ensureReady();

    const row = this.db!.prepare('SELECT * FROM documents WHERE id = ?').get(
      id,
    ) as DocumentRow | undefined;

    if (!row) return null;
    return this.rowToDocument(row);
  }

  async getDocumentByPath(filePath: string): Promise<Document | null> {
    this.ensureReady();

    const row = this.db!.prepare(
      'SELECT * FROM documents WHERE file_path = ?',
    ).get(filePath) as DocumentRow | undefined;

    if (!row) return null;
    return this.rowToDocument(row);
  }

  async updateDocument(
    id: string,
    updates: UpdateDocumentInput,
  ): Promise<Document> {
    this.ensureReady();
    this.ensureWritable();

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [new Date().toISOString()];

    const fieldMap: Record<keyof UpdateDocumentInput, string> = {
      filePath: 'file_path',
      fileName: 'file_name',
      fileExtension: 'file_extension',
      fileSize: 'file_size',
      fileHash: 'file_hash',
      mimeType: 'mime_type',
      title: 'title',
      author: 'author',
      language: 'language',
      pageCount: 'page_count',
      status: 'status',
      ocrStatus: 'ocr_status',
      indexedAt: 'indexed_at',
      metadata: 'metadata',
    };

    for (const [key, column] of Object.entries(fieldMap)) {
      const value = updates[key as keyof UpdateDocumentInput];
      if (value !== undefined) {
        sets.push(`${column} = ?`);
        if (key === 'indexedAt' && value instanceof Date) {
          params.push(value.toISOString());
        } else if (key === 'metadata') {
          params.push(JSON.stringify(value));
        } else {
          params.push(value);
        }
      }
    }

    params.push(id);

    this.db!.prepare(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = ?`,
    ).run(...params);

    this._dirty = true;
    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Document not found after update');
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    this.db!.prepare('DELETE FROM documents WHERE id = ?').run(id);
    this._dirty = true;
  }

  async listDocuments(filters?: Partial<SearchFilters>): Promise<Document[]> {
    this.ensureReady();

    const { where, params } = this.buildDocumentFilters(filters);
    const rows = this.db!.prepare(
      `SELECT * FROM documents ${where} ORDER BY file_path`,
    ).all(...params) as DocumentRow[];

    return rows.map((row) => this.rowToDocument(row));
  }

  async countDocuments(filters?: Partial<SearchFilters>): Promise<number> {
    this.ensureReady();

    const { where, params } = this.buildDocumentFilters(filters);
    const result = this.db!.prepare(
      `SELECT COUNT(*) as count FROM documents ${where}`,
    ).get(...params) as { count: number };

    return result.count;
  }

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  async createChunks(
    documentId: string,
    chunks: CreateChunkInput[],
  ): Promise<DocumentChunk[]> {
    this.ensureReady();
    this.ensureWritable();

    log.debug('createChunks:start', { documentId, chunkCount: chunks.length });

    const createdChunks: DocumentChunk[] = [];
    const now = new Date().toISOString();

    const insertStmt = this.db!.prepare(`
      INSERT INTO chunks (
        id, document_id, chunk_index, text, start_offset, end_offset,
        page, section, token_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db!.transaction(() => {
      for (const chunk of chunks) {
        const id = generateId();

        insertStmt.run(
          id,
          documentId,
          chunk.chunkIndex,
          chunk.text,
          chunk.startOffset,
          chunk.endOffset,
          chunk.page ?? null,
          chunk.section ?? null,
          chunk.tokenCount ?? null,
          now,
        );

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
      }
    });

    transaction();
    this._dirty = true;

    log.debug('createChunks:complete', {
      documentId,
      chunkCount: chunks.length,
    });
    return createdChunks;
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    this.ensureReady();

    const rows = this.db!.prepare(
      'SELECT * FROM chunks WHERE document_id = ? ORDER BY chunk_index',
    ).all(documentId) as ChunkRow[];

    return rows.map((row) => this.rowToChunk(row));
  }

  async deleteChunks(documentId: string): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    this.db!.prepare('DELETE FROM chunks WHERE document_id = ?').run(
      documentId,
    );
    this._dirty = true;
  }

  async updateChunkEmbeddings(
    updates: UpdateChunkEmbeddingInput[],
  ): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    log.debug('updateChunkEmbeddings:start', {
      updateCount: updates.length,
      vectorIndexCreated: this._vectorIndexCreated,
    });

    // libSQL stores vectors using the vector() or vector16() function with JSON input
    // Use vector16() for F16_BLOB (half precision), vector() for F32_BLOB
    const updateStmt = this.db!.prepare(
      `UPDATE chunks SET embedding = ${this._vectorFunc}(?) WHERE id = ?`,
    );

    const transaction = this.db!.transaction(() => {
      for (const update of updates) {
        try {
          const vectorJson = vectorToJson(update.embedding);
          updateStmt.run(vectorJson, update.id);
        } catch (error) {
          log.warn('updateChunkEmbeddings:updateFailed', {
            chunkId: update.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    transaction();
    this._dirty = true;

    log.debug('updateChunkEmbeddings:complete', {
      updateCount: updates.length,
    });
  }

  async countChunks(): Promise<number> {
    this.ensureReady();

    const result = this.db!.prepare(
      'SELECT COUNT(*) as count FROM chunks',
    ).get() as { count: number };
    return result.count;
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async addTags(documentId: string, tags: string[]): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    const getTagStmt = this.db!.prepare('SELECT id FROM tags WHERE name = ?');
    const insertTagStmt = this.db!.prepare(
      'INSERT INTO tags (id, name) VALUES (?, ?)',
    );
    const linkTagStmt = this.db!.prepare(
      'INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)',
    );

    const transaction = this.db!.transaction(() => {
      for (const tagName of tags) {
        let tagRow = getTagStmt.get(tagName) as { id: string } | undefined;

        if (!tagRow) {
          const tagId = generateId();
          insertTagStmt.run(tagId, tagName);
          tagRow = { id: tagId };
        }

        linkTagStmt.run(documentId, tagRow.id);
      }
    });

    transaction();
    this._dirty = true;
  }

  async removeTags(documentId: string, tags: string[]): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    const getTagStmt = this.db!.prepare('SELECT id FROM tags WHERE name = ?');
    const unlinkTagStmt = this.db!.prepare(
      'DELETE FROM document_tags WHERE document_id = ? AND tag_id = ?',
    );

    const transaction = this.db!.transaction(() => {
      for (const tagName of tags) {
        const tagRow = getTagStmt.get(tagName) as { id: string } | undefined;
        if (tagRow) {
          unlinkTagStmt.run(documentId, tagRow.id);
        }
      }
    });

    transaction();
    this._dirty = true;
  }

  async getDocumentTags(documentId: string): Promise<string[]> {
    this.ensureReady();

    const rows = this.db!.prepare(
      `
      SELECT t.name FROM tags t
      JOIN document_tags dt ON t.id = dt.tag_id
      WHERE dt.document_id = ?
      ORDER BY t.name
    `,
    ).all(documentId) as Array<{ name: string }>;

    return rows.map((row) => row.name);
  }

  async getAllTags(): Promise<TagCount[]> {
    this.ensureReady();

    const rows = this.db!.prepare(
      `
      SELECT t.name as tag, COUNT(dt.document_id) as count
      FROM tags t
      LEFT JOIN document_tags dt ON t.id = dt.tag_id
      GROUP BY t.id, t.name
      ORDER BY count DESC, t.name
    `,
    ).all() as TagCountRow[];

    return rows.map((row) => ({
      tag: row.tag,
      count: row.count,
    }));
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit = 10,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    this.ensureReady();

    log.debug('searchKeyword:start', { queryLength: query.length, limit });

    // Convert query to FTS5 format
    const ftsQuery = this.convertToFTS5Query(
      query,
      options?.useWebSearchSyntax,
    );

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    try {
      // Use FTS5 with highlight() for highlighting
      const sql = `
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          highlight(chunks_fts, 0, '<mark>', '</mark>') as highlighted_text,
          c.page,
          c.section,
          bm25(chunks_fts) as score,
          'keyword' as match_type
        FROM chunks_fts
        JOIN chunks c ON chunks_fts.rowid = c.rowid
        JOIN documents d ON c.document_id = d.id
        WHERE chunks_fts MATCH ?
          AND d.status = 'indexed'
          ${filterWhere ? `AND ${filterWhere}` : ''}
        ORDER BY bm25(chunks_fts)
        LIMIT ?
      `;

      const params = [ftsQuery, ...filterParams, limit];
      const rows = this.db!.prepare(sql).all(...params) as SearchResultRow[];
      const results = this.rowsToSearchResults(rows);

      log.debug('searchKeyword:complete:fts', { resultCount: results.length });
      return results;
    } catch (error) {
      log.warn('searchKeyword:fts:failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to LIKE search
      return this.searchKeywordFallback(query, filters, limit);
    }
  }

  private searchKeywordFallback(
    query: string,
    filters?: SearchFilters,
    limit = 10,
  ): SearchResult[] {
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (searchTerms.length === 0) return [];

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    // Build LIKE conditions for each word
    const likeConditions = searchTerms
      .map(() => `LOWER(c.text) LIKE ?`)
      .join(' AND ');
    const likeParams = searchTerms.map((t) => `%${t}%`);

    const sql = `
      SELECT
        c.id as chunk_id,
        c.document_id,
        d.file_path,
        d.file_name,
        c.text as chunk_text,
        c.page,
        c.section,
        1.0 as score,
        'keyword' as match_type
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE ${likeConditions}
        AND d.status = 'indexed'
        ${filterWhere ? `AND ${filterWhere}` : ''}
      ORDER BY c.created_at DESC
      LIMIT ?
    `;

    const params = [...likeParams, ...filterParams, limit];
    const rows = this.db!.prepare(sql).all(...params) as SearchResultRow[];

    log.debug('searchKeyword:complete:fallback', { resultCount: rows.length });
    return this.rowsToSearchResults(rows);
  }

  private convertToFTS5Query(
    query: string,
    useWebSearchSyntax?: boolean,
  ): string {
    if (!useWebSearchSyntax) {
      // Simple mode: AND all terms
      const terms = query.split(/\s+/).filter((t) => t.length > 0);
      return terms.join(' AND ');
    }

    // Web search syntax mode
    let result = query;
    result = result.replace(/-(\w+)/g, 'NOT $1');
    return result;
  }

  async searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    this.ensureReady();

    log.debug('searchSemantic:start', {
      embeddingDim: embedding.length,
      limit,
      vectorIndexCreated: this._vectorIndexCreated,
    });

    if (this._vectorIndexCreated) {
      return this.searchSemanticIndex(embedding, filters, limit);
    }

    // Fall back to brute force search
    return this.searchSemanticBruteForce(embedding, filters, limit);
  }

  private async searchSemanticIndex(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    const vectorJson = vectorToJson(embedding);
    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    try {
      // Use vector_top_k() table-valued function for ANN search
      // Note: vector_top_k only returns 'id' (rowid), not distance
      // We must calculate distance separately using vector_distance_cos
      const kLimit = Math.floor(limit * 2);

      // Use the appropriate vector function (vector/vector16) based on column type
      const sql = `
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          vector_distance_cos(c.embedding, ${this._vectorFunc}(?)) as distance,
          'semantic' as match_type
        FROM vector_top_k('idx_chunks_embedding', ${this._vectorFunc}(?), ${kLimit}) v
        JOIN chunks c ON c.rowid = v.id
        JOIN documents d ON c.document_id = d.id
        WHERE d.status = 'indexed'
          ${filterWhere ? `AND ${filterWhere}` : ''}
        ORDER BY distance ASC
        LIMIT ?
      `;

      // Pass vectorJson twice: once for distance calc, once for vector_top_k
      const params = [vectorJson, vectorJson, ...filterParams, limit];
      const rows = this.db!.prepare(sql).all(...params) as Array<SearchResultRow & {
        distance: number;
      }>;

      // Convert distance to similarity score (1 - distance for cosine)
      const results: SearchResult[] = rows.map((row) => ({
        documentId: row.document_id,
        chunkId: row.chunk_id,
        filePath: row.file_path,
        fileName: row.file_name,
        chunkText: row.chunk_text,
        score: 1 - (row.distance ?? 0),
        matchType: 'semantic' as const,
        highlights: [],
        metadata: {
          page: row.page,
          section: row.section,
          tags: [],
        },
      }));

      log.debug('searchSemantic:index:complete', {
        resultCount: results.length,
      });
      return results;
    } catch (error) {
      log.warn('searchSemantic:index:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fall back to brute force
      return this.searchSemanticBruteForce(embedding, filters, limit);
    }
  }

  private async searchSemanticBruteForce(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    const vectorJson = vectorToJson(embedding);
    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    try {
      // Brute force: use vector_distance_cos() function
      // Use the appropriate vector function (vector/vector16) based on column type
      const sql = `
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          vector_distance_cos(c.embedding, ${this._vectorFunc}(?)) as distance,
          'semantic' as match_type
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.embedding IS NOT NULL
          AND d.status = 'indexed'
          ${filterWhere ? `AND ${filterWhere}` : ''}
        ORDER BY distance ASC
        LIMIT ?
      `;

      const params = [vectorJson, ...filterParams, limit];
      const rows = this.db!.prepare(sql).all(...params) as Array<SearchResultRow & {
        distance: number;
      }>;

      // Convert distance to similarity score (1 - distance for cosine)
      const results: SearchResult[] = rows.map((row) => ({
        documentId: row.document_id,
        chunkId: row.chunk_id,
        filePath: row.file_path,
        fileName: row.file_name,
        chunkText: row.chunk_text,
        score: 1 - (row.distance ?? 0),
        matchType: 'semantic' as const,
        highlights: [],
        metadata: {
          page: row.page,
          section: row.section,
          tags: [],
        },
      }));

      log.debug('searchSemantic:bruteForce:complete', {
        resultCount: results.length,
      });
      return results;
    } catch (error) {
      log.warn('searchSemantic:bruteForce:failed', {
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
    this.ensureReady();

    log.debug('searchHybrid:start', { strategy: this.hybridStrategy, limit });

    // Always use application-level fusion for libSQL
    // (SQL-based would require temp tables which may not work well with vector_top_k)
    return this.searchHybridApplication(
      query,
      embedding,
      filters,
      limit,
      weights,
      rrfK,
      options,
    );
  }

  private async searchHybridApplication(
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
    return this.fuseWithRRF(
      semanticResults,
      keywordResults,
      weights,
      rrfK,
      limit,
    );
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
      } else {
        // Use keyword result for highlighted text
        const existing = allChunks.get(r.chunkId)!;
        if (r.chunkText.includes('<mark>')) {
          existing.chunkText = r.chunkText;
        }
      }
    }

    // Calculate RRF scores
    const scored: Array<{
      result: SearchResult;
      score: number;
      matchType: string;
    }> = [];

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
        result: {
          ...result,
          matchType: matchType as 'hybrid' | 'semantic' | 'keyword',
        },
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
    this.ensureReady();
    this.ensureWritable();

    const id = generateId();
    const now = new Date().toISOString();

    this.db!.prepare(
      `
      INSERT INTO index_queue (id, file_path, file_size, priority, status, attempts, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?)
      ON CONFLICT (file_path) DO UPDATE SET
        file_size = excluded.file_size,
        priority = excluded.priority,
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        started_at = NULL,
        completed_at = NULL
    `,
    ).run(
      id,
      input.filePath,
      input.fileSize ?? 0,
      input.priority ?? 'markup',
      now,
    );

    this._dirty = true;
    const item = await this.getQueueItemByPath(input.filePath);
    if (!item) throw new Error('Failed to create queue item');
    return item;
  }

  async enqueueItems(inputs: CreateQueueItemInput[]): Promise<QueueItem[]> {
    this.ensureReady();
    this.ensureWritable();

    if (inputs.length === 0) {
      return [];
    }

    const now = new Date().toISOString();
    const nowDate = new Date(now);
    const insertStmt = this.db!.prepare(`
      INSERT INTO index_queue (id, file_path, file_size, priority, status, attempts, created_at)
      VALUES (?, ?, ?, ?, 'pending', 0, ?)
      ON CONFLICT (file_path) DO UPDATE SET
        file_size = excluded.file_size,
        priority = excluded.priority,
        status = 'pending',
        attempts = 0,
        last_error = NULL,
        started_at = NULL,
        completed_at = NULL
    `);

    const itemsWithIds = inputs.map((input) => ({
      id: generateId(),
      input,
    }));

    // Use transaction to batch inserts for performance
    const insertMany = this.db!.transaction(() => {
      for (const { id, input } of itemsWithIds) {
        insertStmt.run(
          id,
          input.filePath,
          input.fileSize ?? 0,
          input.priority ?? 'markup',
          now,
        );
      }
    });

    insertMany();
    this._dirty = true;

    return itemsWithIds.map(({ id, input }) => ({
      id,
      filePath: input.filePath,
      fileSize: input.fileSize ?? 0,
      priority: (input.priority ?? 'markup'),
      status: 'pending' as const,
      attempts: 0,
      lastError: null,
      createdAt: nowDate,
      startedAt: null,
      completedAt: null,
    }));
  }

  async dequeueItem(): Promise<QueueItem | null> {
    this.ensureReady();
    this.ensureWritable();

    const row = this.db!.prepare(
      `
      SELECT * FROM index_queue
      WHERE status = 'pending'
      ORDER BY
        CASE priority
          WHEN 'text' THEN 1
          WHEN 'markup' THEN 2
          WHEN 'pdf' THEN 3
          WHEN 'image' THEN 4
          WHEN 'ocr' THEN 5
        END,
        file_size ASC,
        created_at ASC
      LIMIT 1
    `,
    ).get() as QueueItemRow | undefined;

    if (!row) return null;

    this.db!.prepare(
      `
      UPDATE index_queue
      SET status = 'processing', started_at = ?, attempts = attempts + 1
      WHERE id = ?
    `,
    ).run(new Date().toISOString(), row.id);

    this._dirty = true;
    return this.rowToQueueItem({
      ...row,
      status: 'processing',
      attempts: row.attempts + 1,
    });
  }

  async updateQueueItem(
    id: string,
    updates: UpdateQueueItemInput,
  ): Promise<QueueItem> {
    this.ensureReady();
    this.ensureWritable();

    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.attempts !== undefined) {
      sets.push('attempts = ?');
      params.push(updates.attempts);
    }
    if (updates.lastError !== undefined) {
      sets.push('last_error = ?');
      params.push(updates.lastError);
    }
    if (updates.startedAt !== undefined) {
      sets.push('started_at = ?');
      params.push(updates.startedAt?.toISOString() ?? null);
    }
    if (updates.completedAt !== undefined) {
      sets.push('completed_at = ?');
      params.push(updates.completedAt?.toISOString() ?? null);
    }

    if (sets.length > 0) {
      params.push(id);
      this.db!.prepare(
        `UPDATE index_queue SET ${sets.join(', ')} WHERE id = ?`,
      ).run(...params);
    }

    const row = this.db!.prepare('SELECT * FROM index_queue WHERE id = ?').get(
      id,
    ) as QueueItemRow | undefined;
    if (!row) throw new Error('Queue item not found');

    this._dirty = true;
    return this.rowToQueueItem(row);
  }

  async deleteQueueItem(id: string): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    this.db!.prepare('DELETE FROM index_queue WHERE id = ?').run(id);
    this._dirty = true;
  }

  async getQueueItemByPath(filePath: string): Promise<QueueItem | null> {
    this.ensureReady();

    const row = this.db!.prepare(
      'SELECT * FROM index_queue WHERE file_path = ?',
    ).get(filePath) as QueueItemRow | undefined;

    if (!row) return null;
    return this.rowToQueueItem(row);
  }

  async getQueueStatus(): Promise<QueueStatus> {
    this.ensureReady();

    const statusRows = this.db!.prepare(
      `
      SELECT status, COUNT(*) as count FROM index_queue GROUP BY status
    `,
    ).all() as Array<{ status: string; count: number }>;

    const priorityRows = this.db!.prepare(
      `
      SELECT priority, COUNT(*) as count FROM index_queue
      WHERE status = 'pending' GROUP BY priority
    `,
    ).all() as Array<{ priority: string; count: number }>;

    const statusCounts: Record<string, number> = {};
    for (const row of statusRows) {
      statusCounts[row.status] = row.count;
    }

    const priorityCounts: Record<QueuePriority, number> = {
      text: 0,
      markup: 0,
      pdf: 0,
      image: 0,
      ocr: 0,
    };
    for (const row of priorityRows) {
      priorityCounts[row.priority as QueuePriority] = row.count;
    }

    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    return {
      total,
      pending: statusCounts['pending'] ?? 0,
      processing: statusCounts['processing'] ?? 0,
      completed: statusCounts['completed'] ?? 0,
      failed: statusCounts['failed'] ?? 0,
      byPriority: priorityCounts,
    };
  }

  async clearCompletedQueueItems(): Promise<number> {
    this.ensureReady();
    this.ensureWritable();

    const result = this.db!.prepare(
      "DELETE FROM index_queue WHERE status = 'completed'",
    ).run();
    if (result.changes > 0) this._dirty = true;
    return result.changes;
  }

  async clearQueue(): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    this.db!.prepare('DELETE FROM index_queue').run();
    this._dirty = true;
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async getFileHashes(): Promise<Map<string, string>> {
    this.ensureReady();

    const rows = this.db!.prepare(
      'SELECT file_path, file_hash FROM documents',
    ).all() as Array<{
      file_path: string;
      file_hash: string;
    }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.file_path, row.file_hash);
    }
    return map;
  }

  async getDocumentsModifiedSince(date: Date): Promise<Document[]> {
    this.ensureReady();

    const rows = this.db!.prepare(
      'SELECT * FROM documents WHERE file_modified_at > ? ORDER BY file_path',
    ).all(date.toISOString()) as DocumentRow[];

    return rows.map((row) => this.rowToDocument(row));
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async getStats(): Promise<SearchStats> {
    this.ensureReady();

    const docStats = this.db!.prepare(
      `
      SELECT
        COUNT(*) as total_documents,
        SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) as indexed_documents,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_documents,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_documents,
        SUM(CASE WHEN ocr_status = 'pending' THEN 1 ELSE 0 END) as ocr_pending,
        COALESCE(SUM(file_size), 0) as total_file_size
      FROM documents
    `,
    ).get() as StatsRow;

    const chunkCount = (
      this.db!.prepare('SELECT COUNT(*) as count FROM chunks').get() as {
        count: number;
      }
    ).count;
    const tagCount = (
      this.db!.prepare('SELECT COUNT(*) as count FROM tags').get() as {
        count: number;
      }
    ).count;

    return {
      totalDocuments: docStats.total_documents,
      totalChunks: chunkCount,
      indexedDocuments: docStats.indexed_documents,
      pendingDocuments: docStats.pending_documents,
      failedDocuments: docStats.failed_documents,
      ocrPending: docStats.ocr_pending,
      totalTags: tagCount,
      databaseSize: docStats.total_file_size,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  async getConfigValue<T>(key: string): Promise<T | null> {
    this.ensureReady();

    const row = this.db!.prepare(
      'SELECT value FROM search_config WHERE key = ?',
    ).get(key) as { value: string } | undefined;

    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  async setConfigValue<T>(key: string, value: T): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    this.db!.prepare(
      `
      INSERT INTO search_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    ).run(key, JSON.stringify(value), new Date().toISOString());

    this._dirty = true;
  }

  // -------------------------------------------------------------------------
  // Raw Query
  // -------------------------------------------------------------------------

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureReady();
    return this.db!.prepare(sql).all(...(params ?? [])) as T[];
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    this.ensureReady();
    this.ensureWritable();
    this.db!.prepare(sql).run(...(params ?? []));
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  async recoverStuckDocuments(): Promise<number> {
    this.ensureReady();

    const stuckDocs = this.db!.prepare(
      `
      SELECT id, file_path, status FROM documents
      WHERE status IN ('parsing', 'chunking', 'embedding')
    `,
    ).all() as Array<{ id: string; file_path: string; status: string }>;

    if (stuckDocs.length === 0) return 0;

    log.info('recoverStuckDocuments:found', {
      count: stuckDocs.length,
      statuses: stuckDocs.map((r) => r.status),
    });

    let recoveredCount = 0;

    const transaction = this.db!.transaction(() => {
      for (const doc of stuckDocs) {
        try {
          // Delete partial chunks
          this.db!.prepare('DELETE FROM chunks WHERE document_id = ?').run(
            doc.id,
          );

          // Reset document status
          this.db!.prepare(
            `
            UPDATE documents SET status = 'pending', updated_at = ?
            WHERE id = ?
          `,
          ).run(new Date().toISOString(), doc.id);

          // Re-queue for indexing
          const queueId = generateId();
          this.db!.prepare(
            `
            INSERT INTO index_queue (id, file_path, priority, status, attempts, created_at)
            VALUES (?, ?, 'text', 'pending', 0, ?)
            ON CONFLICT (file_path) DO UPDATE SET
              status = 'pending',
              attempts = 0,
              last_error = NULL,
              started_at = NULL,
              completed_at = NULL
          `,
          ).run(queueId, doc.file_path, new Date().toISOString());

          recoveredCount++;
          log.info('recoverStuckDocuments:recovered', {
            documentId: doc.id,
            filePath: doc.file_path,
            previousStatus: doc.status,
          });
        } catch (error) {
          log.error('recoverStuckDocuments:error', {
            documentId: doc.id,
            filePath: doc.file_path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    transaction();

    if (recoveredCount > 0) this._dirty = true;

    log.info('recoverStuckDocuments:complete', {
      total: stuckDocs.length,
      recovered: recoveredCount,
    });

    return recoveredCount;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private rowToDocument(row: DocumentRow): Document {
    return {
      id: row.id,
      filePath: row.file_path,
      fileName: row.file_name,
      fileExtension: row.file_extension,
      fileSize: row.file_size,
      fileHash: row.file_hash,
      mimeType: row.mime_type,
      title: row.title,
      author: row.author,
      language: row.language,
      pageCount: row.page_count,
      status: row.status as Document['status'],
      ocrStatus: row.ocr_status as Document['ocrStatus'],
      indexedAt: toDate(row.indexed_at),
      fileModifiedAt: toDate(row.file_modified_at)!,
      createdAt: toDate(row.created_at)!,
      updatedAt: toDate(row.updated_at)!,
      metadata: JSON.parse(row.metadata || '{}'),
      tags: [],
    };
  }

  private rowToChunk(row: ChunkRow): DocumentChunk {
    return {
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      embedding: null, // Embeddings are in the embedding column but not loaded by default
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      page: row.page,
      section: row.section,
      tokenCount: row.token_count,
      createdAt: toDate(row.created_at)!,
    };
  }

  private rowToQueueItem(row: QueueItemRow): QueueItem {
    return {
      id: row.id,
      filePath: row.file_path,
      fileSize: row.file_size,
      priority: row.priority as QueuePriority,
      status: row.status as QueueItem['status'],
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: toDate(row.created_at)!,
      startedAt: toDate(row.started_at),
      completedAt: toDate(row.completed_at),
    };
  }

  private rowsToSearchResults(rows: SearchResultRow[]): SearchResult[] {
    return rows.map((row) => ({
      documentId: row.document_id,
      chunkId: row.chunk_id,
      filePath: row.file_path,
      fileName: row.file_name,
      chunkText: row.highlighted_text ?? row.chunk_text,
      score: Number(row.score) || 0,
      matchType: row.match_type as SearchResult['matchType'],
      highlights: [],
      metadata: {
        page: row.page,
        section: row.section,
        tags: [],
      },
    }));
  }

  private buildDocumentFilters(filters?: Partial<SearchFilters>): {
    where: string;
    params: unknown[];
  } {
    if (!filters) return { where: '', params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.folders && filters.folders.length > 0) {
      const folderConditions = filters.folders.map(() => `REPLACE(file_path, '\\', '/') LIKE ?`);
      conditions.push(`(${folderConditions.join(' OR ')})`);
      params.push(...filters.folders.map((f) => `%${f.replace(/\\/g, '/')}%`));
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const placeholders = filters.fileTypes.map(() => '?').join(', ');
      conditions.push(`file_extension IN (${placeholders})`);
      params.push(
        ...filters.fileTypes.map((t) =>
          t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`,
        ),
      );
    }

    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => '?').join(', ');
      conditions.push(`status IN (${placeholders})`);
      params.push(...filters.status);
    }

    if (filters.dateFrom) {
      conditions.push('file_modified_at >= ?');
      params.push(filters.dateFrom.toISOString());
    }

    if (filters.dateTo) {
      conditions.push('file_modified_at <= ?');
      params.push(filters.dateTo.toISOString());
    }

    if (filters.languages && filters.languages.length > 0) {
      const placeholders = filters.languages.map(() => '?').join(', ');
      conditions.push(`language IN (${placeholders})`);
      params.push(...filters.languages);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return { where, params };
  }

  private buildSearchFilters(filters?: SearchFilters): {
    where: string;
    params: unknown[];
  } {
    if (!filters) return { where: '', params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters.folders && filters.folders.length > 0) {
      const folderConditions = filters.folders.map(() => `REPLACE(d.file_path, '\\', '/') LIKE ?`);
      conditions.push(`(${folderConditions.join(' OR ')})`);
      params.push(...filters.folders.map((f) => `%${f.replace(/\\/g, '/')}%`));
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const placeholders = filters.fileTypes.map(() => '?').join(', ');
      conditions.push(`d.file_extension IN (${placeholders})`);
      params.push(
        ...filters.fileTypes.map((t) =>
          t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`,
        ),
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      const placeholders = filters.tags.map(() => '?').join(', ');
      conditions.push(`
        EXISTS (
          SELECT 1 FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id
          WHERE dt.document_id = d.id AND t.name IN (${placeholders})
        )
      `);
      params.push(...filters.tags);
    }

    if (filters.dateFrom) {
      conditions.push('d.file_modified_at >= ?');
      params.push(filters.dateFrom.toISOString());
    }

    if (filters.dateTo) {
      conditions.push('d.file_modified_at <= ?');
      params.push(filters.dateTo.toISOString());
    }

    if (filters.languages && filters.languages.length > 0) {
      const placeholders = filters.languages.map(() => '?').join(', ');
      conditions.push(`d.language IN (${placeholders})`);
      params.push(...filters.languages);
    }

    const where = conditions.join(' AND ');

    return { where, params };
  }

  // -------------------------------------------------------------------------
  // Utility Methods
  // -------------------------------------------------------------------------

  /**
   * Rebuild the FTS5 index from the chunks table.
   */
  async rebuildFTS5Index(): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    log.info('rebuildFTS5Index:start');
    this.db!.exec(LIBSQL_FTS5_REBUILD_SQL);
    this._dirty = true;
    log.info('rebuildFTS5Index:complete');
  }

  /**
   * Optimize the FTS5 index.
   */
  async optimizeFTS5Index(): Promise<void> {
    this.ensureReady();

    log.info('optimizeFTS5Index:start');
    this.db!.exec(LIBSQL_FTS5_OPTIMIZE_SQL);
    log.info('optimizeFTS5Index:complete');
  }

  /**
   * Recreate the vector index.
   */
  async recreateVectorIndex(): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    log.info('recreateVectorIndex:start');
    this.db!.exec(LIBSQL_DROP_VECTOR_INDEX_SQL);
    this._vectorIndexCreated = false;
    await this.createVectorIndex();
    log.info('recreateVectorIndex:complete');
  }

  /**
   * Set the hybrid search strategy.
   */
  setHybridStrategy(strategy: HybridSearchStrategy): void {
    this.hybridStrategy = strategy;
    log.info('setHybridStrategy', { strategy });
  }

  /**
   * Get the current hybrid search strategy.
   */
  getHybridStrategy(): HybridSearchStrategy {
    return this.hybridStrategy;
  }

  /**
   * Check if vector index is created.
   */
  isVectorIndexCreated(): boolean {
    return this._vectorIndexCreated;
  }

  /**
   * Get the storage status.
   */
  getStatus(): {
    initialized: boolean;
    vectorIndexCreated: boolean;
    readOnly: boolean;
    suspended: boolean;
    hybridStrategy: HybridSearchStrategy;
  } {
    return {
      initialized: this._initialized,
      vectorIndexCreated: this._vectorIndexCreated,
      readOnly: this._readOnly,
      suspended: this._suspended,
      hybridStrategy: this.hybridStrategy,
    };
  }
}
