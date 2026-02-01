/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  getMetadataPath,
  getDatabaseFilePath,
  ensureDatabaseDirectory,
  metadataExists,
  readMetadata,
  writeMetadata,
  createMetadata,
  deleteMetadata,
  updateMetadataStats,
  DATABASE_FILENAMES,
  METADATA_VERSION,
} from './metadata.js';

describe('metadata', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = path.join(os.tmpdir(), `metadata-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up the temporary directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getMetadataPath', () => {
    it('should return db-config.json path inside database directory', () => {
      const dbPath = '/some/database/path';
      const metaPath = getMetadataPath(dbPath);
      expect(metaPath).toBe(path.join(dbPath, 'db-config.json'));
    });
  });

  describe('getDatabaseFilePath', () => {
    it('should return correct path for sqlite backend', () => {
      const dbPath = '/some/database/path';
      const filePath = getDatabaseFilePath(dbPath, 'sqlite');
      expect(filePath).toBe(path.join(dbPath, 'data.sqlite'));
    });

    it('should return correct path for libsql backend', () => {
      const dbPath = '/some/database/path';
      const filePath = getDatabaseFilePath(dbPath, 'libsql');
      expect(filePath).toBe(path.join(dbPath, 'data.db'));
    });

    it('should return directory path for pglite backend', () => {
      const dbPath = '/some/database/path';
      const filePath = getDatabaseFilePath(dbPath, 'pglite');
      expect(filePath).toBe(dbPath);
    });

    it('should return directory path for lancedb backend', () => {
      const dbPath = '/some/database/path';
      const filePath = getDatabaseFilePath(dbPath, 'lancedb');
      expect(filePath).toBe(dbPath);
    });
  });

  describe('DATABASE_FILENAMES', () => {
    it('should have correct filenames for each backend', () => {
      expect(DATABASE_FILENAMES.sqlite).toBe('data.sqlite');
      expect(DATABASE_FILENAMES.libsql).toBe('data.db');
      expect(DATABASE_FILENAMES.pglite).toBe('');
      expect(DATABASE_FILENAMES.lancedb).toBe('');
    });
  });

  describe('ensureDatabaseDirectory', () => {
    it('should create directory if it does not exist', () => {
      const dbPath = path.join(testDir, 'new-db');
      expect(fs.existsSync(dbPath)).toBe(false);

      ensureDatabaseDirectory(dbPath);

      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.statSync(dbPath).isDirectory()).toBe(true);
    });

    it('should not throw if directory already exists', () => {
      const dbPath = path.join(testDir, 'existing-db');
      fs.mkdirSync(dbPath);

      expect(() => ensureDatabaseDirectory(dbPath)).not.toThrow();
    });
  });

  describe('createMetadata', () => {
    it('should create metadata with all required fields', () => {
      const metadata = createMetadata(
        'sqlite',
        {
          type: 'hnsw',
          useHalfVec: false,
          createIndex: true,
          hnswM: 32,
          hnswEfConstruction: 200,
        },
        {
          model: 'test-model',
          dimensions: 384,
          quantization: 'q8',
        },
      );

      expect(metadata.version).toBe(METADATA_VERSION);
      expect(metadata.backend).toBe('sqlite');
      expect(metadata.vectorIndex.type).toBe('hnsw');
      expect(metadata.vectorIndex.useHalfVec).toBe(false);
      expect(metadata.embeddings.model).toBe('test-model');
      expect(metadata.embeddings.dimensions).toBe(384);
      expect(metadata.createdAt).toBeDefined();
      expect(metadata.updatedAt).toBeDefined();
      expect(metadata._schema).toBeDefined();
    });

    it('should set correct backend for each storage type', () => {
      const backends = ['sqlite', 'libsql', 'pglite', 'lancedb'] as const;

      for (const backend of backends) {
        const metadata = createMetadata(
          backend,
          { type: 'hnsw', useHalfVec: false },
          { model: 'test', dimensions: 384, quantization: 'q8' },
        );
        expect(metadata.backend).toBe(backend);
      }
    });
  });

  describe('writeMetadata and readMetadata', () => {
    it('should write and read metadata correctly', () => {
      const dbPath = path.join(testDir, 'test-db');
      fs.mkdirSync(dbPath);

      const metadata = createMetadata(
        'sqlite',
        { type: 'hnsw', useHalfVec: true },
        { model: 'test-model', dimensions: 768, quantization: 'fp16' },
      );

      writeMetadata(dbPath, metadata);

      expect(fs.existsSync(getMetadataPath(dbPath))).toBe(true);

      const readBack = readMetadata(dbPath);

      expect(readBack).not.toBeNull();
      expect(readBack?.backend).toBe('sqlite');
      expect(readBack?.vectorIndex.type).toBe('hnsw');
      expect(readBack?.vectorIndex.useHalfVec).toBe(true);
      expect(readBack?.embeddings.model).toBe('test-model');
      expect(readBack?.embeddings.dimensions).toBe(768);
    });

    it('should create directory when writing metadata', () => {
      const dbPath = path.join(testDir, 'new-db-for-meta');

      const metadata = createMetadata(
        'libsql',
        { type: 'none', useHalfVec: false },
        { model: 'test', dimensions: 384, quantization: 'q8' },
      );

      writeMetadata(dbPath, metadata);

      expect(fs.existsSync(dbPath)).toBe(true);
      expect(fs.existsSync(getMetadataPath(dbPath))).toBe(true);
    });

    it('should return null when metadata file does not exist', () => {
      const dbPath = path.join(testDir, 'no-meta-db');
      fs.mkdirSync(dbPath);

      const result = readMetadata(dbPath);

      expect(result).toBeNull();
    });

    it('should add default backend for old metadata files without backend field', () => {
      const dbPath = path.join(testDir, 'old-meta-db');
      fs.mkdirSync(dbPath);

      // Write old-style metadata without backend field
      const oldMetadata = {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        vectorIndex: { type: 'hnsw', useHalfVec: false },
        embeddings: { model: 'test', dimensions: 384, quantization: 'q8' },
      };
      fs.writeFileSync(getMetadataPath(dbPath), JSON.stringify(oldMetadata, null, 2));

      const result = readMetadata(dbPath);

      expect(result).not.toBeNull();
      expect(result?.backend).toBe('pglite'); // Default for backwards compatibility
    });
  });

  describe('metadataExists', () => {
    it('should return true when metadata file exists', () => {
      const dbPath = path.join(testDir, 'has-meta-db');
      fs.mkdirSync(dbPath);

      const metadata = createMetadata(
        'sqlite',
        { type: 'hnsw', useHalfVec: false },
        { model: 'test', dimensions: 384, quantization: 'q8' },
      );
      writeMetadata(dbPath, metadata);

      expect(metadataExists(dbPath)).toBe(true);
    });

    it('should return false when metadata file does not exist', () => {
      const dbPath = path.join(testDir, 'no-meta-db');
      fs.mkdirSync(dbPath);

      expect(metadataExists(dbPath)).toBe(false);
    });
  });

  describe('deleteMetadata', () => {
    it('should delete metadata file', () => {
      const dbPath = path.join(testDir, 'delete-meta-db');
      fs.mkdirSync(dbPath);

      const metadata = createMetadata(
        'sqlite',
        { type: 'hnsw', useHalfVec: false },
        { model: 'test', dimensions: 384, quantization: 'q8' },
      );
      writeMetadata(dbPath, metadata);

      expect(metadataExists(dbPath)).toBe(true);

      deleteMetadata(dbPath);

      expect(metadataExists(dbPath)).toBe(false);
    });

    it('should not throw when metadata file does not exist', () => {
      const dbPath = path.join(testDir, 'no-meta-to-delete');
      fs.mkdirSync(dbPath);

      expect(() => deleteMetadata(dbPath)).not.toThrow();
    });
  });

  describe('updateMetadataStats', () => {
    it('should update stats in metadata file', () => {
      const dbPath = path.join(testDir, 'stats-db');
      fs.mkdirSync(dbPath);

      const metadata = createMetadata(
        'sqlite',
        { type: 'hnsw', useHalfVec: false },
        { model: 'test', dimensions: 384, quantization: 'q8' },
      );
      writeMetadata(dbPath, metadata);

      updateMetadataStats(dbPath, {
        documentCount: 100,
        chunkCount: 500,
      });

      const updated = readMetadata(dbPath);

      expect(updated?.stats?.documentCount).toBe(100);
      expect(updated?.stats?.chunkCount).toBe(500);
      expect(updated?.stats?.updatedAt).toBeDefined();
    });

    it('should not throw when metadata file does not exist', () => {
      const dbPath = path.join(testDir, 'no-meta-for-stats');
      fs.mkdirSync(dbPath);

      expect(() => updateMetadataStats(dbPath, { documentCount: 10 })).not.toThrow();
    });
  });

});
