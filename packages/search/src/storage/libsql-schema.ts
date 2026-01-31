/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================================================
// libSQL + Native Vector + FTS5 Schema Definitions
// ============================================================================
//
// libSQL (Turso) provides native vector columns without external extensions.
// Key advantages over vectorlite:
// - Vectors stored INSIDE the database file (crash-safe!)
// - Uses DiskANN algorithm for fast ANN search
// - No external .vec_index file that needs to be synced with db.close()
//
// References:
// - https://docs.turso.tech/features/ai-and-embeddings
// - https://turso.tech/vector
// ============================================================================

/**
 * libSQL vector column types.
 * - F32_BLOB: 32-bit float (default, full precision)
 * - F16_BLOB: 16-bit float (half precision, 50% smaller storage)
 */
export type LibSQLVectorType = 'F32_BLOB' | 'F16_BLOB';

export interface LibSQLVectorOptions {
  /** Embedding dimensions. Default: 384 */
  dimensions: number;
  /** Distance metric: 'cosine', 'l2', or 'inner_product'. Default: 'cosine' */
  metric: 'cosine' | 'l2' | 'inner_product';
  /**
   * Whether to create the vector index. Default: true
   * Set to false for small datasets where brute force is acceptable.
   */
  createIndex: boolean;
  /**
   * Vector storage type. Default: 'F32_BLOB'
   * - 'F32_BLOB': 32-bit float (1536 bytes for 384-dim)
   * - 'F16_BLOB': 16-bit float (768 bytes for 384-dim, 50% smaller)
   */
  vectorType: LibSQLVectorType;
  /**
   * Compression for index neighbors. Reduces index size.
   * Options: 'float8' (8-bit), 'float1bit' (1-bit), or null (no compression)
   * Default: 'float8' (3x smaller index)
   */
  compressNeighbors?: 'float8' | 'float1bit' | null;
  /**
   * Max neighbors per node in the index. Default: 50
   * Lower = smaller index but potentially lower recall.
   */
  maxNeighbors?: number;
}

/**
 * Base schema SQL for libSQL (documents, tags, queue, config tables).
 * Does NOT include chunks tables - those are created separately.
 */
export const LIBSQL_BASE_SCHEMA_SQL = `
-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  file_hash TEXT NOT NULL,
  mime_type TEXT,
  title TEXT,
  author TEXT,
  language TEXT,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  ocr_status TEXT NOT NULL DEFAULT 'not_needed',
  indexed_at TEXT,
  file_modified_at TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_ocr_status ON documents(ocr_status);
CREATE INDEX IF NOT EXISTS idx_documents_file_extension ON documents(file_extension);
CREATE INDEX IF NOT EXISTS idx_documents_file_modified_at ON documents(file_modified_at);
CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- Document-Tags junction table
CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_document_tags_tag_id ON document_tags(tag_id);

-- Index queue table
CREATE TABLE IF NOT EXISTS index_queue (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'markup',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON index_queue(status, priority, file_size, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_file_path ON index_queue(file_path);

-- Configuration table
CREATE TABLE IF NOT EXISTS search_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Insert default configuration
INSERT OR IGNORE INTO search_config (key, value) VALUES
  ('schema_version', '"1"'),
  ('initialized_at', 'null');
`;

/**
 * Generate chunks table SQL with native vector column.
 * @param dimensions - Embedding dimensions (e.g., 384)
 * @param vectorType - Vector storage type: 'F32_BLOB' (default) or 'F16_BLOB' (half precision)
 * @returns SQL to create the chunks table
 */
export function getLibSQLChunksTableSQL(
  dimensions: number,
  vectorType: LibSQLVectorType = 'F32_BLOB',
): string {
  return `
-- Chunks table with native libSQL vector column (${vectorType})
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding ${vectorType}(${dimensions}),
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  page INTEGER,
  section TEXT,
  token_count INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
`.trim();
}

/**
 * FTS5 virtual table SQL for full-text search.
 * Uses external content mode pointing to chunks table.
 */
export const LIBSQL_FTS5_TABLE_SQL = `
-- FTS5 virtual table for keyword search
-- Uses external content mode (content='chunks') to avoid data duplication
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61'
);
`;

/**
 * FTS5 sync triggers to keep FTS5 in sync with chunks table.
 */
export const LIBSQL_FTS5_TRIGGERS_SQL = `
-- Trigger: Insert into FTS5 when chunk is inserted
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;

-- Trigger: Delete from FTS5 when chunk is deleted
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;

-- Trigger: Update FTS5 when chunk is updated
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`;

/**
 * Generate vector index SQL for libSQL.
 * Uses libsql_vector_idx() to create a DiskANN index.
 * @param options - Configuration for the vector index
 * @returns SQL to create the vector index
 */
export function getLibSQLVectorIndexSQL(options: LibSQLVectorOptions): string {
  if (!options.createIndex) {
    return '-- Vector index creation skipped (createIndex: false)';
  }

  const params: string[] = [];

  // Add metric parameter
  params.push(`'metric=${options.metric}'`);

  // Add compression if specified
  if (options.compressNeighbors) {
    params.push(`'compress_neighbors=${options.compressNeighbors}'`);
  }

  // Add max_neighbors if specified
  if (options.maxNeighbors) {
    params.push(`'max_neighbors=${options.maxNeighbors}'`);
  }

  const paramsStr = params.length > 0 ? `, ${params.join(', ')}` : '';

  return `
-- libSQL vector index using DiskANN algorithm
-- This index is stored INSIDE the database file (crash-safe!)
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks (
  libsql_vector_idx(embedding${paramsStr})
);
`.trim();
}

/**
 * Get the complete schema SQL for libSQL + FTS5 + vector.
 * @param vectorOptions - Configuration for the vector index
 * @returns Complete schema SQL
 */
export function getLibSQLCompleteSchemaSQL(
  vectorOptions: LibSQLVectorOptions,
): string {
  return [
    LIBSQL_BASE_SCHEMA_SQL,
    getLibSQLChunksTableSQL(vectorOptions.dimensions, vectorOptions.vectorType),
    LIBSQL_FTS5_TABLE_SQL,
    LIBSQL_FTS5_TRIGGERS_SQL,
    getLibSQLVectorIndexSQL(vectorOptions),
  ].join('\n');
}

/**
 * SQL to rebuild FTS5 index from chunks table.
 * Use this if FTS5 gets out of sync with chunks.
 */
export const LIBSQL_FTS5_REBUILD_SQL = `
-- Rebuild FTS5 index from chunks table
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
`;

/**
 * SQL to optimize FTS5 index.
 * Run periodically for better search performance.
 */
export const LIBSQL_FTS5_OPTIMIZE_SQL = `
-- Optimize FTS5 index
INSERT INTO chunks_fts(chunks_fts) VALUES('optimize');
`;

/**
 * SQL to drop and recreate the vector index.
 * Use this to change index parameters.
 */
export const LIBSQL_DROP_VECTOR_INDEX_SQL = `
DROP INDEX IF EXISTS idx_chunks_embedding;
`;

/**
 * Schema version for migrations.
 */
export const LIBSQL_SCHEMA_VERSION = '1';
