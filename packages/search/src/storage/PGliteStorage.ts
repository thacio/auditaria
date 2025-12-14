/**
 * PGlite storage adapter implementation.
 * Provides embedded PostgreSQL with pgvector for the search system.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import type {
  StorageAdapter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateChunkInput,
  UpdateChunkEmbeddingInput,
  CreateQueueItemInput,
  UpdateQueueItemInput,
  HybridSearchWeights,
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
  SCHEMA_SQL,
  FTS_INDEX_SQL,
  HNSW_INDEX_SQL,
  UPDATE_FTS_VECTOR_SQL,
} from './schema.js';
import type { DatabaseConfig } from '../config.js';

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

function formatVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// ============================================================================
// Row Types (database representation)
// ============================================================================

interface DocumentRow {
  id: string;
  file_path: string;
  file_name: string;
  file_extension: string;
  file_size: string | number;
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
  metadata: Record<string, unknown> | string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  embedding: string | null;
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
  priority: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface TagRow {
  id: string;
  name: string;
  created_at: string;
}

interface TagCountRow {
  tag: string;
  count: string | number;
}

interface StatsRow {
  total_documents: string | number;
  indexed_documents: string | number;
  pending_documents: string | number;
  failed_documents: string | number;
  ocr_pending: string | number;
  total_file_size: string | number;
}

interface SearchResultRow {
  chunk_id: string;
  document_id: string;
  file_path: string;
  file_name: string;
  chunk_text: string;
  page: number | null;
  section: string | null;
  score: number;
  match_type: string;
}

// ============================================================================
// PGlite Storage Adapter
// ============================================================================

export class PGliteStorage implements StorageAdapter {
  private db: PGlite | null = null;
  private config: DatabaseConfig;
  private _initialized = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this._initialized) return;

    // Initialize PGlite with pgvector extension
    this.db = await PGlite.create({
      dataDir: this.config.inMemory ? undefined : this.config.path,
      extensions: { vector },
    });

    // Run schema SQL
    await this.db.exec(SCHEMA_SQL);

    // Create FTS index
    try {
      await this.db.exec(FTS_INDEX_SQL);
    } catch {
      // FTS index might fail on first run, that's ok
    }

    // Create HNSW index
    try {
      await this.db.exec(HNSW_INDEX_SQL);
    } catch {
      // HNSW index creation might fail if no data, that's ok
    }

    // Mark as initialized (must be set before using methods that call ensureInitialized)
    this._initialized = true;

    // Store initialization timestamp
    await this.setConfigValue('initialized_at', new Date().toISOString());
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this._initialized = false;
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  private ensureInitialized(): void {
    if (!this._initialized || !this.db) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async createDocument(input: CreateDocumentInput): Promise<Document> {
    this.ensureInitialized();

    const id = generateId();
    const now = new Date().toISOString();

    await this.db!.query(
      `INSERT INTO documents (
        id, file_path, file_name, file_extension, file_size, file_hash,
        mime_type, title, author, language, page_count, status, ocr_status,
        file_modified_at, created_at, updated_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
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
      ],
    );

    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Failed to create document');
    return doc;
  }

  async getDocument(id: string): Promise<Document | null> {
    this.ensureInitialized();

    const result = await this.db!.query<DocumentRow>(
      'SELECT * FROM documents WHERE id = $1',
      [id],
    );

    if (result.rows.length === 0) return null;
    return this.rowToDocument(result.rows[0]);
  }

  async getDocumentByPath(filePath: string): Promise<Document | null> {
    this.ensureInitialized();

    const result = await this.db!.query<DocumentRow>(
      'SELECT * FROM documents WHERE file_path = $1',
      [filePath],
    );

    if (result.rows.length === 0) return null;
    return this.rowToDocument(result.rows[0]);
  }

  async updateDocument(
    id: string,
    updates: UpdateDocumentInput,
  ): Promise<Document> {
    this.ensureInitialized();

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [];
    let paramIndex = 1;

    const fields: Array<keyof UpdateDocumentInput> = [
      'filePath',
      'fileName',
      'fileExtension',
      'fileSize',
      'fileHash',
      'mimeType',
      'title',
      'author',
      'language',
      'pageCount',
      'status',
      'ocrStatus',
      'indexedAt',
      'metadata',
    ];

    const columnMap: Record<keyof UpdateDocumentInput, string> = {
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

    for (const field of fields) {
      if (updates[field] !== undefined) {
        const column = columnMap[field];
        let value = updates[field];

        if (field === 'indexedAt' && value instanceof Date) {
          value = value.toISOString();
        } else if (field === 'metadata') {
          value = JSON.stringify(value);
        }

        sets.push(`${column} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    params.push(id);

    await this.db!.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
      params,
    );

    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Document not found after update');
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    this.ensureInitialized();
    await this.db!.query('DELETE FROM documents WHERE id = $1', [id]);
  }

  async listDocuments(filters?: Partial<SearchFilters>): Promise<Document[]> {
    this.ensureInitialized();

    const { where, params } = this.buildDocumentFilters(filters);
    const result = await this.db!.query<DocumentRow>(
      `SELECT * FROM documents ${where} ORDER BY file_path`,
      params,
    );

    return result.rows.map((row) => this.rowToDocument(row));
  }

  async countDocuments(filters?: Partial<SearchFilters>): Promise<number> {
    this.ensureInitialized();

    const { where, params } = this.buildDocumentFilters(filters);
    const result = await this.db!.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM documents ${where}`,
      params,
    );

    return parseInt(result.rows[0].count, 10);
  }

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  async createChunks(
    documentId: string,
    chunks: CreateChunkInput[],
  ): Promise<DocumentChunk[]> {
    this.ensureInitialized();

    const createdChunks: DocumentChunk[] = [];
    const now = new Date().toISOString();

    for (const chunk of chunks) {
      const id = generateId();

      await this.db!.query(
        `INSERT INTO chunks (
          id, document_id, chunk_index, text, start_offset, end_offset,
          page, section, token_count, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
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
        ],
      );

      // Update FTS vector
      await this.db!.query(UPDATE_FTS_VECTOR_SQL, [id]);

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

    return createdChunks;
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    this.ensureInitialized();

    const result = await this.db!.query<ChunkRow>(
      'SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );

    return result.rows.map((row) => this.rowToChunk(row));
  }

  async deleteChunks(documentId: string): Promise<void> {
    this.ensureInitialized();
    await this.db!.query('DELETE FROM chunks WHERE document_id = $1', [
      documentId,
    ]);
  }

  async updateChunkEmbeddings(
    updates: UpdateChunkEmbeddingInput[],
  ): Promise<void> {
    this.ensureInitialized();

    for (const update of updates) {
      await this.db!.query('UPDATE chunks SET embedding = $1 WHERE id = $2', [
        formatVector(update.embedding),
        update.id,
      ]);
    }
  }

  async countChunks(): Promise<number> {
    this.ensureInitialized();

    const result = await this.db!.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM chunks',
    );
    return parseInt(result.rows[0].count, 10);
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async addTags(documentId: string, tags: string[]): Promise<void> {
    this.ensureInitialized();

    for (const tagName of tags) {
      // Get or create tag
      const result = await this.db!.query<TagRow>(
        'SELECT id FROM tags WHERE name = $1',
        [tagName],
      );

      let tagId: string;
      if (result.rows.length === 0) {
        tagId = generateId();
        await this.db!.query('INSERT INTO tags (id, name) VALUES ($1, $2)', [
          tagId,
          tagName,
        ]);
      } else {
        tagId = result.rows[0].id;
      }

      // Link tag to document (ignore if already exists)
      await this.db!.query(
        `INSERT INTO document_tags (document_id, tag_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [documentId, tagId],
      );
    }
  }

  async removeTags(documentId: string, tags: string[]): Promise<void> {
    this.ensureInitialized();

    for (const tagName of tags) {
      const result = await this.db!.query<TagRow>(
        'SELECT id FROM tags WHERE name = $1',
        [tagName],
      );

      if (result.rows.length > 0) {
        await this.db!.query(
          'DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2',
          [documentId, result.rows[0].id],
        );
      }
    }
  }

  async getDocumentTags(documentId: string): Promise<string[]> {
    this.ensureInitialized();

    const result = await this.db!.query<{ name: string }>(
      `SELECT t.name FROM tags t
       JOIN document_tags dt ON t.id = dt.tag_id
       WHERE dt.document_id = $1
       ORDER BY t.name`,
      [documentId],
    );

    return result.rows.map((row) => row.name);
  }

  async getAllTags(): Promise<TagCount[]> {
    this.ensureInitialized();

    const result = await this.db!.query<TagCountRow>(
      `SELECT t.name as tag, COUNT(dt.document_id) as count
       FROM tags t
       LEFT JOIN document_tags dt ON t.id = dt.tag_id
       GROUP BY t.id, t.name
       ORDER BY count DESC, t.name`,
    );

    return result.rows.map((row) => ({
      tag: row.tag,
      count:
        typeof row.count === 'string' ? parseInt(row.count, 10) : row.count,
    }));
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    // Try FTS first, then fall back to ILIKE
    const ftsParams = [query, ...filterParams, limit];
    const ftsParamOffset = filterParams.length + 1;

    const ftsSql = `
      SELECT
        c.id as chunk_id,
        c.document_id,
        d.file_path,
        d.file_name,
        c.text as chunk_text,
        c.page,
        c.section,
        ts_rank(c.fts_vector, plainto_tsquery($1)) as score,
        'keyword' as match_type
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.fts_vector @@ plainto_tsquery($1)
        AND d.status = 'indexed'
        ${filterWhere ? `AND ${filterWhere}` : ''}
      ORDER BY score DESC
      LIMIT $${ftsParamOffset + 1}
    `;

    try {
      const ftsResult = await this.db!.query<SearchResultRow>(
        ftsSql,
        ftsParams,
      );
      if (ftsResult.rows.length > 0) {
        return this.rowsToSearchResults(ftsResult.rows);
      }
    } catch {
      // FTS might not be supported, fall through to ILIKE
    }

    // Fallback to ILIKE search for compatibility
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (searchTerms.length === 0) return [];

    // Build ILIKE conditions for each word
    const likeConditions = searchTerms
      .map((_, i) => `LOWER(c.text) LIKE $${i + 1}`)
      .join(' AND ');

    const likeParams = [
      ...searchTerms.map((t) => `%${t}%`),
      ...filterParams,
      limit,
    ];
    const likeParamOffset = searchTerms.length + filterParams.length;

    const likeSql = `
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
      LIMIT $${likeParamOffset + 1}
    `;

    const likeResult = await this.db!.query<SearchResultRow>(
      likeSql,
      likeParams,
    );
    return this.rowsToSearchResults(likeResult.rows);
  }

  async searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    const vectorStr = formatVector(embedding);
    const params = [vectorStr, ...filterParams, limit];
    const paramOffset = filterParams.length + 1;

    const sql = `
      SELECT
        c.id as chunk_id,
        c.document_id,
        d.file_path,
        d.file_name,
        c.text as chunk_text,
        c.page,
        c.section,
        1 - (c.embedding <=> $1) as score,
        'semantic' as match_type
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.embedding IS NOT NULL
        AND d.status = 'indexed'
        ${filterWhere ? `AND ${filterWhere}` : ''}
      ORDER BY c.embedding <=> $1
      LIMIT $${paramOffset + 1}
    `;

    const result = await this.db!.query<SearchResultRow>(sql, params);
    return this.rowsToSearchResults(result.rows);
  }

  async searchHybrid(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
    weights: HybridSearchWeights = { semantic: 0.5, keyword: 0.5 },
    rrfK = 60,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    const vectorStr = formatVector(embedding);
    const filterClause = filterWhere ? `AND ${filterWhere}` : '';

    // Build parameter list
    const params = [
      vectorStr,
      query,
      weights.semantic,
      weights.keyword,
      rrfK,
      ...filterParams,
      limit,
    ];

    const sql = `
      WITH semantic_results AS (
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1) as rank
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.embedding IS NOT NULL
          AND d.status = 'indexed'
          ${filterClause}
        ORDER BY c.embedding <=> $1
        LIMIT 50
      ),
      keyword_results AS (
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank(c.fts_vector, plainto_tsquery($2)) DESC
          ) as rank
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.fts_vector @@ plainto_tsquery($2)
          AND d.status = 'indexed'
          ${filterClause}
        ORDER BY ts_rank(c.fts_vector, plainto_tsquery($2)) DESC
        LIMIT 50
      ),
      combined AS (
        SELECT
          COALESCE(s.chunk_id, k.chunk_id) as chunk_id,
          COALESCE(s.document_id, k.document_id) as document_id,
          COALESCE(s.file_path, k.file_path) as file_path,
          COALESCE(s.file_name, k.file_name) as file_name,
          COALESCE(s.chunk_text, k.chunk_text) as chunk_text,
          COALESCE(s.page, k.page) as page,
          COALESCE(s.section, k.section) as section,
          COALESCE($3::float / ($5::float + s.rank), 0) +
          COALESCE($4::float / ($5::float + k.rank), 0) as score,
          CASE
            WHEN s.chunk_id IS NOT NULL AND k.chunk_id IS NOT NULL THEN 'hybrid'
            WHEN s.chunk_id IS NOT NULL THEN 'semantic'
            ELSE 'keyword'
          END as match_type
        FROM semantic_results s
        FULL OUTER JOIN keyword_results k ON s.chunk_id = k.chunk_id
      )
      SELECT * FROM combined
      ORDER BY score DESC
      LIMIT $${params.length}
    `;

    const result = await this.db!.query<SearchResultRow>(sql, params);
    return this.rowsToSearchResults(result.rows);
  }

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  async enqueueItem(input: CreateQueueItemInput): Promise<QueueItem> {
    this.ensureInitialized();

    const id = generateId();
    const now = new Date().toISOString();

    await this.db!.query(
      `INSERT INTO index_queue (id, file_path, priority, status, attempts, created_at)
       VALUES ($1, $2, $3, 'pending', 0, $4)
       ON CONFLICT (file_path) DO UPDATE SET
         priority = EXCLUDED.priority,
         status = 'pending',
         attempts = 0,
         last_error = NULL,
         started_at = NULL,
         completed_at = NULL`,
      [id, input.filePath, input.priority ?? 'normal', now],
    );

    const item = await this.getQueueItemByPath(input.filePath);
    if (!item) throw new Error('Failed to create queue item');
    return item;
  }

  async enqueueItems(inputs: CreateQueueItemInput[]): Promise<QueueItem[]> {
    const items: QueueItem[] = [];
    for (const input of inputs) {
      items.push(await this.enqueueItem(input));
    }
    return items;
  }

  async dequeueItem(): Promise<QueueItem | null> {
    this.ensureInitialized();

    // Get next pending item by priority order
    const result = await this.db!.query<QueueItemRow>(
      `UPDATE index_queue
       SET status = 'processing', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM index_queue
         WHERE status = 'pending'
         ORDER BY
           CASE priority
             WHEN 'high' THEN 1
             WHEN 'normal' THEN 2
             WHEN 'low' THEN 3
             WHEN 'ocr' THEN 4
           END,
           created_at
         LIMIT 1
       )
       RETURNING *`,
    );

    if (result.rows.length === 0) return null;
    return this.rowToQueueItem(result.rows[0]);
  }

  async updateQueueItem(
    id: string,
    updates: UpdateQueueItemInput,
  ): Promise<QueueItem> {
    this.ensureInitialized();

    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      sets.push(`status = $${paramIndex}`);
      params.push(updates.status);
      paramIndex++;
    }
    if (updates.attempts !== undefined) {
      sets.push(`attempts = $${paramIndex}`);
      params.push(updates.attempts);
      paramIndex++;
    }
    if (updates.lastError !== undefined) {
      sets.push(`last_error = $${paramIndex}`);
      params.push(updates.lastError);
      paramIndex++;
    }
    if (updates.startedAt !== undefined) {
      sets.push(`started_at = $${paramIndex}`);
      params.push(updates.startedAt?.toISOString() ?? null);
      paramIndex++;
    }
    if (updates.completedAt !== undefined) {
      sets.push(`completed_at = $${paramIndex}`);
      params.push(updates.completedAt?.toISOString() ?? null);
      paramIndex++;
    }

    params.push(id);

    if (sets.length > 0) {
      await this.db!.query(
        `UPDATE index_queue SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
        params,
      );
    }

    const result = await this.db!.query<QueueItemRow>(
      'SELECT * FROM index_queue WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) throw new Error('Queue item not found');
    return this.rowToQueueItem(result.rows[0]);
  }

  async deleteQueueItem(id: string): Promise<void> {
    this.ensureInitialized();
    await this.db!.query('DELETE FROM index_queue WHERE id = $1', [id]);
  }

  async getQueueItemByPath(filePath: string): Promise<QueueItem | null> {
    this.ensureInitialized();

    const result = await this.db!.query<QueueItemRow>(
      'SELECT * FROM index_queue WHERE file_path = $1',
      [filePath],
    );

    if (result.rows.length === 0) return null;
    return this.rowToQueueItem(result.rows[0]);
  }

  async getQueueStatus(): Promise<QueueStatus> {
    this.ensureInitialized();

    const statusResult = await this.db!.query<{
      status: string;
      count: string;
    }>(`SELECT status, COUNT(*) as count FROM index_queue GROUP BY status`);

    const priorityResult = await this.db!.query<{
      priority: string;
      count: string;
    }>(
      `SELECT priority, COUNT(*) as count FROM index_queue
       WHERE status = 'pending' GROUP BY priority`,
    );

    const statusCounts: Record<string, number> = {};
    for (const row of statusResult.rows) {
      statusCounts[row.status] = parseInt(row.count, 10);
    }

    const priorityCounts: Record<QueuePriority, number> = {
      high: 0,
      normal: 0,
      low: 0,
      ocr: 0,
    };
    for (const row of priorityResult.rows) {
      priorityCounts[row.priority as QueuePriority] = parseInt(row.count, 10);
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
    this.ensureInitialized();

    const result = await this.db!.query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM index_queue WHERE status = 'completed' RETURNING *
      ) SELECT COUNT(*) as count FROM deleted`,
    );

    return parseInt(result.rows[0].count, 10);
  }

  async clearQueue(): Promise<void> {
    this.ensureInitialized();
    await this.db!.query('DELETE FROM index_queue');
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async getFileHashes(): Promise<Map<string, string>> {
    this.ensureInitialized();

    const result = await this.db!.query<{
      file_path: string;
      file_hash: string;
    }>('SELECT file_path, file_hash FROM documents');

    const map = new Map<string, string>();
    for (const row of result.rows) {
      map.set(row.file_path, row.file_hash);
    }
    return map;
  }

  async getDocumentsModifiedSince(date: Date): Promise<Document[]> {
    this.ensureInitialized();

    const result = await this.db!.query<DocumentRow>(
      'SELECT * FROM documents WHERE file_modified_at > $1 ORDER BY file_path',
      [date.toISOString()],
    );

    return result.rows.map((row) => this.rowToDocument(row));
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async getStats(): Promise<SearchStats> {
    this.ensureInitialized();

    const docResult = await this.db!.query<StatsRow>(`
      SELECT
        COUNT(*) as total_documents,
        COUNT(*) FILTER (WHERE status = 'indexed') as indexed_documents,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_documents,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_documents,
        COUNT(*) FILTER (WHERE ocr_status = 'pending') as ocr_pending,
        COALESCE(SUM(file_size), 0) as total_file_size
      FROM documents
    `);

    const chunkResult = await this.db!.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM chunks',
    );

    const tagResult = await this.db!.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM tags',
    );

    const stats = docResult.rows[0];

    return {
      totalDocuments:
        typeof stats.total_documents === 'string'
          ? parseInt(stats.total_documents, 10)
          : stats.total_documents,
      totalChunks: parseInt(chunkResult.rows[0].count, 10),
      indexedDocuments:
        typeof stats.indexed_documents === 'string'
          ? parseInt(stats.indexed_documents, 10)
          : stats.indexed_documents,
      pendingDocuments:
        typeof stats.pending_documents === 'string'
          ? parseInt(stats.pending_documents, 10)
          : stats.pending_documents,
      failedDocuments:
        typeof stats.failed_documents === 'string'
          ? parseInt(stats.failed_documents, 10)
          : stats.failed_documents,
      ocrPending:
        typeof stats.ocr_pending === 'string'
          ? parseInt(stats.ocr_pending, 10)
          : stats.ocr_pending,
      totalTags: parseInt(tagResult.rows[0].count, 10),
      databaseSize:
        typeof stats.total_file_size === 'string'
          ? parseInt(stats.total_file_size, 10)
          : stats.total_file_size,
    };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  async getConfigValue<T>(key: string): Promise<T | null> {
    this.ensureInitialized();

    const result = await this.db!.query<{ value: T }>(
      'SELECT value FROM search_config WHERE key = $1',
      [key],
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].value;
  }

  async setConfigValue<T>(key: string, value: T): Promise<void> {
    this.ensureInitialized();

    await this.db!.query(
      `INSERT INTO search_config (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(value)],
    );
  }

  // -------------------------------------------------------------------------
  // Raw Query
  // -------------------------------------------------------------------------

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    this.ensureInitialized();
    const result = await this.db!.query<T>(sql, params);
    return result.rows;
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    this.ensureInitialized();
    await this.db!.query(sql, params);
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
      fileSize:
        typeof row.file_size === 'string'
          ? parseInt(row.file_size, 10)
          : row.file_size,
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
      metadata:
        typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : row.metadata,
      tags: [], // Tags loaded separately if needed
    };
  }

  private rowToChunk(row: ChunkRow): DocumentChunk {
    return {
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      embedding: row.embedding
        ? JSON.parse(row.embedding.replace(/^\[/, '[').replace(/\]$/, ']'))
        : null,
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
      chunkText: row.chunk_text,
      score: row.score,
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
    let paramIndex = 1;

    if (filters.folders && filters.folders.length > 0) {
      const folderConditions = filters.folders.map(() => {
        // Normalize path separators in both the stored path and the filter
        const condition = `REPLACE(file_path, '\\', '/') LIKE $${paramIndex}`;
        paramIndex++;
        return condition;
      });
      conditions.push(`(${folderConditions.join(' OR ')})`);
      // Normalize path separators and use %folder% pattern to match anywhere in path
      params.push(
        ...filters.folders.map((f) => {
          const normalized = f.replace(/\\/g, '/');
          return `%${normalized}%`;
        }),
      );
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const placeholders = filters.fileTypes.map(() => `$${paramIndex++}`);
      conditions.push(`file_extension IN (${placeholders.join(', ')})`);
      params.push(
        ...filters.fileTypes.map((t) => (t.startsWith('.') ? t : `.${t}`)),
      );
    }

    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => `$${paramIndex++}`);
      conditions.push(`status IN (${placeholders.join(', ')})`);
      params.push(...filters.status);
    }

    if (filters.dateFrom) {
      conditions.push(`file_modified_at >= $${paramIndex++}`);
      params.push(filters.dateFrom.toISOString());
    }

    if (filters.dateTo) {
      conditions.push(`file_modified_at <= $${paramIndex++}`);
      params.push(filters.dateTo.toISOString());
    }

    if (filters.languages && filters.languages.length > 0) {
      const placeholders = filters.languages.map(() => `$${paramIndex++}`);
      conditions.push(`language IN (${placeholders.join(', ')})`);
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
    let paramIndex = 2; // Start at 2 because $1 is used for query/embedding

    if (filters.folders && filters.folders.length > 0) {
      const folderConditions = filters.folders.map(() => {
        // Normalize path separators in both the stored path and the filter
        // REPLACE(file_path, '\', '/') normalizes Windows paths to forward slashes
        const condition = `REPLACE(d.file_path, '\\', '/') LIKE $${paramIndex}`;
        paramIndex++;
        return condition;
      });
      conditions.push(`(${folderConditions.join(' OR ')})`);
      // Normalize path separators and use %folder% pattern to match anywhere in path
      params.push(
        ...filters.folders.map((f) => {
          // Normalize to forward slashes, then wrap with % for partial match
          const normalized = f.replace(/\\/g, '/');
          return `%${normalized}%`;
        }),
      );
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const placeholders = filters.fileTypes.map(() => `$${paramIndex++}`);
      conditions.push(`d.file_extension IN (${placeholders.join(', ')})`);
      params.push(
        ...filters.fileTypes.map((t) => (t.startsWith('.') ? t : `.${t}`)),
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      const placeholders = filters.tags.map(() => `$${paramIndex++}`);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id
          WHERE dt.document_id = d.id AND t.name IN (${placeholders.join(', ')})
        )
      `);
      params.push(...filters.tags);
    }

    if (filters.dateFrom) {
      conditions.push(`d.file_modified_at >= $${paramIndex++}`);
      params.push(filters.dateFrom.toISOString());
    }

    if (filters.dateTo) {
      conditions.push(`d.file_modified_at <= $${paramIndex++}`);
      params.push(filters.dateTo.toISOString());
    }

    if (filters.languages && filters.languages.length > 0) {
      const placeholders = filters.languages.map(() => `$${paramIndex++}`);
      conditions.push(`d.language IN (${placeholders.join(', ')})`);
      params.push(...filters.languages);
    }

    const where = conditions.join(' AND ');

    return { where, params };
  }
}
