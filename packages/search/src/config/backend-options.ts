/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Backend-specific storage options.
 *
 * Each storage backend (libsql, pglite, sqlite, lancedb) has its own
 * configuration options that affect how vectors are stored and indexed.
 * These options are stored in db-config.json and persist with the database.
 */

import type { StorageBackend } from '../config.js';

// ============================================================================
// LibSQL Backend Options
// ============================================================================

/**
 * LibSQL-specific storage options.
 * These control how vectors are stored and indexed using libSQL's native vector support.
 *
 * @see https://docs.turso.tech/features/ai-and-embeddings
 */
export interface LibSQLBackendOptions {
  /**
   * Distance metric for vector similarity. Default: 'cosine'
   * - 'cosine': Cosine similarity (recommended for text embeddings)
   * - 'l2': Euclidean distance
   * - 'inner_product': Dot product similarity
   */
  metric: 'cosine' | 'l2' | 'inner_product';

  /**
   * Compression for index neighbors. Default: 'float8'
   * Reduces index size at the cost of some accuracy.
   * - 'float8': 8-bit quantization (recommended)
   * - 'float1bit': 1-bit quantization (smallest, lowest accuracy)
   * - null: No compression (full precision)
   */
  compressNeighbors: 'float8' | 'float1bit' | null;

  /**
   * Max neighbors per node in the DiskANN index. Default: 20
   * Lower values = smaller index but potentially lower recall.
   * Typical range: 10-50. Turso benchmarks suggest 20 for good balance.
   */
  maxNeighbors: number;
}

/** Default options for LibSQL backend */
export const DEFAULT_LIBSQL_OPTIONS: LibSQLBackendOptions = {
  metric: 'cosine',
  compressNeighbors: 'float8',
  maxNeighbors: 20,
};

// ============================================================================
// PGLite Backend Options
// ============================================================================

/**
 * PGLite-specific storage options.
 * These control pgvector behavior in the WASM PostgreSQL environment.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Reserved for future PGLite-specific options
export interface PGLiteBackendOptions {
  // Currently no PGLite-specific options beyond what's in VectorIndexConfig
  // This interface is kept for type consistency and future extensibility
}

/** Default options for PGLite backend */
export const DEFAULT_PGLITE_OPTIONS: PGLiteBackendOptions = {};

// ============================================================================
// SQLite Backend Options
// ============================================================================

/**
 * SQLite-specific storage options.
 * These control vectorlite behavior in the native SQLite environment.
 */
export interface SQLiteBackendOptions {
  /**
   * Path to the external vector index file. Default: auto-generated
   * Vectorlite stores the vector index in a separate file.
   */
  indexPath?: string;
}

/** Default options for SQLite backend */
export const DEFAULT_SQLITE_OPTIONS: SQLiteBackendOptions = {};

// ============================================================================
// LanceDB Backend Options
// ============================================================================

/**
 * LanceDB-specific storage options.
 * These control the columnar vector database behavior.
 */
export interface LanceDBBackendOptions {
  /**
   * Number of partitions for IVF index. Default: auto
   * More partitions = faster search but slower build.
   */
  numPartitions?: number;

  /**
   * Number of sub-vectors for PQ compression. Default: auto
   * More sub-vectors = better recall but larger index.
   */
  numSubVectors?: number;
}

/** Default options for LanceDB backend */
export const DEFAULT_LANCEDB_OPTIONS: LanceDBBackendOptions = {};

// ============================================================================
// Union Types
// ============================================================================

/**
 * Discriminated union of all backend options.
 * The `backend` field determines which options are valid.
 * This type is used when storing options in db-config.json.
 */
export type BackendOptions =
  | ({ backend: 'libsql' } & LibSQLBackendOptions)
  | ({ backend: 'pglite' } & PGLiteBackendOptions)
  | ({ backend: 'sqlite' } & SQLiteBackendOptions)
  | ({ backend: 'lancedb' } & LanceDBBackendOptions);

/**
 * Map of partial backend options keyed by backend name.
 * This type is used in search.config.json to allow users to configure
 * preferences for any backend they might use.
 */
