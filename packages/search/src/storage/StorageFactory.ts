/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import type { StorageAdapter } from './types.js';
import type {
  DatabaseConfig,
  VectorIndexConfig,
  HybridSearchStrategy,
  StorageBackend,
} from '../config.js';
// LibSQL is the default backend - always available
import { LibSQLStorage } from './LibSQLStorage.js';
// Other backends are dynamically imported to avoid requiring their dependencies
// when not in use. This allows `npm install -g` to work without optional deps.
import { readMetadata, metadataExists } from './metadata.js';
import { createModuleLogger } from '../core/Logger.js';
import type {
  BackendOptions,
  BackendOptionsMap,
  LibSQLBackendOptions,
} from '../config/backend-options.js';
import { mergeBackendOptions } from '../config/backend-options.js';

const log = createModuleLogger('StorageFactory');

/**
 * Check if running under Bun runtime.
 * Bun only supports LibSQL backend (native deps like better-sqlite3, pglite don't work).
 */
export function isRunningInBun(): boolean {
  return typeof (globalThis as Record<string, unknown>).Bun !== 'undefined';
}

/**
 * Detect the storage backend from an existing database's metadata.
 * Returns null if no database exists or metadata is missing.
 *
 * @param dbPath - Path to the database directory
 * @returns The backend type stored in metadata, or null if not found
 */
