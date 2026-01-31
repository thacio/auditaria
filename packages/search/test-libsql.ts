/**
 * Test script for LibSQLStorage functionality.
 * Run with: npx tsx test-libsql.ts
 */

import { LibSQLStorage } from './src/storage/LibSQLStorage.js';
import type { CreateDocumentInput, CreateChunkInput } from './src/storage/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_DB_PATH = './test-libsql-storage.db';

// Sample embeddings (384 dimensions, normalized)
function generateMockEmbedding(seed: number): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 384; i++) {
    // Generate deterministic pseudo-random values
    const value = Math.sin(seed * 1000 + i) * 0.5;
    embedding.push(value);
  }
  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map(v => v / magnitude);
}

async function cleanUp() {
  // Clean up any existing test database
  const filesToRemove = [
    TEST_DB_PATH,
    `${TEST_DB_PATH}-wal`,
    `${TEST_DB_PATH}-shm`,
  ];
  for (const file of filesToRemove) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`  Removed: ${file}`);
    }
  }
}

async function testInitialization(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Initialization ===');

  await storage.initialize();
  console.log('  ✓ Storage initialized');

  const status = storage.getStatus();
  console.log('  Status:', JSON.stringify(status, null, 2));

  if (!status.initialized) {
    throw new Error('Storage should be initialized');
  }
  console.log('  ✓ Initialization test passed');
}

async function testDocumentOperations(storage: LibSQLStorage): Promise<string> {
  console.log('\n=== Test: Document Operations ===');

  // Create document
  const docInput: CreateDocumentInput = {
    filePath: '/test/document1.txt',
    fileName: 'document1.txt',
    fileExtension: '.txt',
    fileSize: 1024,
    fileHash: 'abc123',
    mimeType: 'text/plain',
    title: 'Test Document 1',
    fileModifiedAt: new Date(),
  };

  const doc = await storage.createDocument(docInput);
  console.log(`  ✓ Created document: ${doc.id}`);

  // Get document
  const retrieved = await storage.getDocument(doc.id);
  if (!retrieved || retrieved.filePath !== docInput.filePath) {
    throw new Error('Document retrieval failed');
  }
  console.log('  ✓ Retrieved document by ID');

  // Get by path
  const byPath = await storage.getDocumentByPath('/test/document1.txt');
  if (!byPath || byPath.id !== doc.id) {
    throw new Error('Document retrieval by path failed');
  }
  console.log('  ✓ Retrieved document by path');

  // Update document
  const updated = await storage.updateDocument(doc.id, {
    status: 'indexed',
    indexedAt: new Date(),
  });
  if (updated.status !== 'indexed') {
    throw new Error('Document update failed');
  }
  console.log('  ✓ Updated document status');

  // Count documents
  const count = await storage.countDocuments();
  if (count !== 1) {
    throw new Error(`Expected 1 document, got ${count}`);
  }
  console.log(`  ✓ Document count: ${count}`);

  return doc.id;
}

async function testChunkOperations(storage: LibSQLStorage, documentId: string): Promise<void> {
  console.log('\n=== Test: Chunk Operations ===');

  // Create chunks
  const chunkInputs: CreateChunkInput[] = [
    {
      chunkIndex: 0,
      text: 'The quick brown fox jumps over the lazy dog. This is a test document about animals.',
      startOffset: 0,
      endOffset: 100,
    },
    {
      chunkIndex: 1,
      text: 'Machine learning and artificial intelligence are transforming how we process data.',
      startOffset: 100,
      endOffset: 200,
    },
    {
      chunkIndex: 2,
      text: 'Python and TypeScript are popular programming languages for building applications.',
      startOffset: 200,
      endOffset: 300,
    },
  ];

  const chunks = await storage.createChunks(documentId, chunkInputs);
  console.log(`  ✓ Created ${chunks.length} chunks`);

  // Get chunks
  const retrieved = await storage.getChunks(documentId);
  if (retrieved.length !== 3) {
    throw new Error(`Expected 3 chunks, got ${retrieved.length}`);
  }
  console.log('  ✓ Retrieved chunks');

  // Count chunks
  const count = await storage.countChunks();
  if (count !== 3) {
    throw new Error(`Expected 3 chunks, got ${count}`);
  }
  console.log(`  ✓ Chunk count: ${count}`);

  // Update embeddings
  const embeddingUpdates = chunks.map((chunk, i) => ({
    id: chunk.id,
    embedding: generateMockEmbedding(i),
  }));

  await storage.updateChunkEmbeddings(embeddingUpdates);
  console.log('  ✓ Updated chunk embeddings');
}

