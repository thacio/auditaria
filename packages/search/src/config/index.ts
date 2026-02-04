/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Configuration module exports.
 *
 * This module consolidates all configuration-related exports for the search package.
 */

// Backend-specific options
export {
  type LibSQLBackendOptions,
  type PGLiteBackendOptions,
  type SQLiteBackendOptions,
  type LanceDBBackendOptions,
  type BackendOptions,
  type BackendOptionsMap,
  DEFAULT_LIBSQL_OPTIONS,
  DEFAULT_PGLITE_OPTIONS,
  DEFAULT_SQLITE_OPTIONS,
  DEFAULT_LANCEDB_OPTIONS,
  getDefaultBackendOptions,
  mergeBackendOptions,
  getTypedBackendOptions,
  validateBackendOptions,
} from './backend-options.js';

// User configuration management
export {
  USER_CONFIG_FILENAME,
  USER_CONFIG_VERSION,
  type UserConfigFile,
  type MergedConfigResult,
  getUserConfigPath,
  loadUserConfig,
  saveUserConfig,
  userConfigExists,
  dbMetadataToPartialConfig,
  loadMergedConfig,
  createSampleUserConfig,
} from './user-config.js';