export function detectBackendFromMetadata(
  dbPath: string,
): StorageBackend | null {
  if (!metadataExists(dbPath)) {
    return null;
  }

  try {
    const metadata = readMetadata(dbPath);
    if (metadata && metadata.backend) {
      log.info('detectBackendFromMetadata:found', {
        path: dbPath,
        backend: metadata.backend,
      });
      return metadata.backend;
    }
  } catch (error) {
    log.warn('detectBackendFromMetadata:error', {
      path: dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return null;
}

/**
 * Create a storage adapter based on the database configuration.
 *
 * If an existing database exists at the path, the backend stored in metadata
 * takes precedence over the config to prevent data corruption. Similarly,
 * backend-specific options from an existing database's metadata take precedence
 * over user-provided options.
 *
 * Non-default backends (pglite, lancedb, sqlite/vectorlite) are dynamically
 * imported to avoid requiring their dependencies when not in use.
 *
 * @param config - Database configuration including backend type
 * @param vectorIndexConfig - Vector index configuration
 * @param embeddingDimensions - Embedding dimensions (default: 384)
 * @param hybridStrategy - Hybrid search strategy (default: 'application')
 * @param backendOptions - Optional backend-specific options (for new databases)
 * @returns A StorageAdapter instance
 */
export async function createStorage(
  config: DatabaseConfig,
  vectorIndexConfig?: VectorIndexConfig,
  embeddingDimensions?: number,
  hybridStrategy?: HybridSearchStrategy,
  backendOptions?: BackendOptionsMap,
): Promise<StorageAdapter> {
  const isBun = isRunningInBun();

  // If an existing database has metadata, use its backend (authoritative)
  const existingMetadata = config.inMemory ? null : readMetadata(config.path);
  const existingBackend = existingMetadata?.backend ?? null;

  const backend = existingBackend ?? config.backend ?? 'libsql';

  // Bun only supports LibSQL (native deps like better-sqlite3, pglite don't work)
  if (isBun && backend !== 'libsql') {
    throw new Error(
      `Bun runtime only supports the LibSQL backend. ` +
        `Requested backend '${backend}' requires native dependencies that are incompatible with Bun.\n` +
        `Either use LibSQL (default) or run with Node.js instead of Bun.`,
    );
  }

  // Warn if there's a mismatch between config and existing database
  if (existingBackend && config.backend && existingBackend !== config.backend) {
    log.warn('createStorage:backendMismatch', {
      configBackend: config.backend,
      existingBackend,
      message: 'Using existing database backend from metadata',
    });
  }

  // Determine backend options: existing db > user config > defaults
  let resolvedBackendOptions: BackendOptions;
  if (existingMetadata?.backendOptions) {
    // Existing database has stored backend options - use them
    resolvedBackendOptions = existingMetadata.backendOptions;
    log.info('createStorage:usingExistingBackendOptions', {
      backend,
      source: 'database',
    });
  } else {
    // New database or old database without options - merge user options with defaults
    resolvedBackendOptions = mergeBackendOptions(backend, backendOptions);
    log.info('createStorage:usingMergedBackendOptions', {
      backend,
      source: backendOptions?.[backend] ? 'user' : 'default',
    });
  }

  log.info('createStorage', {
    backend,
    configuredBackend: config.backend,
    detectedBackend: existingBackend,
    path: config.path,
    inMemory: config.inMemory,
    dimensions: embeddingDimensions,
    backendOptions: resolvedBackendOptions,
  });

  // Dynamic imports for optional backends - only loaded when needed
  if (backend === 'lancedb') {
    log.info('createStorage:usingLanceDB');
    try {
      const { LanceDBStorage } = await import('./LanceDBStorage.js');
      // Extract LanceDB-specific options
      const lancedbOptions =
        resolvedBackendOptions.backend === 'lancedb'
          ? {
              numPartitions: resolvedBackendOptions.numPartitions,
              numSubVectors: resolvedBackendOptions.numSubVectors,
            }
          : undefined;
      return new LanceDBStorage(
        config,
        vectorIndexConfig,
        embeddingDimensions,
        lancedbOptions,
      );
    } catch (error) {
      throw new Error(
        `LanceDB backend requires @lancedb/lancedb. Install it with: npm install @lancedb/lancedb\n` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (backend === 'pglite') {
    log.info('createStorage:usingPGlite');
    try {
      const { PGliteStorage } = await import('./PGliteStorage.js');
      // Extract PGLite-specific options (currently empty, but infrastructure ready)
      const pgliteOptions =
        resolvedBackendOptions.backend === 'pglite' ? {} : undefined;
      return new PGliteStorage(
        config,
        vectorIndexConfig,
        embeddingDimensions,
        pgliteOptions,
      );
    } catch (error) {
      throw new Error(
        `PGlite backend requires @electric-sql/pglite. Install it with: npm install @electric-sql/pglite\n` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (backend === 'sqlite') {
    log.info('createStorage:usingSQLite');
    try {
      const { SQLiteVectorliteStorage } = await import(
        './SQLiteVectorliteStorage.js'
      );
      // Extract SQLite-specific options
      const sqliteOptions =
        resolvedBackendOptions.backend === 'sqlite'
          ? {
              indexPath: resolvedBackendOptions.indexPath,
            }
          : undefined;
      return new SQLiteVectorliteStorage(
        config,
        vectorIndexConfig,
        embeddingDimensions,
        hybridStrategy,
        sqliteOptions,
      );
    } catch (error) {
      throw new Error(
        `SQLite backend requires better-sqlite3. Install it with: npm install better-sqlite3\n` +
          `Original error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // LibSQL is the default - always available (statically imported)
  log.info('createStorage:usingLibSQL');
  // Extract LibSQL-specific options from the resolved backend options
  const libsqlOptions: Partial<LibSQLBackendOptions> | undefined =
    resolvedBackendOptions.backend === 'libsql'
      ? {
          metric: resolvedBackendOptions.metric,
          compressNeighbors: resolvedBackendOptions.compressNeighbors,
          maxNeighbors: resolvedBackendOptions.maxNeighbors,
        }
      : undefined;
  return new LibSQLStorage(
    config,
    vectorIndexConfig,
    embeddingDimensions,
    hybridStrategy,
    libsqlOptions,
  );
}

/**
 * Check if a storage backend is available.
 * Under Bun runtime, only LibSQL is supported.
 *
 * @param backend - The backend to check ('sqlite', 'pglite', 'lancedb', or 'libsql')
 * @returns true if the backend dependencies are available
 */
export async function isBackendAvailable(
  backend: 'sqlite' | 'pglite' | 'lancedb' | 'libsql',
): Promise<boolean> {
  // Bun only supports LibSQL (native deps don't work)
  if (isRunningInBun() && backend !== 'libsql') {
    return false;
  }

  try {
    if (backend === 'lancedb') {
      await import('@lancedb/lancedb');
      return true;
    }

    if (backend === 'pglite') {
      await import('@electric-sql/pglite');
      return true;
    }

    if (backend === 'libsql') {
      await import('libsql');
      return true;
    }

    // SQLite backend
    await import('better-sqlite3');
    // vectorlite is optional - semantic search will be disabled without it
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if vectorlite extension is available for SQLite backend.
 *
 * @returns true if vectorlite can be loaded
 */
export async function isVectorliteAvailable(): Promise<boolean> {
  try {
    await import('vectorlite');
    return true;
  } catch {
    return false;
  }
}
