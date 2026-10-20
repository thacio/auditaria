/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { isUserConfigFile } from './user-config-validation.js';
import { read, parseJson } from '../core/validation.js';

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
  deepMerge,
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

// These were accepted by the old file format but never affected SearchSystem.
// Keep old files readable without carrying ineffective settings into runtime.
const OBSOLETE_SETTINGS = new Set([
  'config.indexing.ocrEnabled',
  'config.indexing.ocrPriority',
  'config.indexing.childProcessMemoryThresholdMb',
  'config.chunking.strategy',
  'config.chunking.preserveSentences',
  'config.chunking.preserveParagraphs',
  'config.embeddings.queryPrefix',
  'config.embeddings.documentPrefix',
  'config.search.hybridStrategy',
]);

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
function stripMetadataKeys<T>(obj: T, prefix = '', removed: string[] = []): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const result = { ...obj };
  if (Array.isArray(obj)) {
    // Array values are settings, not metadata keys. Preserve their type and order.
    return obj;
  }
  for (const key in result) {
    const setting = prefix ? prefix + '.' + key : key;
    if (key.startsWith('_') || key.startsWith('$')) {
      delete result[key];
      continue;
    }
    if (OBSOLETE_SETTINGS.has(setting)) {
      removed.push(setting);
      delete result[key];
      continue;
    }
    result[key] = stripMetadataKeys(result[key], setting, removed);
  }
  return result;
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
    const parsed = read(
      parseJson(content),
      isUserConfigFile,
      'knowledge base configuration',
    );

    // Strip metadata keys like _docs, $schema, $version from nested config
    // but preserve $version at root level for compatibility checking
    const removed: string[] = [];
    const cleaned: UserConfigFile = {
      $version: parsed.$version,
      config: parsed.config
        ? stripMetadataKeys(parsed.config, 'config', removed)
        : undefined,
      backendOptions: parsed.backendOptions
        ? stripMetadataKeys(parsed.backendOptions)
        : undefined,
    };

    if (removed.length > 0) {
      console.warn(
        `[search] Remove obsolete settings from ${configPath}: ${removed.join(', ')}. ` +
          'Use config.ocr.enabled to control OCR; chunking, model prefixes and hybrid fusion are managed automatically.',
      );
    }

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
    ...config,
    $version: config.$version ?? USER_CONFIG_VERSION,
    config: config.config
      ? stripMetadataKeys(config.config, 'config')
      : undefined,
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
  overrides: DeepPartial<SearchSystemConfig> = {},
): MergedConfigResult {
  // Step 1: Load user config (or empty object)
  const userConfig = loadUserConfig(auditariaDir);

  // Step 2: Create base config by merging user config with defaults
  const preferences = deepMerge(userConfig?.config ?? {}, overrides);
  let config = createConfig(preferences);

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
    // Apply model defaults after selecting the authoritative model. Otherwise a
    // Gemma index reopened without its original user config inherits E5 defaults.
    config = createConfig(deepMerge(preferences, dbPartial));

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
      indexing: {
        includePaths: [],
        ignorePaths: [
          'node_modules',
          '.git',
          'dist',
          'build',
          '*.log',
          '.auditaria',
        ],
      },
      search: { defaultStrategy: 'hybrid', defaultLimit: 10 },
      ocr: { enabled: true, defaultLanguages: ['pt', 'en'] },
    },
  };
}
