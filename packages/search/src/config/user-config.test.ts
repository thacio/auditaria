/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  USER_CONFIG_FILENAME,
  USER_CONFIG_VERSION,
  getUserConfigPath,
  loadUserConfig,
  saveUserConfig,
  userConfigExists,
  dbMetadataToPartialConfig,
  loadMergedConfig,
  createSampleUserConfig,
  type UserConfigFile,
} from './user-config.js';
import type { DatabaseMetadata } from '../storage/metadata.js';
import { DEFAULT_CONFIG } from '../config.js';

describe('user-config', () => {
  let testDir: string;
  let auditariaDir: string;

  beforeEach(() => {
    // Create a unique test directory for each test
    testDir = path.join(
      tmpdir(),
      `search-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    auditariaDir = path.join(testDir, '.auditaria');
    fs.mkdirSync(auditariaDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Constants
  // ==========================================================================

  describe('constants', () => {
    it('should export correct filename', () => {
      expect(USER_CONFIG_FILENAME).toBe('knowledge-base.json');
    });

    it('should export version', () => {
      expect(USER_CONFIG_VERSION).toBe('1.0.0');
    });
  });

  // ==========================================================================
  // getUserConfigPath
  // ==========================================================================

  describe('getUserConfigPath', () => {
    it('should return correct path', () => {
      const result = getUserConfigPath('/test/.auditaria');
      expect(result).toBe(path.join('/test/.auditaria', 'knowledge-base.json'));
    });
  });

  // ==========================================================================
  // userConfigExists
  // ==========================================================================

  describe('userConfigExists', () => {
    it('should return false when file does not exist', () => {
      expect(userConfigExists(auditariaDir)).toBe(false);
    });

    it('should return true when file exists', () => {
      const configPath = getUserConfigPath(auditariaDir);
      fs.writeFileSync(configPath, '{}');
      expect(userConfigExists(auditariaDir)).toBe(true);
    });
  });

  // ==========================================================================
  // loadUserConfig
  // ==========================================================================

  describe('loadUserConfig', () => {
    it('should return null when file does not exist', () => {
      const result = loadUserConfig(auditariaDir);
      expect(result).toBeNull();
    });

    it('should return null for invalid JSON', () => {
      const configPath = getUserConfigPath(auditariaDir);
      fs.writeFileSync(configPath, 'not valid json {');

      // Suppress console.warn during test
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = loadUserConfig(auditariaDir);
      warnSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('should return null for non-object JSON', () => {
      const configPath = getUserConfigPath(auditariaDir);
      fs.writeFileSync(configPath, '"string"');

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = loadUserConfig(auditariaDir);
      warnSpy.mockRestore();

      expect(result).toBeNull();
    });

    it('should load valid config file', () => {
      const configPath = getUserConfigPath(auditariaDir);
      const testConfig: UserConfigFile = {
        $version: '1.0.0',
        config: {
          database: {
            backend: 'pglite',
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const result = loadUserConfig(auditariaDir);
      expect(result).toEqual(testConfig);
    });

    it('should load config with backend options', () => {
      const configPath = getUserConfigPath(auditariaDir);
      const testConfig: UserConfigFile = {
        config: {
          database: { backend: 'libsql' },
        },
        backendOptions: {
          libsql: {
            maxNeighbors: 50,
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig));

      const result = loadUserConfig(auditariaDir);
      expect(result?.backendOptions?.libsql?.maxNeighbors).toBe(50);
    });

    it('should strip _docs and other metadata keys from config', () => {
      const configPath = getUserConfigPath(auditariaDir);
      // Config with _docs fields (like in knowledge-base.json template)
      const configWithDocs = {
        $schema: 'https://example.com/schema.json',
        $version: '1.0.0',
        _docs: {
          description: 'This should be stripped',
        },
        config: {
          database: {
            _docs: 'Database config docs - should be stripped',
            backend: 'pglite',
            path: '.auditaria/test.db',
          },
          indexing: {
            _docs: 'Indexing config docs',
            maxFileSize: 50000000,
          },
        },
        backendOptions: {
          _docs: 'Backend options docs',
          libsql: {
            _docs: 'LibSQL docs',
            maxNeighbors: 30,
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(configWithDocs));

      const result = loadUserConfig(auditariaDir);

      // $version should be preserved at root level
      expect(result?.$version).toBe('1.0.0');

      // _docs should be stripped from all levels
      expect((result as Record<string, unknown>)._docs).toBeUndefined();
      expect(
        (result?.config?.database as Record<string, unknown>)?._docs,
      ).toBeUndefined();
      expect(
        (result?.config?.indexing as Record<string, unknown>)?._docs,
      ).toBeUndefined();
      expect(
        (result?.backendOptions as Record<string, unknown>)?._docs,
      ).toBeUndefined();
      expect(
        (result?.backendOptions?.libsql as Record<string, unknown>)?._docs,
      ).toBeUndefined();

      // Actual config values should be preserved
      expect(result?.config?.database?.backend).toBe('pglite');
      expect(result?.config?.database?.path).toBe('.auditaria/test.db');
      expect(result?.config?.indexing?.maxFileSize).toBe(50000000);
      expect(result?.backendOptions?.libsql?.maxNeighbors).toBe(30);
    });
  });

  // ==========================================================================
  // saveUserConfig
  // ==========================================================================

  describe('saveUserConfig', () => {
    it('should create directory if it does not exist', () => {
      const newDir = path.join(testDir, 'new-dir', '.auditaria');
      const testConfig: UserConfigFile = { config: {} };

      saveUserConfig(newDir, testConfig);

      expect(fs.existsSync(newDir)).toBe(true);
    });

    it('should save config with version', () => {
      const testConfig: UserConfigFile = {
        config: {
          database: { backend: 'libsql' },
        },
      };

      saveUserConfig(auditariaDir, testConfig);

      const saved = loadUserConfig(auditariaDir);
      expect(saved?.$version).toBe(USER_CONFIG_VERSION);
      expect(saved?.config?.database?.backend).toBe('libsql');
    });

    it('should preserve existing version', () => {
      const testConfig: UserConfigFile = {
        $version: '0.9.0',
        config: {},
      };

      saveUserConfig(auditariaDir, testConfig);

      const saved = loadUserConfig(auditariaDir);
      expect(saved?.$version).toBe('0.9.0');
    });

    it('should format JSON with indentation', () => {
      const testConfig: UserConfigFile = { config: {} };
      saveUserConfig(auditariaDir, testConfig);

      const content = fs.readFileSync(getUserConfigPath(auditariaDir), 'utf-8');
      expect(content).toContain('\n'); // Has newlines
      expect(content).toContain('  '); // Has indentation
    });
  });

  // ==========================================================================
  // dbMetadataToPartialConfig
  // ==========================================================================

  describe('dbMetadataToPartialConfig', () => {
    it('should extract schema-defining fields', () => {
      const metadata: DatabaseMetadata = {
        version: '1.0.0',
        backend: 'libsql',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vectorIndex: {
          type: 'hnsw',
          useHalfVec: true,
          createIndex: true,
          hnswM: 32,
          hnswEfConstruction: 200,
        },
        embeddings: {
          model: 'Xenova/multilingual-e5-small',
          dimensions: 384,
          quantization: 'q8',
        },
      };

      const partial = dbMetadataToPartialConfig(metadata);

      expect(partial.database?.backend).toBe('libsql');
      expect(partial.embeddings?.model).toBe('Xenova/multilingual-e5-small');
      expect(partial.embeddings?.dimensions).toBe(384);
      expect(partial.vectorIndex?.type).toBe('hnsw');
      expect(partial.vectorIndex?.useHalfVec).toBe(true);
      expect(partial.vectorIndex?.hnswM).toBe(32);
    });

    it('should not include runtime preferences', () => {
      const metadata: DatabaseMetadata = {
        version: '1.0.0',
        backend: 'libsql',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vectorIndex: {
          type: 'hnsw',
          useHalfVec: true,
        },
        embeddings: {
          model: 'test-model',
          dimensions: 384,
          quantization: 'fp16', // This is stored but not extracted
        },
      };

      const partial = dbMetadataToPartialConfig(metadata);

      // quantization should NOT be extracted (it's runtime preference)
      expect(partial.embeddings?.quantization).toBeUndefined();
    });

    it('should handle minimal metadata', () => {
      const metadata: DatabaseMetadata = {
        version: '1.0.0',
        backend: 'pglite',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vectorIndex: {
          type: 'none',
          useHalfVec: false,
        },
        embeddings: {
          model: 'test',
          dimensions: 128,
          quantization: 'q8',
        },
      };

      const partial = dbMetadataToPartialConfig(metadata);

      expect(partial.database?.backend).toBe('pglite');
      expect(partial.vectorIndex?.type).toBe('none');
      expect(partial.vectorIndex?.hnswM).toBeUndefined();
    });
  });

  // ==========================================================================
  // loadMergedConfig
  // ==========================================================================

  describe('loadMergedConfig', () => {
    it('should return defaults when no user config exists', () => {
      const result = loadMergedConfig(auditariaDir);

      expect(result.config.database.backend).toBe(
        DEFAULT_CONFIG.database.backend,
      );
      expect(result.existingDatabase).toBe(false);
      expect(result.backendOptionsSource).toBe('default');
    });

    it('should merge user config with defaults', () => {
      const userConfig: UserConfigFile = {
        config: {
          database: { backupEnabled: false },
          search: { defaultLimit: 20 },
        },
      };
      saveUserConfig(auditariaDir, userConfig);

      const result = loadMergedConfig(auditariaDir);

      // User overrides
      expect(result.config.database.backupEnabled).toBe(false);
      expect(result.config.search.defaultLimit).toBe(20);

      // Defaults preserved
      expect(result.config.database.backend).toBe(
        DEFAULT_CONFIG.database.backend,
      );
      expect(result.config.chunking.maxChunkSize).toBe(
        DEFAULT_CONFIG.chunking.maxChunkSize,
      );
    });

    it('should use user backend options when provided', () => {
      const userConfig: UserConfigFile = {
        config: {
          database: { backend: 'libsql' },
        },
        backendOptions: {
          libsql: {
            maxNeighbors: 50,
            metric: 'l2',
          },
        },
      };
      saveUserConfig(auditariaDir, userConfig);

      const result = loadMergedConfig(auditariaDir);

      expect(result.backendOptionsSource).toBe('user');
      if (result.backendOptions.backend === 'libsql') {
        expect(result.backendOptions.maxNeighbors).toBe(50);
        expect(result.backendOptions.metric).toBe('l2');
        // Default preserved
        expect(result.backendOptions.compressNeighbors).toBe('float8');
      }
    });

    it('should validate final configuration', () => {
      const userConfig: UserConfigFile = {
        config: {
          search: { semanticWeight: 2.0 }, // Invalid: must be 0-1
        },
      };
      saveUserConfig(auditariaDir, userConfig);

      expect(() => loadMergedConfig(auditariaDir)).toThrow(/semanticWeight/);
    });
  });

  // ==========================================================================
  // createSampleUserConfig
  // ==========================================================================

  describe('createSampleUserConfig', () => {
    it('should create valid sample config', () => {
      const sample = createSampleUserConfig();

      expect(sample.$version).toBe(USER_CONFIG_VERSION);
      expect(sample.config).toBeDefined();
      expect(sample.backendOptions).toBeDefined();
    });

    it('should be saveable and loadable', () => {
      const sample = createSampleUserConfig();
      saveUserConfig(auditariaDir, sample);

      const loaded = loadUserConfig(auditariaDir);
      expect(loaded).toEqual(sample);
    });
  });

  // ==========================================================================
  // Priority Order Tests
  // ==========================================================================

  describe('priority order', () => {
    it('should prioritize db metadata over user config for schema fields', () => {
      // Create user config with different backend
      const userConfig: UserConfigFile = {
        config: {
          database: { backend: 'sqlite' },
          embeddings: { model: 'user-model', dimensions: 512 },
        },
      };
      saveUserConfig(auditariaDir, userConfig);

      // Create db with different backend
      const dbPath = path.join(auditariaDir, 'test.db');
      fs.mkdirSync(dbPath, { recursive: true });

      const dbMetadata: DatabaseMetadata = {
        version: '1.0.0',
        backend: 'libsql', // Different from user config
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vectorIndex: { type: 'hnsw', useHalfVec: true },
        embeddings: {
          model: 'db-model', // Different from user config
          dimensions: 384, // Different from user config
          quantization: 'q8',
        },
      };
      fs.writeFileSync(
        path.join(dbPath, 'db-config.json'),
        JSON.stringify(dbMetadata),
      );

      const result = loadMergedConfig(auditariaDir, dbPath);

      // DB metadata wins for schema fields
      expect(result.config.database.backend).toBe('libsql');
      expect(result.config.embeddings.model).toBe('db-model');
      expect(result.config.embeddings.dimensions).toBe(384);
      expect(result.existingDatabase).toBe(true);
    });

    it('should use user config for non-schema fields when db exists', () => {
      // Create user config
      const userConfig: UserConfigFile = {
        config: {
          search: { defaultLimit: 25 },
          indexing: { maxFileSize: 50000000 },
        },
      };
      saveUserConfig(auditariaDir, userConfig);

      // Create db
      const dbPath = path.join(auditariaDir, 'test.db');
      fs.mkdirSync(dbPath, { recursive: true });

      const dbMetadata: DatabaseMetadata = {
        version: '1.0.0',
        backend: 'libsql',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vectorIndex: { type: 'hnsw', useHalfVec: true },
        embeddings: { model: 'test', dimensions: 384, quantization: 'q8' },
      };
      fs.writeFileSync(
        path.join(dbPath, 'db-config.json'),
        JSON.stringify(dbMetadata),
      );

      const result = loadMergedConfig(auditariaDir, dbPath);

      // User config wins for non-schema fields
      expect(result.config.search.defaultLimit).toBe(25);
      expect(result.config.indexing.maxFileSize).toBe(50000000);
    });

    it('should use db backend options when available', () => {
      const userConfig: UserConfigFile = {
        backendOptions: {
          libsql: { maxNeighbors: 100 }, // User preference
        },
      };
      saveUserConfig(auditariaDir, userConfig);

      const dbPath = path.join(auditariaDir, 'test.db');
      fs.mkdirSync(dbPath, { recursive: true });

      const dbMetadata: DatabaseMetadata = {
        version: '1.0.0',
        backend: 'libsql',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vectorIndex: { type: 'hnsw', useHalfVec: true },
        embeddings: { model: 'test', dimensions: 384, quantization: 'q8' },
        backendOptions: {
          backend: 'libsql',
          metric: 'cosine',
          compressNeighbors: 'float8',
          maxNeighbors: 20, // DB stored value
        },
      };
      fs.writeFileSync(
        path.join(dbPath, 'db-config.json'),
        JSON.stringify(dbMetadata),
      );

      const result = loadMergedConfig(auditariaDir, dbPath);

      // DB backend options win
      expect(result.backendOptionsSource).toBe('database');
      if (result.backendOptions.backend === 'libsql') {
        expect(result.backendOptions.maxNeighbors).toBe(20); // Not 100
      }
    });
  });
});
