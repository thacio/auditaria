/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/* eslint-disable no-console */

/**
 * User configuration management.
 *
 * This module handles the search.config.json file in .auditaria/ that allows
 * users to customize search system defaults. The priority order is:
 *
 * 1. db-config.json (database-specific, highest priority for schema fields)
 * 2. search.config.json (user preferences, this file)
 * 3. Code defaults (lowest priority)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type SearchSystemConfig,
  type DeepPartial,
  createConfig,
  validateConfig,
} from '../config.js';
import {
  type BackendOptionsMap,
  type BackendOptions,
  mergeBackendOptions,
} from './backend-options.js';
import { readMetadata, type DatabaseMetadata } from '../storage/metadata.js';

// ============================================================================
// Constants
// ============================================================================

/** Name of the user configuration file */
export const USER_CONFIG_FILENAME = 'knowledge-base.config.json';

/** Current version of the config file format */
export const USER_CONFIG_VERSION = '1.0.0';

// ============================================================================
// Types
// ============================================================================

/**
 * Structure of the search.config.json file.
 * All fields are optional - they override defaults when present.
 */
export interface UserConfigFile {
  /**
   * Config file format version (for future migrations).
   * Optional - defaults to current version.
   */
  $version?: string;

  /**
   * Main search system configuration overrides.
   * These merge with code defaults to form the runtime config.
   */
  config?: DeepPartial<SearchSystemConfig>;

  /**
   * Backend-specific options for NEW databases.
   * When creating a new database, the options for the selected backend
   * are written to db-config.json. Existing databases use their stored options.
   */
  backendOptions?: BackendOptionsMap;
}

/**
 * Result of loading and merging all configuration layers.
 */
export interface MergedConfigResult {
  /** Merged search system configuration */
  config: SearchSystemConfig;

  /** Backend options (merged from user config and defaults) */
  backendOptions: BackendOptions;

  /** Whether an existing database was detected */
  existingDatabase: boolean;

  /** Source of backend options: 'database' | 'user' | 'default' */
  backendOptionsSource: 'database' | 'user' | 'default';
}

// ============================================================================
// Load/Save Functions
// ============================================================================

/**
 * Get the path to the user configuration file.
 *
 * @param auditariaDir - Path to the .auditaria directory
 * @returns Full path to search.config.json
 */
export function getUserConfigPath(auditariaDir: string): string {
  return path.join(auditariaDir, USER_CONFIG_FILENAME);
}

/**
 * Remove documentation/metadata keys from config objects.
 * Keys starting with '_' or '$' are considered metadata and stripped.
 * This allows users to add comments like "_docs" in their JSON config.
 */
function stripMetadataKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(stripMetadataKeys) as T;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    // Skip keys starting with _ or $ (metadata/documentation)
    if (key.startsWith('_') || key.startsWith('$')) {
      continue;
    }
    result[key] = stripMetadataKeys(value);
  }
  return result as T;
}

/**
 * Load user configuration from .auditaria/knowledge-base.config.json.
 *
 * @param auditariaDir - Path to the .auditaria directory
 * @returns Parsed config file, or null if file doesn't exist or is invalid
 */
