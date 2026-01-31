/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StorageAdapter } from './types.js';
import type {
  DatabaseConfig,
  VectorIndexConfig,
  HybridSearchStrategy,
} from '../config.js';
import { PGliteStorage } from './PGliteStorage.js';
import { SQLiteVectorliteStorage } from './SQLiteVectorliteStorage.js';
import { LanceDBStorage } from './LanceDBStorage.js';
import { LibSQLStorage } from './LibSQLStorage.js';
import { createModuleLogger } from '../core/Logger.js';

const log = createModuleLogger('StorageFactory');

/**
 * Create a storage adapter based on the database configuration.
 *
 * @param config - Database configuration including backend type
 * @param vectorIndexConfig - Vector index configuration
 * @param embeddingDimensions - Embedding dimensions (default: 384)
 * @param hybridStrategy - Hybrid search strategy (default: 'application')
 * @returns A StorageAdapter instance (SQLiteVectorliteStorage or PGliteStorage)
 */
export function createStorage(
  config: DatabaseConfig,
  vectorIndexConfig?: VectorIndexConfig,
  embeddingDimensions?: number,
  hybridStrategy?: HybridSearchStrategy,
): StorageAdapter {
  const backend = config.backend ?? 'sqlite';

  log.info('createStorage', {
    backend,
    path: config.path,
    inMemory: config.inMemory,
    dimensions: embeddingDimensions,
  });

  if (backend === 'lancedb') {
    log.info('createStorage:usingLanceDB');
    return new LanceDBStorage(config, vectorIndexConfig, embeddingDimensions);
  }

  if (backend === 'pglite') {
    log.info('createStorage:usingPGlite');
    return new PGliteStorage(config, vectorIndexConfig, embeddingDimensions);
  }

  if (backend === 'libsql') {
    log.info('createStorage:usingLibSQL');
    return new LibSQLStorage(
      config,
      vectorIndexConfig,
      embeddingDimensions,
      hybridStrategy,
    );
  }

  // SQLite is the default
  log.info('createStorage:usingSQLite');
  return new SQLiteVectorliteStorage(
    config,
    vectorIndexConfig,
    embeddingDimensions,
    hybridStrategy,
  );
}

/**
 * Check if a storage backend is available.
 *
 * @param backend - The backend to check ('sqlite', 'pglite', 'lancedb', or 'libsql')
 * @returns true if the backend dependencies are available
 */
export async function isBackendAvailable(
  backend: 'sqlite' | 'pglite' | 'lancedb' | 'libsql',
): Promise<boolean> {
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
