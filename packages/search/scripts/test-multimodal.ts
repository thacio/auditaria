/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// Opt-in real-model smoke test. Run with --fixtures DIR --python EXECUTABLE.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { EmbeddingGemmaEmbedder } from '../src/embedders/EmbeddingGemmaEmbedder.js';
import { IndexingPipeline } from '../src/indexing/IndexingPipeline.js';
import { ParserRegistry } from '../src/parsers/ParserRegistry.js';
import { ChunkerRegistry } from '../src/chunkers/ChunkerRegistry.js';
import { PGliteStorage } from '../src/storage/PGliteStorage.js';
import { openSearchDatabase } from '../src/storage/pglite-runtime.js';

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    python: { type: 'string' },
    device: { type: 'string', default: 'auto' },
  },
});
if (!values.fixtures)
  throw new Error(
    '--fixtures is required (cats.jpg, jfk.wav, sea-turtle.mp4, audit-scan.pdf)',
  );
if (!['auto', 'cpu', 'cuda'].includes(values.device))
  throw new Error('--device must be auto, cpu, or cuda');
const root = resolve(values.fixtures);
const embedder = new EmbeddingGemmaEmbedder({
  pythonCommand: values.python,
  device: values.device as 'auto' | 'cpu' | 'cuda',
});
const storage = new PGliteStorage(
  { backend: 'pglite', path: '', inMemory: true, backupEnabled: false },
  undefined,
  768,
);
const pipeline = new IndexingPipeline(
  storage,
  new ParserRegistry(),
  new ChunkerRegistry(),
  embedder,
  { rootPath: root, autoStart: false },
);
const fixtures = [
  ['cats.jpg', 'cats sleeping on a couch'],
  ['jfk.wav', "a president's speech about serving your country"],
  ['sea-turtle.mp4', 'a turtle swimming in the ocean'],
  ['audit-scan.pdf', 'duplicate payments and audit findings'],
] as const;
try {
  const db = await openSearchDatabase();
  try {
    console.log(
      JSON.stringify({ database: (await db.query('select version()')).rows }),
    );
    try {
      await db.exec('create extension pg_vectorsearch');
      console.log(JSON.stringify({ pg_vectorsearch: 'available' }));
    } catch (error) {
      if ((error as { code?: string }).code !== '0A000') throw error;
      console.log(
        JSON.stringify({
          pg_vectorsearch: 'unavailable',
          message: (error as Error).message,
        }),
      );
    }
  } finally {
    await db.close();
  }
  await embedder.initialize();
  await storage.initialize();
  const ocrRequests: unknown[] = [];
  pipeline.on('document:ocr_needed', (event) => {
    ocrRequests.push(event);
  });
  const query = await embedder.embedQuery(
    'pagamentos duplicados em contratos públicos',
  );
  const texts = await embedder.embedBatchDocuments([
    'A auditoria identificou pagamentos duplicados ao fornecedor contratado.',
    'O gato dorme no sofá perto da janela.',
  ]);
  const scores = texts.map((vector) =>
    vector.reduce((sum, value, i) => sum + value * query[i], 0),
  );
  assert(scores[0] > scores[1]);
  console.log(JSON.stringify({ portugueseRetrieval: scores }));
  for (const [file] of fixtures) {
    const start = performance.now();
    const result = await pipeline.processFile(join(root, file));
    assert(result.success, result.error?.message);
    console.log(
      JSON.stringify({
        indexed: file,
        chunks: result.chunksCreated,
        ms: performance.now() - start,
      }),
    );
  }
  for (const [file, text] of fixtures) {
    const start = performance.now();
    const vector = await embedder.embedQuery(text);
    assert.equal(vector.length, 768);
    assert(vector.every(Number.isFinite));
    const results = await storage.searchSemantic(vector, {}, 4);
    assert.equal(results[0].fileName, file);
    if (file.endsWith('.pdf')) assert.equal(results[0].metadata.page, 1);
    console.log(
      JSON.stringify({
        query: text,
        top: results[0].fileName,
        score: results[0].score,
        reference: results[0].metadata,
        ms: performance.now() - start,
      }),
    );
  }
  assert.equal(ocrRequests.length, 0);
  console.log(
    JSON.stringify({
      passed: true,
      modalities: ['text', 'image', 'audio', 'video', 'scanned-pdf'],
      device: embedder.device,
    }),
  );
} finally {
  await pipeline.stop();
  await embedder.dispose();
  await storage.close();
}
