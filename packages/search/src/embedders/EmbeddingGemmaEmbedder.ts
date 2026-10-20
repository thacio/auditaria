/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { gemmaWorkerPath } from './gemma-worker-path.js';
import type {
  TextEmbedder,
  ProgressCallback,
  EmbeddingResult,
} from './types.js';
import { PythonJsonlClient } from './PythonJsonlClient.js';
import { getPythonCommand } from './python-detection.js';
import { isMediaFile, type MediaDocument, type MediaSource } from './media.js';

export const EMBEDDING_GEMMA_MODEL = 'google/embeddinggemma-2';

export interface EmbeddingGemmaConfig {
  device?: 'auto' | 'cpu' | 'cuda';
  pythonCommand?: string;
  cacheDir?: string;
  batchSize?: number;
  multimodal?: boolean;
}

/** Local multimodal inference. Indexing and queries share one model process. */
export class EmbeddingGemmaEmbedder implements TextEmbedder {
  readonly name = 'embeddinggemma-2';
  readonly modelId = EMBEDDING_GEMMA_MODEL;
  readonly dimensions = 768;
  readonly maxTokens = 8192;
  readonly isMultilingual = true;
  readonly priority = 100;
  device: 'cpu' | 'cuda' = 'cpu';
  private readonly client = new PythonJsonlClient();
  private ready = false;
  private initializing?: Promise<void>;

  constructor(private readonly config: EmbeddingGemmaConfig = {}) {}

  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.isReady()) return;
    if (!this.initializing) this.initializing = this.load(onProgress);
    try {
      await this.initializing;
    } finally {
      this.initializing = undefined;
    }
  }

  private async load(onProgress?: ProgressCallback): Promise<void> {
    const command = this.config.pythonCommand ?? (await getPythonCommand());
    if (!command)
      throw new Error(
        'EmbeddingGemma 2 requires Python. Install python/requirements-gemma.txt.',
      );
    onProgress?.({
      stage: 'load',
      progress: 0,
      message: 'Loading EmbeddingGemma 2...',
    });
    try {
      this.client.start(command, gemmaWorkerPath());
      const result = await this.client.request<{
        dimensions: number;
        device: 'cpu' | 'cuda';
      }>(
        'init',
        {
          model: this.modelId,
          device: this.config.device ?? 'auto',
          cache_dir: this.config.cacheDir,
          batch_size: this.config.batchSize ?? 8,
          multimodal: this.config.multimodal ?? true,
        },
        600_000,
      );
      if (result.dimensions !== this.dimensions)
        throw new Error('EmbeddingGemma output dimension mismatch');
      this.device = result.device;
      this.ready = true;
      onProgress?.({
        stage: 'ready',
        progress: 100,
        message: 'EmbeddingGemma 2 ready',
      });
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  isReady(): boolean {
    return this.ready && this.client.isRunning();
  }

  async embed(text: string): Promise<number[]> {
    return (await this.encode([text], 'raw'))[0];
  }
  embedBatch(texts: string[]): Promise<number[][]> {
    return this.encode(texts, 'raw');
  }
  async embedQuery(text: string): Promise<number[]> {
    return (await this.encode([text], 'query'))[0];
  }
  async embedDocument(text: string): Promise<number[]> {
    return (await this.embedBatchDocuments([text]))[0];
  }
  embedBatchDocuments(texts: string[]): Promise<number[][]> {
    return this.encode(texts, 'document');
  }

  async embedWithDetails(text: string): Promise<EmbeddingResult> {
    return {
      embedding: await this.embed(text),
      model: this.modelId,
      dimensions: this.dimensions,
    };
  }

  canEmbedMedia(path: string): boolean {
    return this.config.multimodal !== false && isMediaFile(path);
  }

  async prepareMedia(path: string): Promise<MediaDocument | undefined> {
    if (!this.canEmbedMedia(path)) return undefined;
    this.assertReady();
    return this.client.request<MediaDocument>('prepare_media', { path });
  }

  async embedMedia(sources: MediaSource[]): Promise<number[][]> {
    this.assertReady();
    const vectors = await this.client.request<number[][]>('embed_media', {
      sources,
    });
    return this.validate(vectors, sources.length);
  }

  async dispose(): Promise<void> {
    this.ready = false;
    await this.client.dispose();
  }

  private async encode(texts: string[], purpose: string): Promise<number[][]> {
    this.assertReady();
    if (texts.length === 0) return [];
    return this.validate(
      await this.client.request<number[][]>('embed', { texts, purpose }),
      texts.length,
    );
  }

  private assertReady(): void {
    if (!this.isReady()) throw new Error('EmbeddingGemma is not initialized');
  }

  private validate(vectors: number[][], count: number): number[][] {
    if (
      vectors.length !== count ||
      vectors.some(
        (v) =>
          v.length !== this.dimensions ||
          v.some((value) => !Number.isFinite(value)) ||
          !v.some((value) => value !== 0),
      )
    ) {
      throw new Error('EmbeddingGemma returned invalid embeddings');
    }
    return vectors;
  }
}
