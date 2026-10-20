/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { SearchSystem } from './SearchSystem.js';
import { createEmbedders, MockEmbedder } from '../embedders/index.js';
import type { MediaDocument } from '../embedders/media.js';

const { enqueue } = vi.hoisted(() => ({ enqueue: vi.fn(async () => {}) }));
vi.mock('../ocr/index.js', () => ({
  isTesseractAvailable: async () => true,
  createOcrRegistryAsync: async () => ({ disposeAll: async () => {} }),
  createOcrQueueManager: () => ({
    on: () => {},
    enqueue,
    stop: async () => {},
    getStatus: () => ({ pendingJobs: 0 }),
  }),
}));
vi.mock('../embedders/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../embedders/index.js')>()),
  createEmbedders: vi.fn(),
}));

it('keeps automatic OCR out of the full Gemma indexing flow even when OCR is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auditaria-gemma-system-'));
  let system: SearchSystem | undefined;
  try {
    const imagePath = join(root, 'photo.png');
    await writeFile(
      imagePath,
      'image decoding is exercised in the Python and real-model tests',
    );
    const embedder = new MockEmbedder(768);
    await embedder.initialize();
    Object.assign(embedder, {
      canEmbedMedia: (path: string) => path.endsWith('.png'),
      prepareMedia: async (): Promise<MediaDocument> => ({
        chunks: [
          {
            index: 0,
            text: '[Image: photo.png]',
            startOffset: 0,
            endOffset: 18,
            metadata: {},
            source: { kind: 'image', path: imagePath },
          },
        ],
      }),
      embedMedia: async () => [[1, ...Array<number>(767).fill(0)]],
    });
    vi.mocked(createEmbedders).mockResolvedValue({
      indexingEmbedder: embedder,
      searchEmbedder: embedder,
      resolvedConfig: {
        device: 'cpu',
        quantization: 'fp32',
        gpuDetected: false,
        gpuUsedForIndexing: false,
      },
    });
    system = await SearchSystem.initialize({
      rootPath: root,
      config: {
        embeddings: { model: 'google/embeddinggemma-2' },
        database: { inMemory: true, backupEnabled: false },
        indexing: { useChildProcess: false },
        ocr: { enabled: true },
      },
    });
    const result = await system.indexAll({ useChildProcess: false });
    expect(result.indexed).toBe(1);
    expect(result.failed).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(createEmbedders).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'google/embeddinggemma-2',
        quantization: 'fp32',
      }),
      expect.any(Function),
    );
  } finally {
    await system?.close();
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
}, 30_000);
