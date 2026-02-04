/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Database metadata management.
 *
 * Stores configuration and metadata in a JSON file alongside the database.
 * This allows:
 * - Reading config before database initialization (no chicken-and-egg)
 * - Human-readable inspection of database configuration
 * - Easy portability (copy folder = copy everything)
 * - Expandability for future metadata fields
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VectorIndexType, StorageBackend } from '../config.js';
import type { EmbedderQuantization } from '../embedders/types.js';
import type { BackendOptions } from '../config/backend-options.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Vector index configuration stored in metadata.
 */
export interface MetadataVectorIndex {
  /** Index type (hnsw, ivfflat, none) */
  type: VectorIndexType;
  /** Whether half-precision vectors (halfvec) are used */
  useHalfVec: boolean;
  /**
   * Whether to create the index at all. Default: true
   * If false, no index is created and all searches use brute force.
   * Useful if index creation crashes or for small databases.
   */
  createIndex?: boolean;
  // HNSW parameters
  /** HNSW: m parameter (max edges per node) */
  hnswM?: number;
  /** HNSW: ef_construction parameter */
  hnswEfConstruction?: number;
  // IVFFlat parameters
  /** IVFFlat: number of lists (if not auto) */
  ivfflatLists?: number;
  /** IVFFlat: probes for search */
  ivfflatProbes?: number;
}

/**
 * Embedder configuration stored in metadata.
 */
export interface MetadataEmbeddings {
  /** Model ID used for embeddings */
  model: string;
  /** Embedding dimensions */
  dimensions: number;
  /** Quantization used (fp16, q8, etc.) */
  quantization: EmbedderQuantization;
}

/**
 * Database statistics (updated periodically).
 */
export interface MetadataStats {
  /** Total number of documents */
  documentCount?: number;
  /** Total number of chunks */
  chunkCount?: number;
  /** Last time stats were updated */
  updatedAt?: string;
}

/**
 * Schema documentation included in metadata file for user reference.
 */
export interface MetadataSchema {
  /** Supported vector index types */
  vectorIndexTypes: string[];
  /** Supported quantization options */
  quantizationOptions: string[];
  /** createIndex option description */
  createIndex: string;
}

/**
 * Complete database metadata structure.
 */
export interface DatabaseMetadata {
  /** Metadata format version (for future migrations) */
  version: string;
  /** Storage backend that created this database */
  backend: StorageBackend;
  /** When the database was created */
  createdAt: string;
  /** When metadata was last updated */
  updatedAt: string;
  /** Vector index configuration */
  vectorIndex: MetadataVectorIndex;
  /** Embeddings configuration */
  embeddings: MetadataEmbeddings;
  /**
   * Backend-specific storage options.
   * These are frozen at database creation and define how vectors are stored.
   * E.g., libsql: metric, compressNeighbors, maxNeighbors
   */
  backendOptions?: BackendOptions;
  /** Optional statistics */
  stats?: MetadataStats;
  /** Schema documentation (for user reference when viewing file) */
  _schema?: MetadataSchema;
}

// ============================================================================
// Constants
// ============================================================================

/** Current metadata format version */
export const METADATA_VERSION = '1.0.0';

/** Default metadata filename (inside db folder) */
export const METADATA_FILENAME = 'db-config.json';

/**
 * Database filenames for each backend (inside the db folder).
 * All backends now use directory-based storage for consistency and metadata support.
 */
export const DATABASE_FILENAMES: Record<StorageBackend, string> = {
  pglite: '', // PGlite uses the directory itself, no separate file
  sqlite: 'data.sqlite',
  libsql: 'data.db',
  lancedb: '', // LanceDB uses the directory itself, no separate file
};

// ============================================================================
// Functions
// ============================================================================

/**
 * Get the metadata file path for a database.
 * @param dbPath - Path to the database directory (e.g., '.auditaria/knowledge-base.db')
 * @returns Path to the metadata file inside the db folder (e.g., '.auditaria/knowledge-base.db/db-config.json')
 */
export function getMetadataPath(dbPath: string): string {
  // Put metadata inside the database folder for portability
  return path.join(dbPath, METADATA_FILENAME);
}

/**
 * Get the actual database file path for a backend.
 * All backends use directory-based storage. This returns the path to the database file inside the directory.
 *
 * @param dbPath - Path to the database directory (e.g., '.auditaria/knowledge-base.db')
 * @param backend - Storage backend type
 * @returns Path to the database file (e.g., '.auditaria/knowledge-base.db/data.sqlite')
 *          For PGlite and LanceDB, returns the directory path itself.
 */
export function getDatabaseFilePath(
  dbPath: string,
  backend: StorageBackend,
): string {
  const filename = DATABASE_FILENAMES[backend];
  if (!filename) {
    // PGlite and LanceDB use the directory itself
    return dbPath;
  }
  return path.join(dbPath, filename);
}