export function loadUserConfig(auditariaDir: string): UserConfigFile | null {
  const configPath = getUserConfigPath(auditariaDir);

  if (!fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as UserConfigFile;

    // Basic validation
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(
        `[search] Invalid user config (not an object): ${configPath}`,
      );
      return null;
    }

    // Strip metadata keys like _docs, $schema, $version from nested config
    // but preserve $version at root level for compatibility checking
    const cleaned: UserConfigFile = {
      $version: parsed.$version,
      config: parsed.config ? stripMetadataKeys(parsed.config) : undefined,
      backendOptions: parsed.backendOptions
        ? stripMetadataKeys(parsed.backendOptions)
        : undefined,
    };

    return cleaned;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn(`[search] Invalid JSON in user config: ${configPath}`);
    } else {
      console.warn(
        `[search] Failed to load user config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return null;
  }
}

/**
 * Save user configuration to .auditaria/search.config.json.
 *
 * @param auditariaDir - Path to the .auditaria directory
 * @param config - Configuration to save
 */
export function saveUserConfig(
  auditariaDir: string,
  config: UserConfigFile,
): void {
  const configPath = getUserConfigPath(auditariaDir);

  // Ensure directory exists
  if (!fs.existsSync(auditariaDir)) {
    fs.mkdirSync(auditariaDir, { recursive: true });
  }

  // Add version if not present
  const toSave: UserConfigFile = {
    $version: config.$version ?? USER_CONFIG_VERSION,
    ...config,
  };

  // Write with pretty formatting for human readability
  const content = JSON.stringify(toSave, null, 2);
  fs.writeFileSync(configPath, content, 'utf-8');
}

/**
 * Check if a user configuration file exists.
 *
 * @param auditariaDir - Path to the .auditaria directory
 * @returns True if the file exists
 */
export function userConfigExists(auditariaDir: string): boolean {
  return fs.existsSync(getUserConfigPath(auditariaDir));
}

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Convert database metadata to a partial SearchSystemConfig.
 *
 * Only extracts schema-defining fields that should override runtime config
 * when opening an existing database. Runtime preferences (like quantization,
 * batch size, etc.) are NOT extracted - they come from user config or defaults.
 *
 * @param metadata - Database metadata from db-config.json
 * @returns Partial config with schema-defining fields
 */
export function dbMetadataToPartialConfig(
  metadata: DatabaseMetadata,
): DeepPartial<SearchSystemConfig> {
  const partial: DeepPartial<SearchSystemConfig> = {
    database: {
      backend: metadata.backend,
    },
    embeddings: {
      // Model and dimensions define the schema - must match
      model: metadata.embeddings.model,
      dimensions: metadata.embeddings.dimensions,
      // Note: quantization is a runtime preference, not stored
    },
    vectorIndex: {
      type: metadata.vectorIndex.type,
      useHalfVec: metadata.vectorIndex.useHalfVec,
      createIndex: metadata.vectorIndex.createIndex,
    },
  };

  // Add optional vector index parameters if present
  if (metadata.vectorIndex.hnswM !== undefined) {
    partial.vectorIndex!.hnswM = metadata.vectorIndex.hnswM;
  }
  if (metadata.vectorIndex.hnswEfConstruction !== undefined) {
    partial.vectorIndex!.hnswEfConstruction =
      metadata.vectorIndex.hnswEfConstruction;
  }
  if (metadata.vectorIndex.ivfflatLists !== undefined) {
    partial.vectorIndex!.ivfflatLists = metadata.vectorIndex.ivfflatLists;
  }
  if (metadata.vectorIndex.ivfflatProbes !== undefined) {
    partial.vectorIndex!.ivfflatProbes = metadata.vectorIndex.ivfflatProbes;
  }

  return partial;
}

// ============================================================================
// Merge Functions
// ============================================================================

/**
 * Deep merge function that preserves the structure of nested objects.
 * Source values override target values at each level.
 *
 * @param target - Base object to merge into
 * @param source - Object with overrides
 * @returns New merged object (does not mutate inputs)
 */
function deepMerge<T extends object>(target: T, source: DeepPartial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== undefined &&
      typeof sourceValue === 'object' &&
      sourceValue !== null &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      targetValue !== null &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue,
        sourceValue as DeepPartial<T[keyof T] & object>,
      );
    } else if (sourceValue !== undefined) {
      result[key] = sourceValue as T[keyof T];
    }
  }

  return result;
}

/**
 * Load and merge all configuration layers.
 *
 * Priority order (highest to lowest):
 * 1. Database metadata (db-config.json) - for schema-defining fields only
 * 2. User configuration (search.config.json)
 * 3. Code defaults
 *
 * @param auditariaDir - Path to the .auditaria directory
 * @param dbPath - Path to the database directory (optional)
 * @returns Merged configuration with metadata about sources
 */
export function loadMergedConfig(
  auditariaDir: string,
  dbPath?: string,
): MergedConfigResult {
  // Step 1: Load user config (or empty object)
  const userConfig = loadUserConfig(auditariaDir);

  // Step 2: Create base config by merging user config with defaults
  let config = createConfig(userConfig?.config);

  // Step 3: Check for existing database metadata
  let existingDatabase = false;
  let backendOptionsSource: 'database' | 'user' | 'default' = 'default';
  let backendOptions: BackendOptions;

  const resolvedDbPath = dbPath ?? config.database.path;
  const metadata = resolvedDbPath ? readMetadata(resolvedDbPath) : null;

  if (metadata) {
    // Existing database found - use its schema-defining config
    existingDatabase = true;

    // Override config with database metadata (schema fields only)
    const dbPartial = dbMetadataToPartialConfig(metadata);
    config = deepMerge(config, dbPartial);

    // Use database's backend options if available
    if (metadata.backendOptions) {
      backendOptions = metadata.backendOptions;
      backendOptionsSource = 'database';
    } else {
      // Old database without backend options - use merged options
      backendOptions = mergeBackendOptions(
        config.database.backend,
        userConfig?.backendOptions,
      );
      backendOptionsSource = userConfig?.backendOptions?.[
        config.database.backend
      ]
        ? 'user'
        : 'default';
    }
  } else {
    // New database - merge user backend options with defaults
    backendOptions = mergeBackendOptions(
      config.database.backend,
      userConfig?.backendOptions,
    );
    backendOptionsSource = userConfig?.backendOptions?.[config.database.backend]
      ? 'user'
      : 'default';
  }

  // Step 4: Validate the final configuration
  validateConfig(config);

  return {
    config,
    backendOptions,
    existingDatabase,
    backendOptionsSource,
  };
}

/**
 * Create a sample user configuration file with comments.
 * Useful for users who want to customize their settings.
 *
 * @returns Sample config object (without actual comments since JSON doesn't support them)
 */
export function createSampleUserConfig(): UserConfigFile {
  return {
    $version: USER_CONFIG_VERSION,
    config: {
      database: {
        // backend: 'libsql',  // 'libsql', 'pglite', 'sqlite', 'lancedb'
        // path: '.auditaria/knowledge-base.db',
        // backupEnabled: true,
      },
      indexing: {
        // ignorePaths: ['node_modules', '.git', 'dist', 'build'],
        // maxFileSize: 104857600,  // 100MB
        // ocrEnabled: true,
        // supervisorStrategy: 'none',  // 'in-process', 'child-process', 'none'
      },
      chunking: {
        // strategy: 'recursive',  // 'recursive', 'semantic', 'fixed'
        // maxChunkSize: 1000,
        // chunkOverlap: 200,
      },
      embeddings: {
        // model: 'Xenova/multilingual-e5-large',
        // dimensions: 1024,
        // device: 'cpu',  // 'auto', 'cpu', 'dml', 'cuda'
        // quantization: 'q8',  // 'auto', 'fp32', 'fp16', 'q8', 'q4'
      },
      search: {
        // defaultLimit: 10,
        // defaultStrategy: 'hybrid',  // 'hybrid', 'semantic', 'keyword'
        // semanticWeight: 0.5,
        // keywordWeight: 0.5,
      },
      ocr: {
        // enabled: true,
        // autoDetectLanguage: true,
        // defaultLanguages: ['en'],
      },
      vectorIndex: {
        // type: 'hnsw',  // 'hnsw', 'ivfflat', 'none'
        // useHalfVec: true,
        // createIndex: true,
      },
    },
    backendOptions: {
      libsql: {
        // metric: 'cosine',  // 'cosine', 'l2', 'inner_product'
        // compressNeighbors: 'float8',  // 'float8', 'float1bit', null
        // maxNeighbors: 20,
      },
    },
  };
}
