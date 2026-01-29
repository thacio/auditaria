/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VectorIndexType } from '../config.js';

// ============================================================================
// Schema Configuration Types
// ============================================================================

export interface ChunksTableOptions {
  /** Embedding dimensions. Default: 384 */
  dimensions: number;
  /** Use half-precision vectors (halfvec). Default: false */
  useHalfVec: boolean;
}

export interface VectorIndexOptions {
  /** Index type: hnsw, ivfflat, or none */
  type: VectorIndexType;
  /** Use half-precision vectors (halfvec) */
  useHalfVec: boolean;
  /** Embedding dimensions */
  dimensions: number;
  // HNSW parameters
  /** HNSW: m parameter (max edges per node) */
  hnswM?: number;
  /** HNSW: ef_construction parameter */
  hnswEfConstruction?: number;
  // IVFFlat parameters
  /** IVFFlat: number of lists/clusters */
  ivfflatLists?: number;
}

// ============================================================================
// Dynamic Schema Generation Functions
// ============================================================================

/**
 * Base schema SQL without chunks table.
 * Use with getChunksTableSQL() for configurable vector type.
 */
export const BASE_SCHEMA_SQL = `
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
 * Generate the chunks table SQL with configurable vector type.
 * @param options - Configuration for the chunks table
 * @returns SQL to create the chunks table
 */
export function getChunksTableSQL(options: ChunksTableOptions): string {
  const vectorType = options.useHalfVec ? 'halfvec' : 'vector';
  return `
-- Chunks table
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  embedding ${vectorType}(${options.dimensions}),
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
`.trim();
}

/**
 * Generate vector index SQL based on configuration.
 * @param options - Configuration for the vector index
 * @returns SQL to create the index, or null if type is 'none'
 */
export function getVectorIndexSQL(options: VectorIndexOptions): string | null {
  if (options.type === 'none') {
    return null;
  }

  // pgvector operator class for cosine distance
  // halfvec uses halfvec_cosine_ops, vector uses vector_cosine_ops
  const vectorOps = options.useHalfVec
    ? 'halfvec_cosine_ops'
    : 'vector_cosine_ops';

  if (options.type === 'hnsw') {
    const m = options.hnswM ?? 16;
    const efConstruction = options.hnswEfConstruction ?? 64;
    return `
-- Create HNSW index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
USING hnsw (embedding ${vectorOps})
WITH (m = ${m}, ef_construction = ${efConstruction});
`.trim();
  }

  if (options.type === 'ivfflat') {
    const lists = options.ivfflatLists ?? 100;
    return `
-- Create IVFFlat index for vector similarity search
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON chunks
USING ivfflat (embedding ${vectorOps})
WITH (lists = ${lists});
`.trim();
  }

  return null;
}

/**
 * Get SQL to drop the vector index.
 */
export function getDropVectorIndexSQL(): string {
  return 'DROP INDEX IF EXISTS idx_chunks_embedding;';
}

/**
 * SQL to create FTS index on chunks after table creation.
 */
export const FTS_INDEX_SQL = `
-- Create GIN index for FTS
CREATE INDEX IF NOT EXISTS idx_chunks_fts ON chunks USING GIN(fts_vector);
`;

/**
 * SQL to update FTS vector for a single chunk.
 */
export const UPDATE_FTS_VECTOR_SQL = `
UPDATE chunks SET fts_vector = to_tsvector('simple', text)
WHERE id = $1;
`;

/**
 * Schema version for migrations.
 */
export const SCHEMA_VERSION = '1';
