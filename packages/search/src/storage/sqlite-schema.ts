/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// ============================================================================
// SQLite + vectorlite + FTS5 Schema Definitions
// ============================================================================

export interface SQLiteChunksVecOptions {
  /** Embedding dimensions. Default: 384 */
  dimensions: number;
  /** HNSW max_elements parameter. Default: 1000000 */
  maxElements: number;
  /** HNSW ef_construction parameter. Default: 200 */
  efConstruction: number;
  /** HNSW M parameter (max edges per node). Default: 32 */
  hnswM: number;
  /** Distance metric: 'l2', 'cosine', or 'ip'. Default: 'ip' (inner product, best for normalized vectors) */
  distanceType: 'l2' | 'cosine' | 'ip';
  /** Optional path to persist the index file */
  indexFilePath?: string;
  /** Use HNSW index (true) or brute force search (false). Default: true */
  useHnsw?: boolean;
}

/**
 * Base schema SQL for SQLite (documents, tags, queue, config tables).
 * Does NOT include chunks tables - those are created separately.
 */
export const SQLITE_BASE_SCHEMA_SQL = `
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
 * Chunks main table SQL.
 * This table stores chunk metadata and text (no embedding column).
 * Embeddings are stored separately in the vectorlite virtual table.
 */
export const SQLITE_CHUNKS_TABLE_SQL = `
-- Chunks table (metadata, text, and optional embedding for brute force search)
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  page INTEGER,
  section TEXT,
  token_count INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
`;

/**
 * FTS5 virtual table SQL for full-text search.
 * Uses external content mode pointing to chunks table.
 */
export const SQLITE_FTS5_TABLE_SQL = `
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
export const SQLITE_FTS5_TRIGGERS_SQL = `
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
 * Generate vectorlite virtual table SQL for vector search.
 * @param options - Configuration for the vectorlite table
 * @returns SQL to create the vectorlite virtual table
 */
export function getSQLiteVectorTableSQL(options: SQLiteChunksVecOptions): string {
  const {
    dimensions,
    maxElements,
    efConstruction,
    hnswM,
    distanceType,
    indexFilePath,
    useHnsw = true,
  } = options;

  if (!useHnsw) {
    // Brute force mode - no HNSW index, searches all vectors linearly
    return `
-- vectorlite virtual table for vector search (brute force mode)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vectorlite(
  embedding float32[${dimensions}] ${distanceType}
);
`.trim();
  }

  // HNSW mode - fast approximate nearest neighbor search
  const hnswParams = [
    `max_elements=${maxElements}`,
    `ef_construction=${efConstruction}`,
    `M=${hnswM}`,
  ].join(', ');

  // Include index file path if provided (for persistence)
  const indexFileClause = indexFilePath ? `, '${indexFilePath}'` : '';

  return `
-- vectorlite virtual table for vector search (HNSW mode)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vectorlite(
  embedding float32[${dimensions}] ${distanceType},
  hnsw(${hnswParams})${indexFileClause}
);
`.trim();
}

/**
 * Get the complete schema SQL for SQLite + vectorlite + FTS5.
 * @param vectorOptions - Configuration for the vectorlite table
 * @returns Complete schema SQL
 */
export function getSQLiteCompleteSchemaSQL(
  vectorOptions: SQLiteChunksVecOptions,
): string {
  return [
    SQLITE_BASE_SCHEMA_SQL,
    SQLITE_CHUNKS_TABLE_SQL,
    SQLITE_FTS5_TABLE_SQL,
    SQLITE_FTS5_TRIGGERS_SQL,
    getSQLiteVectorTableSQL(vectorOptions),
  ].join('\n');
}

/**
 * SQL to rebuild FTS5 index from chunks table.
 * Use this if FTS5 gets out of sync with chunks.
 */
export const SQLITE_FTS5_REBUILD_SQL = `
-- Rebuild FTS5 index from chunks table
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');
`;

/**
 * SQL to optimize FTS5 index.
 * Run periodically for better search performance.
 */
export const SQLITE_FTS5_OPTIMIZE_SQL = `
-- Optimize FTS5 index
INSERT INTO chunks_fts(chunks_fts) VALUES('optimize');
`;

/**
 * SQL to drop and recreate the vectorlite table.
 * Use this to change vector dimensions or HNSW parameters.
 */
export const SQLITE_DROP_VECTOR_TABLE_SQL = `
DROP TABLE IF EXISTS chunks_vec;
`;

/**
 * Schema version for migrations.
 */
export const SQLITE_SCHEMA_VERSION = '1';
