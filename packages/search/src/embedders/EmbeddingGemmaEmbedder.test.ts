/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfig } from '../config.js';
import { EmbeddingGemmaEmbedder } from './EmbeddingGemmaEmbedder.js';
import { PythonJsonlClient } from './PythonJsonlClient.js';

afterEach(() => vi.restoreAllMocks());

describe('EmbeddingGemma configuration', () => {
  it('selects FP32 and media discovery only for Gemma and respects explicit overrides', () => {
    const config = createConfig({
      embeddings: { model: 'google/embeddinggemma-2' },
    });
    expect(config.embeddings.dimensions).toBe(768);
    expect(config.embeddings.quantization).toBe('fp32');
    expect(config.embeddings.device).toBe('auto');
    expect(config.indexing.fileTypes).toContain('.mp4');
    expect(createConfig().indexing.fileTypes).not.toContain('.mp4');
    const explicit = createConfig({
      embeddings: { model: 'google/embeddinggemma-2', device: 'cpu' },
      indexing: { fileTypes: ['.pdf'] },
    });
    expect(explicit.embeddings.device).toBe('cpu');
    expect(explicit.indexing.fileTypes).toEqual(['.pdf']);
  });

  it('can use text-only Gemma without expanding discovery', () => {
    const config = createConfig({
      embeddings: { model: 'google/embeddinggemma-2', multimodal: false },
    });
    expect(config.indexing.fileTypes).not.toContain('.mp4');
  });
});

describe('EmbeddingGemma adapter', () => {
  async function initialized() {
    vi.spyOn(PythonJsonlClient.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(PythonJsonlClient.prototype, 'isRunning').mockReturnValue(true);
    const dispose = vi
      .spyOn(PythonJsonlClient.prototype, 'dispose')
      .mockResolvedValue();
    const request = vi
      .spyOn(PythonJsonlClient.prototype, 'request')
      .mockResolvedValue({ dimensions: 768, device: 'cpu' });
    const embedder = new EmbeddingGemmaEmbedder({ pythonCommand: 'python' });
    await embedder.initialize();
    return { embedder, request, dispose };
  }

  it('keeps query and document task prompts distinct', async () => {
    const { embedder, request } = await initialized();
    request.mockResolvedValue([Array<number>(768).fill(1 / Math.sqrt(768))]);
    await embedder.embedQuery('contract audit');
    expect(request).toHaveBeenLastCalledWith('embed', {
      texts: ['contract audit'],
      purpose: 'query',
    });
    await embedder.embedDocument('contract audit');
    expect(request).toHaveBeenLastCalledWith('embed', {
      texts: ['contract audit'],
      purpose: 'document',
    });
  });

  it('rejects NaN and mismatched vectors before storage', async () => {
    const { embedder, request } = await initialized();
    request.mockResolvedValue([[NaN, 1]]);
    await expect(embedder.embed('text')).rejects.toThrow('invalid embeddings');
    request.mockResolvedValue([]);
    await expect(
      embedder.embedMedia([{ kind: 'image', path: '/image.png' }]),
    ).rejects.toThrow('invalid embeddings');
  });

  it('cleans up a failed worker initialization', async () => {
    vi.spyOn(PythonJsonlClient.prototype, 'start').mockImplementation(() => {});
    vi.spyOn(PythonJsonlClient.prototype, 'request').mockRejectedValue(
      new Error('model missing'),
    );
    const dispose = vi
      .spyOn(PythonJsonlClient.prototype, 'dispose')
      .mockResolvedValue();
    const embedder = new EmbeddingGemmaEmbedder({ pythonCommand: 'python' });
    await expect(embedder.initialize()).rejects.toThrow('model missing');
    expect(dispose).toHaveBeenCalledOnce();
    expect(embedder.isReady()).toBe(false);
  });
});
