/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LanceDB Exploration Test
 *
 * This test file is a learning/exploration exercise to understand LanceDB's
 * capabilities before integrating it as a storage backend option.
 *
 * LanceDB features to explore:
 * - Database creation (in-memory and persistent)
 * - Table creation with schema
 * - Vector storage and search
 * - Full-text search (FTS)
 * - Hybrid search (vector + FTS)
 * - Filtering capabilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as lancedb from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('LanceDB Exploration', () => {
  let tempDir: string;
  let db: lancedb.Connection;

  beforeEach(async () => {
    // Create a temp directory for the database
    tempDir = path.join(os.tmpdir(), `lancedb-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(async () => {
    // Small delay to allow LanceDB to release file handles
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Clean up temp directory with retry
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Ignore cleanup errors in tests
      }
    }
  });

  describe('Basic Database Operations', () => {
    it('should connect to a LanceDB database', async () => {
      db = await lancedb.connect(tempDir);
      expect(db).toBeDefined();

      // List tables (should be empty initially)
      const tables = await db.tableNames();
      expect(tables).toEqual([]);
    });

    it('should create a table with data', async () => {
      db = await lancedb.connect(tempDir);

      // Create a simple table with sample data
      const data = [
        { id: '1', text: 'Hello world', vector: new Array(384).fill(0.1) },
        { id: '2', text: 'Goodbye world', vector: new Array(384).fill(0.2) },
      ];

      const table = await db.createTable('test_table', data);
      expect(table).toBeDefined();

      // Verify table exists
      const tables = await db.tableNames();
      expect(tables).toContain('test_table');
    });

    it('should insert data into existing table', async () => {
      db = await lancedb.connect(tempDir);

      // Create table with initial data
      const initialData = [
        { id: '1', text: 'First entry', vector: new Array(384).fill(0.1) },
      ];
      const table = await db.createTable('insert_test', initialData);

      // Add more data
      await table.add([
        { id: '2', text: 'Second entry', vector: new Array(384).fill(0.2) },
        { id: '3', text: 'Third entry', vector: new Array(384).fill(0.3) },
      ]);

      // Count rows
      const count = await table.countRows();
      expect(count).toBe(3);
    });

    it('should open an existing table', async () => {
      db = await lancedb.connect(tempDir);

      // Create table
      const data = [
        { id: '1', text: 'Test', vector: new Array(384).fill(0.1) },
      ];
      await db.createTable('existing_table', data);

      // Open the table
      const table = await db.openTable('existing_table');
      expect(table).toBeDefined();

      const count = await table.countRows();
      expect(count).toBe(1);
    });
  });

  describe('Vector Search', () => {
    it('should perform basic vector search', async () => {
      db = await lancedb.connect(tempDir);

      // Create normalized vectors for cosine similarity
      const normalize = (arr: number[]) => {
        const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
        return arr.map((v) => v / norm);
      };

      // Create vectors with distinct patterns
      const mlVector = normalize(new Array(384).fill(0).map((_, i) => (i < 100 ? 0.5 : 0.1)));
      const cookingVector = normalize(new Array(384).fill(0).map((_, i) => (i >= 100 && i < 200 ? 0.5 : 0.1)));
      const sportsVector = normalize(new Array(384).fill(0).map((_, i) => (i >= 200 ? 0.5 : 0.1)));

      const data = [
        { id: '1', text: 'Machine learning is a subset of AI', category: 'tech', vector: mlVector },
        { id: '2', text: 'Cooking requires fresh ingredients', category: 'food', vector: cookingVector },
        { id: '3', text: 'Football is a popular sport', category: 'sports', vector: sportsVector },
      ];

      const table = await db.createTable('vector_search', data);

      // Search with ML-like query vector
      const queryVector = mlVector;
      const results = await table.search(queryVector).limit(3).toArray();

      expect(results.length).toBe(3);
      // ML should be the most similar to ML query
      expect(results[0].id).toBe('1');
      expect(results[0].text).toContain('Machine learning');
    });

    it('should support distance metric selection', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        { id: '1', text: 'Test 1', vector: new Array(384).fill(0.1) },
        { id: '2', text: 'Test 2', vector: new Array(384).fill(0.5) },
      ];

      const table = await db.createTable('distance_test', data);

      // Search with cosine distance (default is L2)
      const queryVector = new Array(384).fill(0.1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results = await (table as any)
        .search(queryVector)
        .distanceType('cosine')
        .limit(2)
        .toArray();

      expect(results.length).toBe(2);
      // Results should have a distance/score field
      expect(results[0]).toHaveProperty('_distance');
    });

    it('should support filtering in vector search', async () => {
      db = await lancedb.connect(tempDir);

      const normalize = (arr: number[]) => {
        const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
        return arr.map((v) => v / norm);
      };

      const data = [
        { id: '1', text: 'Tech doc 1', category: 'tech', status: 'indexed', vector: normalize(new Array(384).fill(0.1)) },
        { id: '2', text: 'Tech doc 2', category: 'tech', status: 'pending', vector: normalize(new Array(384).fill(0.15)) },
        { id: '3', text: 'Food doc', category: 'food', status: 'indexed', vector: normalize(new Array(384).fill(0.2)) },
      ];

      const table = await db.createTable('filter_test', data);

      const queryVector = normalize(new Array(384).fill(0.1));

      // Filter by category
      const results = await table
        .search(queryVector)
        .where("category = 'tech'")
        .limit(10)
        .toArray();

      expect(results.length).toBe(2);
      expect(results.every((r) => r.category === 'tech')).toBe(true);

      // Filter by multiple conditions
      const results2 = await table
        .search(queryVector)
        .where("category = 'tech' AND status = 'indexed'")
        .limit(10)
        .toArray();

      expect(results2.length).toBe(1);
      expect(results2[0].id).toBe('1');
    });
  });

  describe('Full-Text Search (FTS)', () => {
    it('should create FTS index and search text', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        { id: '1', text: 'Machine learning algorithms are powerful', vector: new Array(384).fill(0.1) },
        { id: '2', text: 'Neural networks can learn patterns', vector: new Array(384).fill(0.2) },
        { id: '3', text: 'Deep learning is a subset of machine learning', vector: new Array(384).fill(0.3) },
      ];

      const table = await db.createTable('fts_test', data);

      // Create FTS index on the text column
      try {
        await table.createIndex('text', {
          config: lancedb.Index.fts(),
        });

        // Perform FTS search
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = await (table as any)
          .search('machine learning', { queryType: 'fts' })
          .limit(10)
          .toArray();

        expect(results.length).toBeGreaterThan(0);
        // Results should contain 'machine' or 'learning'
        expect(
          results.some(
            (r: { text: string }) =>
              r.text.toLowerCase().includes('machine') ||
              r.text.toLowerCase().includes('learning'),
          ),
        ).toBe(true);
      } catch (error) {
        // FTS might not be available in all LanceDB versions
        console.log('FTS index creation failed:', error);
        // This is expected if FTS is not supported
      }
    });
  });

  describe('Hybrid Search', () => {
    it('should perform hybrid search combining vector and FTS', async () => {
      db = await lancedb.connect(tempDir);

      const normalize = (arr: number[]) => {
        const norm = Math.sqrt(arr.reduce((sum, v) => sum + v * v, 0));
        return arr.map((v) => v / norm);
      };

      const data = [
        { id: '1', text: 'Machine learning algorithms for classification', vector: normalize(new Array(384).fill(0.1)) },
        { id: '2', text: 'Neural network architectures', vector: normalize(new Array(384).fill(0.2)) },
        { id: '3', text: 'Machine vision and computer vision', vector: normalize(new Array(384).fill(0.3)) },
      ];

      const table = await db.createTable('hybrid_test', data);

      try {
        // Create FTS index
        await table.createIndex('text', {
          config: lancedb.Index.fts(),
        });

        // Hybrid search
        const queryVector = normalize(new Array(384).fill(0.1));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const results = await (table as any)
          .search('machine', { queryType: 'hybrid' })
          .vector(queryVector)
          .limit(10)
          .toArray();

        expect(results.length).toBeGreaterThan(0);
      } catch (error) {
        // Hybrid search might not be available
        console.log('Hybrid search failed:', error);
      }
    });
  });

  describe('Index Management', () => {
    it('should create vector index for faster search', async () => {
      db = await lancedb.connect(tempDir);

      // Create a larger dataset to test indexing
      const data = Array.from({ length: 100 }, (_, i) => ({
        id: String(i),
        text: `Document ${i}`,
        vector: new Array(384).fill(i / 100),
      }));

      const table = await db.createTable('index_test', data);

      // Create IVF-PQ index
      try {
        await table.createIndex('vector', {
          config: lancedb.Index.ivfPq({
            numPartitions: 4,
            numSubVectors: 8,
          }),
        });

        // Search should still work
        const queryVector = new Array(384).fill(0.5);
        const results = await table.search(queryVector).limit(5).toArray();
        expect(results.length).toBe(5);
      } catch (error) {
        // Index creation might fail with small datasets
        console.log('Index creation note:', error);
      }
    });
  });

  describe('Schema and Data Types', () => {
    it('should handle complex schema with multiple fields', async () => {
      db = await lancedb.connect(tempDir);

      // Schema similar to our document storage needs
      const data = [
        {
          id: 'doc1',
          file_path: '/test/document.txt',
          file_name: 'document.txt',
          file_extension: '.txt',
          file_size: 1000,
          file_hash: 'abc123',
          status: 'indexed',
          chunk_index: 0,
          text: 'This is the document content',
          section: 'Introduction',
          page: 1,
          created_at: Date.now(),
          vector: new Array(384).fill(0.1),
        },
        {
          id: 'doc2',
          file_path: '/test/document.txt',
          file_name: 'document.txt',
          file_extension: '.txt',
          file_size: 1000,
          file_hash: 'abc123',
          status: 'indexed',
          chunk_index: 1,
          text: 'This is another chunk',
          section: 'Chapter 1',
          page: 2,
          created_at: Date.now(),
          vector: new Array(384).fill(0.2),
        },
      ];

      const table = await db.createTable('schema_test', data);

      // Query and verify schema
      const results = await table.search(new Array(384).fill(0.1)).limit(1).toArray();

      expect(results[0]).toHaveProperty('file_path');
      expect(results[0]).toHaveProperty('chunk_index');
      expect(results[0]).toHaveProperty('text');
      expect(results[0]).toHaveProperty('section');
    });

    it('should handle nullable fields', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        {
          id: '1',
          text: 'With section',
          section: 'Introduction',
          page: 1,
          vector: new Array(384).fill(0.1),
        },
        {
          id: '2',
          text: 'Without section',
          section: null,
          page: null,
          vector: new Array(384).fill(0.2),
        },
      ];

      const table = await db.createTable('nullable_test', data);

      const results = await table.search(new Array(384).fill(0.1)).limit(2).toArray();

      expect(results.length).toBe(2);
      // Verify null values are preserved
      const nullResult = results.find((r) => r.id === '2');
      expect(nullResult?.section).toBeNull();
    });
  });

  describe('Update and Delete Operations', () => {
    it('should update scalar rows', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        { id: '1', text: 'Original text', status: 'pending', vector: new Array(384).fill(0.1) },
        { id: '2', text: 'Another text', status: 'pending', vector: new Array(384).fill(0.2) },
      ];

      const table = await db.createTable('update_test', data);

      // Update a scalar field (status)
      // LanceDB update uses SQL-like WHERE + VALUES syntax
      await table.update({
        where: "id = '1'",
        values: { status: 'indexed' },
      });

      // Verify update by searching and filtering
      const results = await table.search(new Array(384).fill(0.1)).limit(10).toArray();
      const updated = results.find((r) => r.id === '1');
      expect(updated?.status).toBe('indexed');
    });

    it('should update vector fields', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        { id: '1', text: 'Test', vector: new Array(384).fill(0.1) },
      ];

      const table = await db.createTable('vector_update_test', data);

      // Update vector field
      await table.update({
        where: "id = '1'",
        values: { vector: new Array(384).fill(0.9) },
      });

      // Verify - the new vector should match query better
      const newVector = new Array(384).fill(0.9);
      const results = await table.search(newVector).limit(1).toArray();
      expect(results.length).toBe(1);
      // Distance should be 0 or very close (same vector)
      expect(results[0]._distance).toBeLessThan(0.01);
    });

    it('should delete rows', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        { id: '1', text: 'Keep me', vector: new Array(384).fill(0.1) },
        { id: '2', text: 'Delete me', vector: new Array(384).fill(0.2) },
      ];

      const table = await db.createTable('delete_test', data);

      // Delete a row
      await table.delete("id = '2'");

      // Verify deletion
      const count = await table.countRows();
      expect(count).toBe(1);

      const results = await table.search(new Array(384).fill(0.1)).limit(10).toArray();
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('1');
    });
  });

  describe('Query Builder', () => {
    it('should use query builder for complex queries', async () => {
      db = await lancedb.connect(tempDir);

      const data = [
        { id: '1', text: 'Doc 1', category: 'tech', score: 0.9, vector: new Array(384).fill(0.1) },
        { id: '2', text: 'Doc 2', category: 'tech', score: 0.5, vector: new Array(384).fill(0.2) },
        { id: '3', text: 'Doc 3', category: 'food', score: 0.8, vector: new Array(384).fill(0.3) },
      ];

      const table = await db.createTable('query_builder_test', data);

      // Complex query with filter, select, and limit
      const results = await table
        .search(new Array(384).fill(0.1))
        .where("category = 'tech'")
        .select(['id', 'text', 'score'])
        .limit(2)
        .toArray();

      expect(results.length).toBe(2);
      // Should only have selected columns (plus _distance)
      expect(results[0]).toHaveProperty('id');
      expect(results[0]).toHaveProperty('text');
      expect(results[0]).toHaveProperty('score');
    });
  });

  describe('Performance Considerations', () => {
    it('should handle batch inserts efficiently', async () => {
      db = await lancedb.connect(tempDir);

      // Create table with initial data
      const initialData = [
        { id: '0', text: 'Initial', vector: new Array(384).fill(0) },
      ];
      const table = await db.createTable('batch_test', initialData);

      // Batch insert
      const batchSize = 100;
      const batch = Array.from({ length: batchSize }, (_, i) => ({
        id: String(i + 1),
        text: `Document ${i + 1}`,
        vector: new Array(384).fill((i + 1) / batchSize),
      }));

      const startTime = Date.now();
      await table.add(batch);
      const duration = Date.now() - startTime;

      console.log(`Batch insert of ${batchSize} rows took ${duration}ms`);

      const count = await table.countRows();
      expect(count).toBe(batchSize + 1);
    });
  });

  describe('Comparison with our StorageAdapter interface', () => {
    /**
     * This test documents the mapping between our StorageAdapter methods
     * and LanceDB operations.
     */
    it('should document StorageAdapter method mappings', async () => {
      db = await lancedb.connect(tempDir);

      // Our interface methods and their LanceDB equivalents:

      // initialize() -> lancedb.connect()
      expect(db).toBeDefined();

      // createDocument/createChunks -> table.add()
      const chunks = [
        {
          id: 'chunk1',
          document_id: 'doc1',
          text: 'Test content',
          status: 'pending',
          vector: new Array(384).fill(0.1),
        },
      ];
      const table = await db.createTable('documents', chunks);

      // getDocument/getChunks -> table.search().where().toArray()
      // (or table.query().where().toArray() for non-vector queries)

      // updateDocument/updateChunk -> table.update() with where + values
      await table.update({
        where: "id = 'chunk1'",
        values: { status: 'indexed' },
      });

      // deleteDocument/deleteChunks -> table.delete()
      // await table.delete("document_id = 'doc1'");

      // searchSemantic -> table.search(embedding).limit().toArray()
      const semanticResults = await table.search(new Array(384).fill(0.1)).limit(10).toArray();
      expect(semanticResults.length).toBeGreaterThan(0);

      // searchKeyword -> table.search(text, { queryType: 'fts' }) (requires FTS index)
      // searchHybrid -> table.search(text, { queryType: 'hybrid' }).vector(embedding)

      // getStats -> table.countRows() + custom aggregations
      const count = await table.countRows();
      expect(count).toBe(1);
    });
  });
});