export interface BackendOptionsMap {
  libsql?: Partial<LibSQLBackendOptions>;
  pglite?: Partial<PGLiteBackendOptions>;
  sqlite?: Partial<SQLiteBackendOptions>;
  lancedb?: Partial<LanceDBBackendOptions>;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get default backend options for a given storage backend.
 *
 * @param backend - The storage backend type
 * @returns Complete default options for that backend (with discriminator)
 */
export function getDefaultBackendOptions(
  backend: StorageBackend,
): BackendOptions {
  switch (backend) {
    case 'libsql':
      return { backend: 'libsql', ...DEFAULT_LIBSQL_OPTIONS };
    case 'pglite':
      return { backend: 'pglite', ...DEFAULT_PGLITE_OPTIONS };
    case 'sqlite':
      return { backend: 'sqlite', ...DEFAULT_SQLITE_OPTIONS };
    case 'lancedb':
      return { backend: 'lancedb', ...DEFAULT_LANCEDB_OPTIONS };
    default: {
      // Exhaustive check - TypeScript will error if we miss a case
      const _exhaustive: never = backend;
      throw new Error(`Unknown backend: ${_exhaustive}`);
    }
  }
}

/**
 * Merge user-provided backend options with defaults.
 *
 * @param backend - The storage backend type
 * @param userOptions - Optional user preferences from search.config.json
 * @returns Complete backend options with user overrides applied
 */
export function mergeBackendOptions(
  backend: StorageBackend,
  userOptions?: BackendOptionsMap,
): BackendOptions {
  const defaults = getDefaultBackendOptions(backend);
  const overrides = userOptions?.[backend];

  if (!overrides) {
    return defaults;
  }

  // Merge overrides with defaults
  return { ...defaults, ...overrides } as BackendOptions;
}

/**
 * Extract backend-specific options from the discriminated union.
 * Useful for type-safe access when you know the backend type.
 *
 * @param options - Backend options with discriminator
 * @param backend - Expected backend type
 * @returns Typed options for that backend, or undefined if mismatch
 */
export function getTypedBackendOptions<B extends StorageBackend>(
  options: BackendOptions | undefined,
  backend: B,
):
  | (B extends 'libsql'
      ? LibSQLBackendOptions
      : B extends 'pglite'
        ? PGLiteBackendOptions
        : B extends 'sqlite'
          ? SQLiteBackendOptions
          : B extends 'lancedb'
            ? LanceDBBackendOptions
            : never)
  | undefined {
  if (!options || options.backend !== backend) {
    return undefined;
  }
  // TypeScript can't fully narrow here, but runtime check ensures correctness
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return options as any;
}

/**
 * Validate backend options for a specific backend.
 * Throws descriptive errors for invalid values.
 *
 * @param options - Backend options to validate
 */
export function validateBackendOptions(options: BackendOptions): void {
  switch (options.backend) {
    case 'libsql': {
      const validMetrics = ['cosine', 'l2', 'inner_product'];
      if (!validMetrics.includes(options.metric)) {
        throw new Error(
          `Invalid libsql metric: ${options.metric}. Must be one of: ${validMetrics.join(', ')}`,
        );
      }

      const validCompress = ['float8', 'float1bit', null];
      if (!validCompress.includes(options.compressNeighbors)) {
        throw new Error(
          `Invalid libsql compressNeighbors: ${options.compressNeighbors}. Must be one of: float8, float1bit, null`,
        );
      }

      if (
        typeof options.maxNeighbors !== 'number' ||
        options.maxNeighbors <= 0
      ) {
        throw new Error(
          `Invalid libsql maxNeighbors: ${options.maxNeighbors}. Must be a positive number`,
        );
      }
      break;
    }

    case 'pglite':
      // No validation needed for current options
      break;

    case 'sqlite':
      // No validation needed for current options
      break;

    case 'lancedb':
      if (options.numPartitions !== undefined && options.numPartitions <= 0) {
        throw new Error(
          `Invalid lancedb numPartitions: ${options.numPartitions}. Must be positive`,
        );
      }
      if (options.numSubVectors !== undefined && options.numSubVectors <= 0) {
        throw new Error(
          `Invalid lancedb numSubVectors: ${options.numSubVectors}. Must be positive`,
        );
      }
      break;

    default: {
      const _exhaustive: never = options;
      throw new Error(
        `Unknown backend in options: ${(_exhaustive as BackendOptions).backend}`,
      );
    }
  }
}
