/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/* eslint-disable no-console */

import Database from 'better-sqlite3';
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
  SQLITE_BASE_SCHEMA_SQL,
  SQLITE_CHUNKS_TABLE_SQL,
  SQLITE_FTS5_TABLE_SQL,
  SQLITE_FTS5_TRIGGERS_SQL,
  getSQLiteVectorTableSQL,
  SQLITE_FTS5_REBUILD_SQL,
  SQLITE_FTS5_OPTIMIZE_SQL,
  SQLITE_DROP_VECTOR_TABLE_SQL as _SQLITE_DROP_VECTOR_TABLE_SQL,
} from './sqlite-schema.js';
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
import type { SQLiteBackendOptions } from '../config/backend-options.js';
import { DEFAULT_SQLITE_OPTIONS } from '../config/backend-options.js';
import { convertToFTS5Query } from './web-search-parser.js';
import * as _fs from 'node:fs';
import * as path from 'node:path';

const log = createModuleLogger('SQLiteVectorliteStorage');

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
 * Convert a number array to a Float32 buffer for vectorlite.
 */
function vectorToBlob(embedding: number[]): Buffer {
  const buffer = Buffer.alloc(embedding.length * 4);
  for (let i = 0; i < embedding.length; i++) {
    buffer.writeFloatLE(embedding[i], i * 4);
  }
  return buffer;
}

/**
 * Convert a Float32 buffer from vectorlite to a number array.
 */
