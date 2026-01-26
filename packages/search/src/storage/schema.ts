/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQL to initialize the database schema.
 * Includes tables for documents, chunks, tags, queue, and config.
 */
export const SCHEMA_SQL = `
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable amcheck extension for integrity verification (optional, may not be available in all environments)
CREATE EXTENSION IF NOT EXISTS amcheck;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  file_extension TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  file_hash TEXT NOT NULL,
  mime_type TEXT,
  title TEXT,
  author TEXT,
  language TEXT,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  ocr_status TEXT NOT NULL DEFAULT 'not_needed',
  indexed_at TIMESTAMP,
  file_modified_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_ocr_status ON documents(ocr_status);
CREATE INDEX IF NOT EXISTS idx_documents_file_extension ON documents(file_extension);
CREATE INDEX IF NOT EXISTS idx_documents_file_modified_at ON documents(file_modified_at);
CREATE INDEX IF NOT EXISTS idx_documents_file_hash ON documents(file_hash);

-- Chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding vector(384),
  fts_vector tsvector,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  page INTEGER,
  section TEXT,
  token_count INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);

-- Tags table
CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

-- Document-Tags junction table
CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_document_tags_tag_id ON document_tags(tag_id);

-- Index queue table
CREATE TABLE IF NOT EXISTS index_queue (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_size BIGINT NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'markup',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON index_queue(status, priority, file_size, created_at);
CREATE INDEX IF NOT EXISTS idx_queue_file_path ON index_queue(file_path);

-- Configuration table
CREATE TABLE IF NOT EXISTS search_config (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default configuration
INSERT INTO search_config (key, value) VALUES
  ('schema_version', '"1"'),
  ('initialized_at', 'null')
ON CONFLICT (key) DO NOTHING;
`;

/**
 * SQL to create FTS index on chunks after table creation.
 * This needs to run after the chunks table exists.
 */
export const FTS_INDEX_SQL = `
-- Create GIN index for FTS
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING GIN(fts_vector);
`;

/**
 * SQL to create HNSW index on chunks embedding column.
 * This enables fast approximate nearest neighbor search.
 */
export const HNSW_INDEX_SQL = `
-- Create HNSW index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
`;

/**
 * SQL to update FTS vector for a single chunk.
 */
export const UPDATE_FTS_VECTOR_SQL = `
UPDATE chunks SET fts_vector = to_tsvector('english', text)
WHERE id = $1;
`;

/**
 * Schema version for migrations.
 */
export const SCHEMA_VERSION = '1';