/**
 * Ensure the database directory exists.
 *
 * @param dbPath - Path to the database directory
 */
export function ensureDatabaseDirectory(dbPath: string): void {
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }
}

/**
 * Check if metadata file exists for a database.
 */
export function metadataExists(dbPath: string): boolean {
  return fs.existsSync(getMetadataPath(dbPath));
}

/**
 * Read metadata from file.
 * @param dbPath - Path to the database directory
 * @returns Metadata object, or null if file doesn't exist
 * @throws Error if file exists but is invalid
 */
export function readMetadata(dbPath: string): DatabaseMetadata | null {
  const metaPath = getMetadataPath(dbPath);

  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    const metadata = JSON.parse(content) as DatabaseMetadata;

    // Basic validation
    if (!metadata.version || !metadata.vectorIndex || !metadata.embeddings) {
      throw new Error('Invalid metadata structure');
    }

    // Backwards compatibility: if backend is missing, default to 'pglite'
    // (only PGlite had metadata before this change)
    if (!metadata.backend) {
      metadata.backend = 'pglite';
    }

    return metadata;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid metadata file at ${metaPath}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Write metadata to file.
 * @param dbPath - Path to the database directory
 * @param metadata - Metadata to write
 */
export function writeMetadata(
  dbPath: string,
  metadata: DatabaseMetadata,
): void {
  const metaPath = getMetadataPath(dbPath);

  // Ensure directory exists
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Update timestamp
  metadata.updatedAt = new Date().toISOString();

  // Write with pretty formatting for human readability
  const content = JSON.stringify(metadata, null, 2);
  fs.writeFileSync(metaPath, content, 'utf-8');
}

/**
 * Create initial metadata for a new database.
 *
 * @param backend - Storage backend type
 * @param vectorIndex - Vector index configuration
 * @param embeddings - Embeddings configuration
 * @param backendOptions - Optional backend-specific storage options
 */
export function createMetadata(
  backend: StorageBackend,
  vectorIndex: MetadataVectorIndex,
  embeddings: MetadataEmbeddings,
  backendOptions?: BackendOptions,
): DatabaseMetadata {
  const now = new Date().toISOString();
  // Order fields by importance: backend options > embeddings > vector index
  return {
    version: METADATA_VERSION,
    backend,
    createdAt: now,
    updatedAt: now,
    backendOptions,
    embeddings,
    vectorIndex,
    // Include schema documentation for users viewing the file
    _schema: {
      vectorIndexTypes: ['hnsw', 'ivfflat', 'none'],
      quantizationOptions: ['q8', 'fp16', 'fp32', 'q4'],
      createIndex: 'boolean - set to false to disable index (use brute force)',
    },
  };
}

/**
 * Update stats in metadata file.
 * @param dbPath - Path to the database directory
 * @param stats - Stats to update
 */
export function updateMetadataStats(
  dbPath: string,
  stats: Partial<MetadataStats>,
): void {
  const metadata = readMetadata(dbPath);
  if (!metadata) return;

  metadata.stats = {
    ...metadata.stats,
    ...stats,
    updatedAt: new Date().toISOString(),
  };

  writeMetadata(dbPath, metadata);
}

/**
 * Delete metadata file.
 */
export function deleteMetadata(dbPath: string): void {
  const metaPath = getMetadataPath(dbPath);
  if (fs.existsSync(metaPath)) {
    fs.unlinkSync(metaPath);
  }
}

/**
 * Validate that current config is compatible with stored metadata.
 *
 * IMPORTANT: The metadata (database config) is authoritative.
 * When opening an existing database, we use its stored config, not the code defaults.
 * This allows sharing databases between users with different default configs.
 *
 * This function only checks for truly incompatible scenarios that would cause errors.
 *
 * @returns Object with compatibility status and details
 */
export function validateCompatibility(
  metadata: DatabaseMetadata,
  _currentVectorIndex: MetadataVectorIndex,
  _currentEmbeddings: MetadataEmbeddings,
): {
  compatible: boolean;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];

  // The database's metadata is authoritative.
  // We don't validate mismatches - we just use the stored config.
  // This allows:
  // - Sharing databases between users with different defaults
  // - Using multiple databases with different configurations
  // - Changing defaults without breaking existing databases

  // Only check for corruption/invalid metadata
  if (!metadata.vectorIndex) {
    errors.push('Invalid metadata: missing vectorIndex');
  }
  if (!metadata.embeddings) {
    errors.push('Invalid metadata: missing embeddings');
  }
  if (metadata.embeddings && metadata.embeddings.dimensions <= 0) {
    errors.push('Invalid metadata: dimensions must be positive');
  }

  return {
    compatible: errors.length === 0,
    warnings,
    errors,
  };
}