async function testKeywordSearch(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Keyword Search ===');

  // Search for "fox"
  const results1 = await storage.searchKeyword('fox', undefined, 10);
  console.log(`  Search "fox": ${results1.length} results`);
  if (results1.length > 0) {
    console.log(`    First result score: ${results1[0].score}`);
    console.log(`    Text preview: ${results1[0].chunkText.substring(0, 50)}...`);
  }

  // Search for "machine learning"
  const results2 = await storage.searchKeyword('machine learning', undefined, 10);
  console.log(`  Search "machine learning": ${results2.length} results`);

  // Search for "programming"
  const results3 = await storage.searchKeyword('programming', undefined, 10);
  console.log(`  Search "programming": ${results3.length} results`);

  // Search for non-existent term
  const results4 = await storage.searchKeyword('xyznonexistent', undefined, 10);
  console.log(`  Search "xyznonexistent": ${results4.length} results`);

  console.log('  ✓ Keyword search test passed');
}

async function testSemanticSearch(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Semantic Search ===');

  // Search with embedding similar to chunk 0 (animals)
  const queryEmbedding0 = generateMockEmbedding(0);
  const results1 = await storage.searchSemantic(queryEmbedding0, undefined, 10);
  console.log(`  Semantic search (similar to chunk 0): ${results1.length} results`);
  if (results1.length > 0) {
    console.log(`    First result score: ${results1[0].score.toFixed(4)}`);
    console.log(`    Text preview: ${results1[0].chunkText.substring(0, 50)}...`);
  }

  // Search with embedding similar to chunk 1 (ML/AI)
  const queryEmbedding1 = generateMockEmbedding(1);
  const results2 = await storage.searchSemantic(queryEmbedding1, undefined, 10);
  console.log(`  Semantic search (similar to chunk 1): ${results2.length} results`);
  if (results2.length > 0) {
    console.log(`    First result score: ${results2[0].score.toFixed(4)}`);
  }

  // Search with random embedding
  const randomEmbedding = generateMockEmbedding(999);
  const results3 = await storage.searchSemantic(randomEmbedding, undefined, 10);
  console.log(`  Semantic search (random embedding): ${results3.length} results`);

  console.log('  ✓ Semantic search test passed');
}

async function testHybridSearch(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Hybrid Search ===');

  // Hybrid search combining keyword "programming" with semantic
  const queryEmbedding = generateMockEmbedding(2);
  const results = await storage.searchHybrid(
    'programming',
    queryEmbedding,
    undefined,
    10,
    { semantic: 0.5, keyword: 0.5 },
    60,
  );

  console.log(`  Hybrid search "programming": ${results.length} results`);
  for (const result of results) {
    console.log(`    - [${result.matchType}] score: ${result.score.toFixed(4)} - ${result.chunkText.substring(0, 40)}...`);
  }

  console.log('  ✓ Hybrid search test passed');
}

async function testQueueOperations(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Queue Operations ===');

  // Enqueue items
  const item1 = await storage.enqueueItem({
    filePath: '/test/queue1.txt',
    fileSize: 100,
    priority: 'text',
  });
  console.log(`  ✓ Enqueued item 1: ${item1.id}`);

  const items = await storage.enqueueItems([
    { filePath: '/test/queue2.txt', fileSize: 200, priority: 'markup' },
    { filePath: '/test/queue3.txt', fileSize: 300, priority: 'pdf' },
  ]);
  console.log(`  ✓ Enqueued ${items.length} more items`);

  // Get queue status
  const status = await storage.getQueueStatus();
  console.log(`  Queue status: ${status.pending} pending, ${status.total} total`);

  // Dequeue item (should get text priority first)
  const dequeued = await storage.dequeueItem();
  if (!dequeued) {
    throw new Error('Dequeue failed');
  }
  console.log(`  ✓ Dequeued item: ${dequeued.filePath} (priority: ${dequeued.priority})`);

  // Update queue item
  await storage.updateQueueItem(dequeued.id, {
    status: 'completed',
    completedAt: new Date(),
  });
  console.log('  ✓ Updated queue item to completed');

  // Clear completed
  const cleared = await storage.clearCompletedQueueItems();
  console.log(`  ✓ Cleared ${cleared} completed items`);

  // Clear remaining
  await storage.clearQueue();
  const finalStatus = await storage.getQueueStatus();
  console.log(`  ✓ Cleared queue. Final count: ${finalStatus.total}`);
}

