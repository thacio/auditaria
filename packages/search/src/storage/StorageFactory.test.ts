/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createStorage, detectBackendFromMetadata } from './StorageFactory.js';
import { writeMetadata, createMetadata, metadataExists } from './metadata.js';

describe('StorageFactory', () => {
  let testDir: string;

  beforeEach(() => {
    // Create a temporary directory for each test
    testDir = path.join(os.tmpdir(), `storage-factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Small delay to allow file handles to be released (Windows issue)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clean up the temporary directory with retries for Windows file locking
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors on Windows due to file locking
      }
    }
  });

  describe('detectBackendFromMetadata', () => {
    it('should return null when no metadata exists', () => {
      const dbPath = path.join(testDir, 'no-meta');
      fs.mkdirSync(dbPath);

      const result = detectBackendFromMetadata(dbPath);

      expect(result).toBeNull();
    });

    it('should return backend from metadata when it exists', () => {
      const dbPath = path.join(testDir, 'has-meta');
      fs.mkdirSync(dbPath);

      const metadata = createMetadata(
        'libsql',
        { type: 'hnsw', useHalfVec: false },
        { model: 'test', dimensions: 384, quantization: 'q8' },
      );
      writeMetadata(dbPath, metadata);

      const result = detectBackendFromMetadata(dbPath);

      expect(result).toBe('libsql');
    });

    it('should detect each backend type correctly', () => {
      const backends = ['sqlite', 'libsql', 'pglite', 'lancedb'] as const;

      for (const backend of backends) {
        const dbPath = path.join(testDir, `backend-${backend}`);
        fs.mkdirSync(dbPath);

        const metadata = createMetadata(
          backend,
          { type: 'hnsw', useHalfVec: false },
          { model: 'test', dimensions: 384, quantization: 'q8' },
        );
        writeMetadata(dbPath, metadata);

        const result = detectBackendFromMetadata(dbPath);

        expect(result).toBe(backend);
      }
    });
  });

  describe('createStorage', () => {
    it('should use in-memory storage without checking metadata', () => {
      const storage = createStorage({
        backend: 'sqlite',
        path: '',
        inMemory: true,
        backupEnabled: false,
      });

      expect(storage).toBeDefined();
      expect(storage.constructor.name).toBe('SQLiteVectorliteStorage');
    });

    it('should use config backend when no metadata exists', () => {
      const dbPath = path.join(testDir, 'new-sqlite-db');

      const storage = createStorage({
        backend: 'sqlite',
        path: dbPath,
        inMemory: false,
        backupEnabled: false,
      });

      expect(storage).toBeDefined();
      expect(storage.constructor.name).toBe('SQLiteVectorliteStorage');
    });

    it('should use existing metadata backend over config backend', () => {
      const dbPath = path.join(testDir, 'existing-libsql-db');
      fs.mkdirSync(dbPath);

      // Create metadata indicating libsql backend
      const metadata = createMetadata(
        'libsql',
        { type: 'hnsw', useHalfVec: false },
        { model: 'test', dimensions: 384, quantization: 'q8' },
      );
      writeMetadata(dbPath, metadata);

      // Try to open with sqlite config - should use libsql from metadata
      const storage = createStorage({
        backend: 'sqlite', // Config says sqlite
        path: dbPath,
        inMemory: false,
        backupEnabled: false,
      });

      expect(storage).toBeDefined();
      expect(storage.constructor.name).toBe('LibSQLStorage'); // But metadata wins
    });

    it('should create correct storage for each backend type', () => {
      const backendToClass = {
        sqlite: 'SQLiteVectorliteStorage',
        libsql: 'LibSQLStorage',
        pglite: 'PGliteStorage',
        lancedb: 'LanceDBStorage',
      } as const;

      for (const [backend, className] of Object.entries(backendToClass)) {
        const storage = createStorage({
          backend: backend as 'sqlite' | 'libsql' | 'pglite' | 'lancedb',
          path: '',
          inMemory: true,
          backupEnabled: false,
        });

        expect(storage.constructor.name).toBe(className);
      }
    });
  });

  describe('storage initialization creates metadata', () => {
    it('should create metadata when initializing SQLite storage', async () => {
      const dbPath = path.join(testDir, 'sqlite-init');

      const storage = createStorage({
        backend: 'sqlite',
        path: dbPath,
        inMemory: false,
        backupEnabled: false,
      });

      expect(metadataExists(dbPath)).toBe(false);

      await storage.initialize();

      expect(metadataExists(dbPath)).toBe(true);
      expect(detectBackendFromMetadata(dbPath)).toBe('sqlite');

      await storage.close();
    });

    it('should create metadata when initializing LibSQL storage', async () => {
      const dbPath = path.join(testDir, 'libsql-init');

      const storage = createStorage({
        backend: 'libsql',
        path: dbPath,
        inMemory: false,
        backupEnabled: false,
      });

      expect(metadataExists(dbPath)).toBe(false);

      await storage.initialize();

      expect(metadataExists(dbPath)).toBe(true);
      expect(detectBackendFromMetadata(dbPath)).toBe('libsql');

      await storage.close();
    });

    it('should not create metadata for in-memory storage', async () => {
      const storage = createStorage({
        backend: 'sqlite',
        path: '',
        inMemory: true,
        backupEnabled: false,
      });

      await storage.initialize();

      // In-memory storage has no path, so no metadata
      expect(metadataExists('')).toBe(false);

      await storage.close();
    });

    it('should create metadata when initializing LanceDB storage', async () => {
      const dbPath = path.join(testDir, 'lancedb-init');

      const storage = createStorage({
        backend: 'lancedb',
        path: dbPath,
        inMemory: false,
        backupEnabled: false,
      });

      expect(metadataExists(dbPath)).toBe(false);

      await storage.initialize();

      expect(metadataExists(dbPath)).toBe(true);
      expect(detectBackendFromMetadata(dbPath)).toBe('lancedb');

      await storage.close();
    });
  });
});
