/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect } from 'vitest';
import {
  createConfig,
  validateConfig,
  DEFAULT_CONFIG,
  DEFAULT_DATABASE_CONFIG,
  DEFAULT_INDEXING_CONFIG,
  DEFAULT_CHUNKING_CONFIG,
  DEFAULT_EMBEDDINGS_CONFIG,
  DEFAULT_SEARCH_CONFIG,
  type SearchSystemConfig,
} from './config.js';

describe('Configuration', () => {
  describe('DEFAULT_CONFIG', () => {
    it('should have all required sections', () => {
      expect(DEFAULT_CONFIG).toHaveProperty('database');
      expect(DEFAULT_CONFIG).toHaveProperty('indexing');
      expect(DEFAULT_CONFIG).toHaveProperty('chunking');
      expect(DEFAULT_CONFIG).toHaveProperty('embeddings');
      expect(DEFAULT_CONFIG).toHaveProperty('search');
    });

    it('should have valid default database config', () => {
      expect(DEFAULT_DATABASE_CONFIG.path).toBe('.auditaria/search.db');
      expect(DEFAULT_DATABASE_CONFIG.inMemory).toBe(false);
    });

    it('should have valid default indexing config', () => {
      expect(DEFAULT_INDEXING_CONFIG.maxFileSize).toBeGreaterThan(0);
      expect(DEFAULT_INDEXING_CONFIG.fileTypes).toContain('.pdf');
      expect(DEFAULT_INDEXING_CONFIG.fileTypes).toContain('.docx');
      expect(DEFAULT_INDEXING_CONFIG.respectGitignore).toBe(true);
    });

    it('should have valid default chunking config', () => {
      expect(DEFAULT_CHUNKING_CONFIG.maxChunkSize).toBeGreaterThan(0);
      expect(DEFAULT_CHUNKING_CONFIG.chunkOverlap).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_CHUNKING_CONFIG.chunkOverlap).toBeLessThan(
        DEFAULT_CHUNKING_CONFIG.maxChunkSize,
      );
    });

    it('should have valid default embeddings config', () => {
      expect(DEFAULT_EMBEDDINGS_CONFIG.model).toBe(
        'Xenova/multilingual-e5-base',
      );
      expect(DEFAULT_EMBEDDINGS_CONFIG.dimensions).toBe(768);
      expect(DEFAULT_EMBEDDINGS_CONFIG.batchSize).toBeGreaterThan(0);
    });

    it('should have valid default search config', () => {
      expect(DEFAULT_SEARCH_CONFIG.defaultLimit).toBeGreaterThan(0);
      expect(DEFAULT_SEARCH_CONFIG.semanticWeight).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_SEARCH_CONFIG.semanticWeight).toBeLessThanOrEqual(1);
      expect(DEFAULT_SEARCH_CONFIG.keywordWeight).toBeGreaterThanOrEqual(0);
      expect(DEFAULT_SEARCH_CONFIG.keywordWeight).toBeLessThanOrEqual(1);
    });
  });

  describe('createConfig()', () => {
    it('should return default config when no partial provided', () => {
      const config = createConfig();
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should return default config when undefined provided', () => {
      const config = createConfig(undefined);
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('should merge partial database config', () => {
      const config = createConfig({
        database: { path: '/custom/path.db' },
      });

      expect(config.database.path).toBe('/custom/path.db');
      expect(config.database.inMemory).toBe(DEFAULT_DATABASE_CONFIG.inMemory);
    });

    it('should merge partial indexing config', () => {
      const config = createConfig({
        indexing: { maxFileSize: 100 * 1024 * 1024 },
      });

      expect(config.indexing.maxFileSize).toBe(100 * 1024 * 1024);
      expect(config.indexing.fileTypes).toEqual(
        DEFAULT_INDEXING_CONFIG.fileTypes,
      );
    });

    it('should merge partial chunking config', () => {
      const config = createConfig({
        chunking: { maxChunkSize: 2000 },
      });

      expect(config.chunking.maxChunkSize).toBe(2000);
      expect(config.chunking.chunkOverlap).toBe(
        DEFAULT_CHUNKING_CONFIG.chunkOverlap,
      );
    });

    it('should merge partial embeddings config', () => {
      const config = createConfig({
        embeddings: { model: 'Xenova/multilingual-e5-base' },
      });

      expect(config.embeddings.model).toBe('Xenova/multilingual-e5-base');
      expect(config.embeddings.dimensions).toBe(
        DEFAULT_EMBEDDINGS_CONFIG.dimensions,
      );
    });

    it('should merge partial search config', () => {
      const config = createConfig({
        search: { defaultLimit: 20 },
      });

      expect(config.search.defaultLimit).toBe(20);
      expect(config.search.semanticWeight).toBe(
        DEFAULT_SEARCH_CONFIG.semanticWeight,
      );
    });

    it('should merge multiple sections', () => {
      const config = createConfig({
        database: { inMemory: true },
        search: { defaultLimit: 50 },
      });

      expect(config.database.inMemory).toBe(true);
      expect(config.search.defaultLimit).toBe(50);
      expect(config.indexing).toEqual(DEFAULT_INDEXING_CONFIG);
    });

    it('should not mutate the input partial', () => {
      const partial = { database: { path: '/custom' } };
      const original = JSON.stringify(partial);

      createConfig(partial);

      expect(JSON.stringify(partial)).toBe(original);
    });

    it('should not mutate the default config', () => {
      const original = JSON.stringify(DEFAULT_CONFIG);

      createConfig({ database: { path: '/custom' } });

      expect(JSON.stringify(DEFAULT_CONFIG)).toBe(original);
    });
  });

  describe('validateConfig()', () => {
    it('should not throw for valid config', () => {
      expect(() => validateConfig(DEFAULT_CONFIG)).not.toThrow();
    });

    it('should throw for empty database path when not in-memory', () => {
      const config: SearchSystemConfig = {
        ...DEFAULT_CONFIG,
        database: { backend: 'sqlite', path: '', inMemory: false, backupEnabled: true },
      };

      expect(() => validateConfig(config)).toThrow(
        'Database path is required when not using in-memory mode',
      );
    });

    it('should not throw for empty database path when in-memory', () => {
      const config: SearchSystemConfig = {
        ...DEFAULT_CONFIG,
        database: { backend: 'sqlite', path: '', inMemory: true, backupEnabled: false },
      };

      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should throw for negative maxFileSize', () => {
      const config = createConfig({
        indexing: { maxFileSize: -1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'maxFileSize must be positive',
      );
    });

    it('should throw for zero maxFileSize', () => {
      const config = createConfig({
        indexing: { maxFileSize: 0 },
      });

      expect(() => validateConfig(config)).toThrow(
        'maxFileSize must be positive',
      );
    });

    it('should throw for negative maxChunkSize', () => {
      const config = createConfig({
        chunking: { maxChunkSize: -1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'maxChunkSize must be positive',
      );
    });

    it('should throw for zero maxChunkSize', () => {
      const config = createConfig({
        chunking: { maxChunkSize: 0 },
      });

      expect(() => validateConfig(config)).toThrow(
        'maxChunkSize must be positive',
      );
    });

    it('should throw for negative chunkOverlap', () => {
      const config = createConfig({
        chunking: { chunkOverlap: -1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'chunkOverlap cannot be negative',
      );
    });

    it('should throw when chunkOverlap >= maxChunkSize', () => {
      const config = createConfig({
        chunking: { maxChunkSize: 100, chunkOverlap: 100 },
      });

      expect(() => validateConfig(config)).toThrow(
        'chunkOverlap must be less than maxChunkSize',
      );
    });

    it('should throw for negative batchSize', () => {
      const config = createConfig({
        embeddings: { batchSize: -1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'batchSize must be positive',
      );
    });

    it('should throw for zero batchSize', () => {
      const config = createConfig({
        embeddings: { batchSize: 0 },
      });

      expect(() => validateConfig(config)).toThrow(
        'batchSize must be positive',
      );
    });

    it('should throw for negative dimensions', () => {
      const config = createConfig({
        embeddings: { dimensions: -1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'dimensions must be positive',
      );
    });

    it('should throw for zero dimensions', () => {
      const config = createConfig({
        embeddings: { dimensions: 0 },
      });

      expect(() => validateConfig(config)).toThrow(
        'dimensions must be positive',
      );
    });

    it('should throw for negative defaultLimit', () => {
      const config = createConfig({
        search: { defaultLimit: -1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'defaultLimit must be positive',
      );
    });

    it('should throw for zero defaultLimit', () => {
      const config = createConfig({
        search: { defaultLimit: 0 },
      });

      expect(() => validateConfig(config)).toThrow(
        'defaultLimit must be positive',
      );
    });

    it('should throw for semanticWeight < 0', () => {
      const config = createConfig({
        search: { semanticWeight: -0.1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'semanticWeight must be between 0 and 1',
      );
    });

    it('should throw for semanticWeight > 1', () => {
      const config = createConfig({
        search: { semanticWeight: 1.1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'semanticWeight must be between 0 and 1',
      );
    });

    it('should throw for keywordWeight < 0', () => {
      const config = createConfig({
        search: { keywordWeight: -0.1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'keywordWeight must be between 0 and 1',
      );
    });

    it('should throw for keywordWeight > 1', () => {
      const config = createConfig({
        search: { keywordWeight: 1.1 },
      });

      expect(() => validateConfig(config)).toThrow(
        'keywordWeight must be between 0 and 1',
      );
    });

    it('should throw for negative rrfK', () => {
      const config = createConfig({
        search: { rrfK: -1 },
      });

      expect(() => validateConfig(config)).toThrow('rrfK must be positive');
    });

    it('should throw for zero rrfK', () => {
      const config = createConfig({
        search: { rrfK: 0 },
      });

      expect(() => validateConfig(config)).toThrow('rrfK must be positive');
    });

    it('should allow boundary values', () => {
      const config = createConfig({
        search: {
          semanticWeight: 0,
          keywordWeight: 1,
        },
      });

      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