async function testTagOperations(storage: LibSQLStorage, documentId: string): Promise<void> {
  console.log('\n=== Test: Tag Operations ===');

  // Add tags
  await storage.addTags(documentId, ['important', 'test', 'sample']);
  console.log('  ✓ Added tags');

  // Get document tags
  const tags = await storage.getDocumentTags(documentId);
  console.log(`  Document tags: ${tags.join(', ')}`);
  if (tags.length !== 3) {
    throw new Error(`Expected 3 tags, got ${tags.length}`);
  }

  // Get all tags
  const allTags = await storage.getAllTags();
  console.log(`  All tags: ${allTags.map(t => `${t.tag}(${t.count})`).join(', ')}`);

  // Remove tag
  await storage.removeTags(documentId, ['test']);
  const remainingTags = await storage.getDocumentTags(documentId);
  console.log(`  After removal: ${remainingTags.join(', ')}`);
  if (remainingTags.length !== 2) {
    throw new Error(`Expected 2 tags after removal, got ${remainingTags.length}`);
  }

  console.log('  ✓ Tag operations test passed');
}

async function testStatsAndConfig(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Stats and Config ===');

  // Get stats
  const stats = await storage.getStats();
  console.log('  Stats:', JSON.stringify(stats, null, 2));

  // Set and get config
  await storage.setConfigValue('test_key', { foo: 'bar', num: 42 });
  const configValue = await storage.getConfigValue<{ foo: string; num: number }>('test_key');
  console.log('  Config value:', configValue);
  if (!configValue || configValue.foo !== 'bar') {
    throw new Error('Config storage failed');
  }

  console.log('  ✓ Stats and config test passed');
}

async function testReconnect(storage: LibSQLStorage): Promise<void> {
  console.log('\n=== Test: Reconnect ===');

  // Get count before reconnect
  const countBefore = await storage.countChunks();
  console.log(`  Chunks before reconnect: ${countBefore}`);

  // Reconnect
  await storage.reconnect();
  console.log('  ✓ Reconnected');

  // Get count after reconnect
  const countAfter = await storage.countChunks();
  console.log(`  Chunks after reconnect: ${countAfter}`);

  if (countBefore !== countAfter) {
    throw new Error(`Data lost after reconnect: ${countBefore} -> ${countAfter}`);
  }

  // Test search still works after reconnect
  const results = await storage.searchKeyword('fox', undefined, 10);
  console.log(`  Search after reconnect: ${results.length} results`);

  console.log('  ✓ Reconnect test passed');
}

async function main() {
  console.log('========================================');
  console.log('LibSQL Storage Test Suite');
  console.log('========================================');

  // Clean up any previous test database
  console.log('\nCleaning up...');
  await cleanUp();

  const storage = new LibSQLStorage(
    {
      backend: 'libsql',
      path: TEST_DB_PATH,
      inMemory: false,
      backupEnabled: false,
    },
    {
      type: 'hnsw',
      createIndex: true,
      useHalfVec: false,
    },
    384, // dimensions
    'application', // hybrid strategy
  );

  try {
    await testInitialization(storage);
    const documentId = await testDocumentOperations(storage);
    await testChunkOperations(storage, documentId);
    await testKeywordSearch(storage);
    await testSemanticSearch(storage);
    await testHybridSearch(storage);
    await testQueueOperations(storage);
    await testTagOperations(storage, documentId);
    await testStatsAndConfig(storage);
    await testReconnect(storage);

    console.log('\n========================================');
    console.log('All tests passed! ✓');
    console.log('========================================\n');
  } catch (error) {
    console.error('\n========================================');
    console.error('Test failed! ✗');
    console.error('========================================');
    console.error(error);
    process.exit(1);
  } finally {
    // Close storage
    await storage.close();
    console.log('Storage closed.');

    // Clean up test database
    console.log('Cleaning up test files...');
    await cleanUp();
  }
}

main().catch(console.error);