function _blobToVector(blob: Buffer): number[] {
  const result: number[] = [];
  for (let i = 0; i < blob.length; i += 4) {
    result.push(blob.readFloatLE(i));
  }
  return result;
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

interface _TagRow {
  id: string;
  name: string;
  created_at: string;
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

interface VectorResultRow {
  rowid: number;
  distance: number;
}

// ============================================================================
// SQLite + vectorlite Storage Adapter
// ============================================================================

export class SQLiteVectorliteStorage implements StorageAdapter {
  private db: Database.Database | null = null;
  private config: DatabaseConfig;
  private vectorIndexConfig: VectorIndexConfig;
  private embeddingDimensions: number;
  private hybridStrategy: HybridSearchStrategy;
  private backendOptions: SQLiteBackendOptions;
  private _initialized = false;
  private _dirty = false;
  private _readOnly = false;
  private _suspended = false;
  private _vectorliteAvailable = false;
  private _bruteForceMode = false;

  constructor(
    config: DatabaseConfig,
    vectorIndexConfig?: VectorIndexConfig,
    embeddingDimensions?: number,
    hybridStrategy?: HybridSearchStrategy,
    backendOptions?: Partial<SQLiteBackendOptions>,
  ) {
    this.config = config;
    this.vectorIndexConfig = vectorIndexConfig ?? DEFAULT_VECTOR_INDEX_CONFIG;
    this.embeddingDimensions = embeddingDimensions ?? 384;
    this.hybridStrategy =
      hybridStrategy ?? DEFAULT_SEARCH_CONFIG.hybridStrategy;
    this.backendOptions = { ...DEFAULT_SQLITE_OPTIONS, ...backendOptions };
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

    // Get actual database file path (inside the directory)
    const dbFilePath = this.config.inMemory
      ? ':memory:'
      : getDatabaseFilePath(this.config.path, 'sqlite');
    this.db = new Database(dbFilePath);
    log.info('initialize:database:opened', { dbFilePath });

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');

    // Register custom cosine_similarity function for brute force search
    this.registerCosineSimilarityFunction();

    // Determine if we should use brute force mode
    this._bruteForceMode =
      this.vectorIndexConfig.createIndex === false ||
      this.vectorIndexConfig.type === 'none';

    // Load vectorlite extension (only if not in brute force mode)
    try {
      // Dynamic import to handle optional dependency
      const vectorlite = await import('vectorlite');
      const extensionPath = vectorlite.vectorlitePath();
      log.info('initialize:vectorlite:loading', { extensionPath });
      this.db.loadExtension(extensionPath);
      this._vectorliteAvailable = true;
      log.info('initialize:vectorlite:loaded');
    } catch (error) {
      this._vectorliteAvailable = false;
      log.error('initialize:vectorlite:failed', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // This is a critical error - semantic search will NOT work
      console.error(
        '[SQLiteVectorliteStorage] CRITICAL: Failed to load vectorlite extension. Semantic search will be disabled.',
        error instanceof Error ? error.message : error,
      );
    }

    // Create schema
    await this.createSchema();

    // Create metadata file if it doesn't exist (for new databases)
    if (!this.config.inMemory && this.config.path) {
      const existingMetadata = readMetadata(this.config.path);
      if (!existingMetadata) {
        const metadata = createMetadata(
          'sqlite',
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
          { backend: 'sqlite', ...this.backendOptions },
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
    this.db.exec(SQLITE_BASE_SCHEMA_SQL);

    // Create chunks table
    this.db.exec(SQLITE_CHUNKS_TABLE_SQL);

    // Create FTS5 virtual table
    try {
      this.db.exec(SQLITE_FTS5_TABLE_SQL);
      log.info('createSchema:fts5:created');
    } catch (error) {
      log.warn('createSchema:fts5:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Create FTS5 triggers
    try {
      this.db.exec(SQLITE_FTS5_TRIGGERS_SQL);
      log.info('createSchema:fts5Triggers:created');
    } catch (error) {
      log.warn('createSchema:fts5Triggers:failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Create vectorlite virtual table
    // Note: vectorlite REQUIRES HNSW - it doesn't support brute force mode
    // If createIndex is false or type is 'none', skip vectorlite entirely (keyword-only search)
    const shouldCreateVectorIndex =
      this._vectorliteAvailable &&
      this.vectorIndexConfig.createIndex !== false &&
      this.vectorIndexConfig.type !== 'none';

    if (shouldCreateVectorIndex) {
      try {
        // Generate index file path for persistence (inside the database directory)
        const indexFilePath = this.config.inMemory
          ? undefined
          : path.join(this.config.path, 'vectors.index');

        const vectorSQL = getSQLiteVectorTableSQL({
          dimensions: this.embeddingDimensions,
          maxElements: 1000000,
          efConstruction: this.vectorIndexConfig.hnswEfConstruction ?? 200,
          hnswM: this.vectorIndexConfig.hnswM ?? 32,
          distanceType: 'ip', // Inner product: better for pre-normalized vectors (avoids Float32 precision loss in magnitude calc)
          indexFilePath,
        });
        log.info('createSchema:vectorlite:sql', {
          sql: vectorSQL,
          indexFilePath,
        });
        this.db.exec(vectorSQL);
        log.info('createSchema:vectorlite:created', {
          dimensions: this.embeddingDimensions,
        });
      } catch (error) {
        this._vectorliteAvailable = false;
        log.error('createSchema:vectorlite:failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(
          '[SQLiteVectorliteStorage] Failed to create vector table:',
          error instanceof Error ? error.message : error,
        );
      }
    } else {
      // Vector index not created - determine reason
      const extensionLoaded = this._vectorliteAvailable;
      const configDisabled =
        this.vectorIndexConfig.createIndex === false ||
        this.vectorIndexConfig.type === 'none';

      const reason = !extensionLoaded
        ? 'vectorlite extension not loaded'
        : 'vector index disabled in config (createIndex: false or type: none)';

      // Mark as unavailable so semantic search is skipped
      this._vectorliteAvailable = false;

      log.warn('createSchema:vectorlite:skipped', {
        reason,
        extensionLoaded,
        configDisabled,
      });
      console.log(
        '[SQLiteVectorliteStorage] Semantic search disabled:',
        reason,
      );
    }
  }

  async close(): Promise<void> {
    if (!this.db) return;

    log.info('close:start');

    // Optimize FTS5 before closing
    try {
      this.db.exec(SQLITE_FTS5_OPTIMIZE_SQL);
    } catch {
      // Ignore errors
    }

    this.db.close();
    this.db = null;
    this._initialized = false;

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
      // Not initialized, nothing to reconnect
      return;
    }

    log.info('reconnect:start');
    log.logMemory('reconnect:memoryBefore');

    try {
      // Checkpoint WAL to ensure all data is flushed
      this.db.pragma('wal_checkpoint(TRUNCATE)');

      // Close the database - THIS TRIGGERS VECTORLITE TO SAVE THE HNSW INDEX!
      this.db.close();
      this.db = null;
      this._initialized = false;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      log.logMemory('reconnect:afterClose');

      // Reopen the database
      const dbFilePath = this.config.inMemory
        ? ':memory:'
        : getDatabaseFilePath(this.config.path, 'sqlite');
      this.db = new Database(dbFilePath);

      // Re-enable foreign keys
      this.db.pragma('foreign_keys = ON');

      // Re-register custom functions
      this.registerCosineSimilarityFunction();

      // Reload vectorlite extension if it was available
      if (this._vectorliteAvailable) {
        try {
          const vectorlite = await import('vectorlite');
          const extensionPath = vectorlite.vectorlitePath();
          this.db.loadExtension(extensionPath);
          log.info('reconnect:vectorlite:reloaded');
        } catch (error) {
          this._vectorliteAvailable = false;
          log.error('reconnect:vectorlite:failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
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

  /**
   * Register the cosine_similarity and dot_product SQL functions for brute force vector search.
   * dot_product is preferred for pre-normalized vectors (avoids Float32 precision loss in magnitude calc).
   */
  private registerCosineSimilarityFunction(): void {
    if (!this.db) return;

    // Register dot_product function - preferred for normalized vectors
    // Avoids magnitude calculation which compounds Float32 precision errors
    this.db.function('dot_product', (a: Buffer | null, b: Buffer | null) => {
      if (!a || !b || a.length !== b.length || a.length === 0) {
        return null;
      }

      let dot = 0;

      // Both vectors are stored as float32 arrays (4 bytes per element)
      for (let i = 0; i < a.length; i += 4) {
        const va = a.readFloatLE(i);
        const vb = b.readFloatLE(i);
        dot += va * vb;
      }

      return dot;
    });

    // Register cosine_similarity function (kept for backwards compatibility)
    this.db.function(
      'cosine_similarity',
      (a: Buffer | null, b: Buffer | null) => {
        if (!a || !b || a.length !== b.length || a.length === 0) {
          return null;
        }

        let dot = 0;
        let normA = 0;
        let normB = 0;

        // Both vectors are stored as float32 arrays (4 bytes per element)
        for (let i = 0; i < a.length; i += 4) {
          const va = a.readFloatLE(i);
          const vb = b.readFloatLE(i);
          dot += va * vb;
          normA += va * va;
          normB += vb * vb;
        }

        const denominator = Math.sqrt(normA) * Math.sqrt(normB);
        if (denominator === 0) return 0;

        return dot / denominator;
      },
    );

    log.info('registerSimilarityFunctions:registered');
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

    // Delete associated vectors first (vectorlite doesn't cascade)
    const chunks = this.db!.prepare(
      'SELECT rowid FROM chunks WHERE document_id = ?',
    ).all(id) as Array<{ rowid: number }>;
    for (const chunk of chunks) {
      try {
        this.db!.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(
          chunk.rowid,
        );
      } catch {
        // Ignore vectorlite errors
      }
    }

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

        // Get the rowid for the inserted chunk (reserved for future vector operations)
        const _rowInfo = this.db!.prepare(
          'SELECT rowid FROM chunks WHERE id = ?',
        ).get(id) as { rowid: number };

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

    // Delete associated vectors first
    const chunks = this.db!.prepare(
      'SELECT rowid FROM chunks WHERE document_id = ?',
    ).all(documentId) as Array<{ rowid: number }>;
    for (const chunk of chunks) {
      try {
        this.db!.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(
          chunk.rowid,
        );
      } catch {
        // Ignore vectorlite errors
      }
    }

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
      bruteForceMode: this._bruteForceMode,
      vectorliteAvailable: this._vectorliteAvailable,
    });

    if (this._bruteForceMode) {
      // Brute force mode: store embeddings directly in chunks table
      await this.updateChunkEmbeddingsBruteForce(updates);
    } else if (this._vectorliteAvailable) {
      // HNSW mode: store embeddings in vectorlite virtual table
      await this.updateChunkEmbeddingsHnsw(updates);
    } else {
      log.error('updateChunkEmbeddings:failed', {
        reason:
          'No embedding storage available (vectorlite not loaded and not in brute force mode)',
        updateCount: updates.length,
      });
      console.error(
        `[SQLiteVectorliteStorage] Cannot store ${updates.length} embeddings - no storage available!`,
      );
    }
  }

  private async updateChunkEmbeddingsBruteForce(
    updates: UpdateChunkEmbeddingInput[],
  ): Promise<void> {
    const updateStmt = this.db!.prepare(
      'UPDATE chunks SET embedding = ? WHERE id = ?',
    );

    const transaction = this.db!.transaction(() => {
      for (const update of updates) {
        const vectorBlob = vectorToBlob(update.embedding);
        try {
          updateStmt.run(vectorBlob, update.id);
        } catch (error) {
          log.warn('updateChunkEmbeddings:bruteForce:updateFailed', {
            chunkId: update.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    transaction();
    this._dirty = true;

    log.debug('updateChunkEmbeddings:bruteForce:complete', {
      updateCount: updates.length,
    });
  }

  private async updateChunkEmbeddingsHnsw(
    updates: UpdateChunkEmbeddingInput[],
  ): Promise<void> {
    const getRowidStmt = this.db!.prepare(
      'SELECT rowid FROM chunks WHERE id = ?',
    );
    const insertVecStmt = this.db!.prepare(
      'INSERT OR REPLACE INTO chunks_vec(rowid, embedding) VALUES (?, ?)',
    );

    const transaction = this.db!.transaction(() => {
      for (const update of updates) {
        const rowInfo = getRowidStmt.get(update.id) as
          | { rowid: number }
          | undefined;
        if (!rowInfo) {
          log.warn('updateChunkEmbeddings:hnsw:chunkNotFound', {
            chunkId: update.id,
          });
          continue;
        }

        const vectorBlob = vectorToBlob(update.embedding);
        try {
          insertVecStmt.run(rowInfo.rowid, vectorBlob);
        } catch (error) {
          log.warn('updateChunkEmbeddings:hnsw:insertFailed', {
            chunkId: update.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    transaction();
    this._dirty = true;

    log.debug('updateChunkEmbeddings:hnsw:complete', {
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

    // Convert query to FTS5 format using Google-style web search parser
    const ftsQuery = convertToFTS5Query(
      query,
      options?.useWebSearchSyntax ?? false,
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

  // Query conversion is now handled by the imported convertToFTS5Query from web-search-parser.ts
  // which provides proper Google-style web search syntax support matching PostgreSQL's websearch_to_tsquery

  async searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    this.ensureReady();

    log.debug('searchSemantic:start', {
      embeddingDim: embedding.length,
      limit,
      bruteForceMode: this._bruteForceMode,
      vectorliteAvailable: this._vectorliteAvailable,
    });

    if (this._bruteForceMode) {
      return this.searchSemanticBruteForce(embedding, filters, limit);
    }

    if (!this._vectorliteAvailable) {
      log.warn('searchSemantic:disabled', {
        reason:
          'vectorlite extension not available and not in brute force mode',
      });
      return [];
    }

    return this.searchSemanticHnsw(embedding, filters, limit);
  }

  private async searchSemanticBruteForce(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    const vectorBlob = vectorToBlob(embedding);
    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    try {
      // Brute force: use dot_product for normalized vectors (avoids Float32 precision loss in magnitude calc)
      // For normalized vectors: dot_product = cosine_similarity
      const sql = `
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          dot_product(c.embedding, ?) as score,
          'semantic' as match_type
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.embedding IS NOT NULL
          AND d.status = 'indexed'
          ${filterWhere ? `AND ${filterWhere}` : ''}
        ORDER BY score DESC
        LIMIT ?
      `;

      const params = [vectorBlob, ...filterParams, limit];
      const rows = this.db!.prepare(sql).all(...params) as SearchResultRow[];

      const results = this.rowsToSearchResults(rows);
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

  private async searchSemanticHnsw(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    const vectorBlob = vectorToBlob(embedding);
    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    try {
      // Use vectorlite knn_search
      // Note: knn_param's k (limit) must be a literal integer, not a bound parameter
      const kLimit = Math.floor(limit * 2);
      const vecSql = `
        SELECT rowid, distance
        FROM chunks_vec
        WHERE knn_search(embedding, knn_param(?, ${kLimit}))
      `;

      const vecRows = this.db!.prepare(vecSql).all(
        vectorBlob,
      ) as VectorResultRow[];

      if (vecRows.length === 0) {
        log.debug('searchSemantic:hnsw:complete:empty', { resultCount: 0 });
        return [];
      }

      // Get the rowids
      const rowids = vecRows.map((r) => r.rowid);
      const distanceMap = new Map(vecRows.map((r) => [r.rowid, r.distance]));

      // Now join with chunks and documents
      const placeholders = rowids.map(() => '?').join(',');
      const sql = `
        SELECT
          c.id as chunk_id,
          c.document_id,
          c.rowid as chunk_rowid,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          'semantic' as match_type
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.rowid IN (${placeholders})
          AND d.status = 'indexed'
          ${filterWhere ? `AND ${filterWhere}` : ''}
      `;

      const params = [...rowids, ...filterParams];
      const rows = this.db!.prepare(sql).all(...params) as Array<SearchResultRow & {
        chunk_rowid: number;
      }>;

      // Add scores and sort by distance
      const results: SearchResult[] = rows
        .map((row) => {
          const distance = distanceMap.get(row.chunk_rowid) ?? 1;
          return {
            documentId: row.document_id,
            chunkId: row.chunk_id,
            filePath: row.file_path,
            fileName: row.file_name,
            chunkText: row.chunk_text,
            score: 1 - distance, // Convert distance to similarity
            matchType: 'semantic' as const,
            highlights: [],
            metadata: {
              page: row.page,
              section: row.section,
              tags: [],
            },
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      log.debug('searchSemantic:hnsw:complete', {
        resultCount: results.length,
      });
      return results;
    } catch (error) {
      log.warn('searchSemantic:hnsw:failed', {
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

    if (this.hybridStrategy === 'sql') {
      return this.searchHybridSQL(
        query,
        embedding,
        filters,
        limit,
        weights,
        rrfK,
        options,
      );
    }

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

  private async searchHybridSQL(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
    weights: HybridSearchWeights = { semantic: 0.5, keyword: 0.5 },
    rrfK = 60,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    // SQL-based hybrid search using temp tables
    // This is more complex but may have better performance for large result sets

    try {
      const vectorBlob = vectorToBlob(embedding);
      const ftsQuery = convertToFTS5Query(
        query,
        options?.useWebSearchSyntax ?? false,
      );
      const { where: filterWhere, params: filterParams } =
        this.buildSearchFilters(filters);

      // Create temp tables for semantic and keyword results
      this.db!.exec('DROP TABLE IF EXISTS temp_semantic');
      this.db!.exec('DROP TABLE IF EXISTS temp_keyword');

      this.db!.exec(`
        CREATE TEMP TABLE temp_semantic (
          rowid INTEGER PRIMARY KEY,
          distance REAL,
          rank INTEGER
        )
      `);

      this.db!.exec(`
        CREATE TEMP TABLE temp_keyword (
          rowid INTEGER PRIMARY KEY,
          score REAL,
          rank INTEGER
        )
      `);

      // Populate semantic results
      try {
        const vecRows = this.db!.prepare(
          `
          SELECT rowid, distance
          FROM chunks_vec
          WHERE knn_search(embedding, knn_param(?, 50))
        `,
        ).all(vectorBlob) as VectorResultRow[];

        const insertSemantic = this.db!.prepare(
          'INSERT INTO temp_semantic (rowid, distance, rank) VALUES (?, ?, ?)',
        );
        vecRows.forEach((row, i) => {
          insertSemantic.run(row.rowid, row.distance, i + 1);
        });
      } catch {
        // No semantic results
      }

      // Populate keyword results
      try {
        const ftsRows = this.db!.prepare(
          `
          SELECT chunks_fts.rowid, bm25(chunks_fts) as score
          FROM chunks_fts
          WHERE chunks_fts MATCH ?
          ORDER BY bm25(chunks_fts)
          LIMIT 50
        `,
        ).all(ftsQuery) as Array<{ rowid: number; score: number }>;

        const insertKeyword = this.db!.prepare(
          'INSERT INTO temp_keyword (rowid, score, rank) VALUES (?, ?, ?)',
        );
        ftsRows.forEach((row, i) => {
          insertKeyword.run(row.rowid, row.score, i + 1);
        });
      } catch {
        // No keyword results
      }

      // Join and compute RRF scores
      const sql = `
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          COALESCE(? / (? + s.rank), 0) + COALESCE(? / (? + k.rank), 0) as score,
          CASE
            WHEN s.rowid IS NOT NULL AND k.rowid IS NOT NULL THEN 'hybrid'
            WHEN s.rowid IS NOT NULL THEN 'semantic'
            ELSE 'keyword'
          END as match_type
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        LEFT JOIN temp_semantic s ON c.rowid = s.rowid
        LEFT JOIN temp_keyword k ON c.rowid = k.rowid
        WHERE (s.rowid IS NOT NULL OR k.rowid IS NOT NULL)
          AND d.status = 'indexed'
          ${filterWhere ? `AND ${filterWhere}` : ''}
        ORDER BY score DESC
        LIMIT ?
      `;

      const params = [
        weights.semantic,
        rrfK,
        weights.keyword,
        rrfK,
        ...filterParams,
        limit,
      ];

      const rows = this.db!.prepare(sql).all(...params) as SearchResultRow[];

      // Cleanup temp tables
      this.db!.exec('DROP TABLE IF EXISTS temp_semantic');
      this.db!.exec('DROP TABLE IF EXISTS temp_keyword');

      const results = this.rowsToSearchResults(rows);
      log.debug('searchHybridSQL:complete', { resultCount: results.length });
      return results;
    } catch (error) {
      log.warn('searchHybridSQL:failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to application-level hybrid
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

    // Use transaction for batch insert - much faster than individual inserts
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

    // Pre-generate IDs so we can return them
    const itemsWithIds = inputs.map((input) => ({
      id: generateId(),
      input,
    }));

    const insertMany = this.db!.transaction((items: typeof itemsWithIds) => {
      for (const { id, input } of items) {
        insertStmt.run(
          id,
          input.filePath,
          input.fileSize ?? 0,
          input.priority ?? 'markup',
          now,
        );
      }
    });

    insertMany(itemsWithIds);
    this._dirty = true;

    // Return items with correct IDs
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

    // Order: text files first (fastest), then by file size (smallest first)
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
          WHEN 'deferred' THEN 6
        END,
        file_size ASC,
        created_at ASC
      LIMIT 1
    `,
    ).get() as QueueItemRow | undefined;

    if (!row) return null;

    // Update status to processing
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
    if (updates.priority !== undefined) {
      sets.push('priority = ?');
      params.push(updates.priority);
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
      deferred: 0,
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
          // Delete partial chunks and vectors
          const chunks = this.db!.prepare(
            'SELECT rowid FROM chunks WHERE document_id = ?',
          ).all(doc.id) as Array<{ rowid: number }>;
          for (const chunk of chunks) {
            try {
              this.db!.prepare('DELETE FROM chunks_vec WHERE rowid = ?').run(
                chunk.rowid,
              );
            } catch {
              // Ignore
            }
          }
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
      embedding: null, // Embeddings are in separate vectorlite table
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
   * Use this if the FTS5 index gets out of sync.
   */
  async rebuildFTS5Index(): Promise<void> {
    this.ensureReady();
    this.ensureWritable();

    log.info('rebuildFTS5Index:start');
    this.db!.exec(SQLITE_FTS5_REBUILD_SQL);
    this._dirty = true;
    log.info('rebuildFTS5Index:complete');
  }

  /**
   * Optimize the FTS5 index for better search performance.
   */
  async optimizeFTS5Index(): Promise<void> {
    this.ensureReady();

    log.info('optimizeFTS5Index:start');
    this.db!.exec(SQLITE_FTS5_OPTIMIZE_SQL);
    log.info('optimizeFTS5Index:complete');
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
   * Check if vectorlite extension is available.
   * If false, semantic search will not work.
   */
  isVectorliteAvailable(): boolean {
    return this._vectorliteAvailable;
  }

  /**
   * Check if brute force mode is enabled.
   */
  isBruteForceMode(): boolean {
    return this._bruteForceMode;
  }

  /**
   * Get the storage status including vectorlite availability.
   */
  getStatus(): {
    initialized: boolean;
    vectorliteAvailable: boolean;
    bruteForceMode: boolean;
    readOnly: boolean;
    suspended: boolean;
    hybridStrategy: HybridSearchStrategy;
  } {
    return {
      initialized: this._initialized,
      vectorliteAvailable: this._vectorliteAvailable,
      bruteForceMode: this._bruteForceMode,
      readOnly: this._readOnly,
      suspended: this._suspended,
      hybridStrategy: this.hybridStrategy,
    };
  }
}
