/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// Google Gemini embedding API integration.
// Delegates to a generic EmbedFunction, keeping search independent of core.
// The function is wired in search-service.ts via ContentGenerator.

import type { TextEmbedder, EmbeddingResult, ProgressCallback } from './types.js';
import { getModelDimensions } from './model-dimensions.js';
import { createModuleLogger } from '../core/Logger.js';

const log = createModuleLogger('GeminiEmbedder');

// ============================================================================
// Types
// ============================================================================

/**
 * Generic embedding function type.
 * Accepts an array of texts, a model name, and optional output dimensions.
 * This decouples GeminiEmbedder from core's ContentGenerator.
 */
export type EmbedFunction = (
  texts: string[],
  model: string,
  outputDimensionality?: number,
) => Promise<number[][]>;

/**
 * Configuration for GeminiEmbedder.
 */
export interface GeminiEmbedderConfig {
  /** The embedding function to delegate to */
  embedFunction: EmbedFunction;
  /** Google embedding model ID. Default: 'gemini-embedding-001' */
  model?: string;
  /** Embedding dimensions. Auto-derived from model if known. */
  dimensions?: number;
  /** Max texts per API request. Default: 100 */
  maxBatchSize?: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL = 'gemini-embedding-001';
const DEFAULT_MAX_BATCH_SIZE = 100;
const DEFAULT_MAX_TOKENS = 2048;

// Rate limiting: conservative limit to avoid quota issues
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 50;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

// ============================================================================
// GeminiEmbedder
// ============================================================================

/**
 * Embedder that delegates to Google's Gemini embedding API via a generic function.
 * Handles batching, error handling, and streaming. No query/document prefix
 * needed — Gemini handles this distinction internally.
 */
export class GeminiEmbedder implements TextEmbedder {
  readonly name = 'gemini';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxTokens = DEFAULT_MAX_TOKENS;
  readonly isMultilingual = true;
  readonly priority = 200; // Higher than local embedders (100)

  private embedFunction: EmbedFunction;
  private maxBatchSize: number;
  private ready = false;

  // Sliding window rate limiter: track timestamps of recent requests
  private requestTimestamps: number[] = [];
  private maxRequestsPerMinute: number;

  constructor(config: GeminiEmbedderConfig) {
    this.embedFunction = config.embedFunction;
    this.modelId = config.model ?? DEFAULT_MODEL;
    this.dimensions =
      config.dimensions ?? getModelDimensions(this.modelId) ?? 768;
    this.maxBatchSize = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxRequestsPerMinute = DEFAULT_MAX_REQUESTS_PER_MINUTE;
  }

  /**
   * Wait if we're approaching the rate limit.
   * Uses a sliding window of request timestamps.
   */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const windowStart = now - 60_000;

    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(t => t > windowStart);

    if (this.requestTimestamps.length >= this.maxRequestsPerMinute) {
      // Wait until the oldest request in the window expires
      const waitMs = this.requestTimestamps[0] - windowStart + 100;
      log.debug(`Rate limit: waiting ${waitMs}ms (${this.requestTimestamps.length} requests in last minute)`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    this.requestTimestamps.push(Date.now());
  }

  /**
   * Call embedFunction with throttling and retry on 429/transient errors.
   */
  private async callWithRetry(texts: string[]): Promise<number[][]> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle();
      try {
        return await this.embedFunction(texts, this.modelId, this.dimensions);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate');
        const isTransient = msg.includes('503') || msg.includes('500') || msg.toLowerCase().includes('unavailable');

        if ((isRateLimit || isTransient) && attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          log.warn(`Embedding request failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}): ${msg}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
    // Unreachable, but TypeScript needs it
    throw new Error('Max retries exceeded');
  }

  /**
   * Verify connectivity with a single test embedding.
   */
  async initialize(_onProgress?: ProgressCallback): Promise<void> {
    log.debug('Initializing GeminiEmbedder...');
    try {
      const testResult = await this.embedFunction(['test'], this.modelId, this.dimensions);
      if (!testResult || testResult.length === 0 || !testResult[0]?.length) {
        throw new Error('Test embedding returned empty result');
      }
      // Verify dimensions match expected
      if (testResult[0].length !== this.dimensions) {
        log.warn(
          `Expected ${this.dimensions} dimensions but got ${testResult[0].length}. Adjusting.`,
        );
        (this as { dimensions: number }).dimensions = testResult[0].length;
      }
      this.ready = true;
      log.info(
        `GeminiEmbedder ready: model=${this.modelId}, dimensions=${this.dimensions}`,
      );
    } catch (error) {
      const msg = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ''}`
        : String(error);
      log.error(`GeminiEmbedder initialization failed: ${msg}`);
      throw new Error(`GeminiEmbedder initialization failed: ${msg}`, { cause: error });
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Embed a single text.
   */
  async embed(text: string): Promise<number[]> {
    const results = await this.callWithRetry([text]);
    return results[0];
  }

  /**
   * Embed multiple texts in a single batch.
   * Auto-chunks if texts exceed maxBatchSize.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.length <= this.maxBatchSize) {
      return this.callWithRetry(texts);
    }

    // Chunk into batches
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const batchResults = await this.callWithRetry(batch);
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * Embed a search query. Gemini handles query/doc distinction internally.
   */
  async embedQuery(query: string): Promise<number[]> {
    return this.embed(query);
  }

  /**
   * Embed a document passage. Gemini handles query/doc distinction internally.
   */
  async embedDocument(text: string): Promise<number[]> {
    return this.embed(text);
  }

  /**
   * Embed multiple documents with auto-chunking.
   */
  async embedBatchDocuments(texts: string[]): Promise<number[][]> {
    return this.embedBatch(texts);
  }

  /**
   * Stream embeddings in batches for memory efficiency.
   */
  async *embedBatchDocumentsStreaming(
    texts: string[],
    batchSize?: number,
  ): AsyncGenerator<{ startIndex: number; embeddings: number[][] }> {
    const effectiveBatchSize = Math.min(
      batchSize ?? this.maxBatchSize,
      this.maxBatchSize,
    );

    for (let i = 0; i < texts.length; i += effectiveBatchSize) {
      const batch = texts.slice(i, i + effectiveBatchSize);
      const embeddings = await this.callWithRetry(batch);
      yield { startIndex: i, embeddings };
    }
  }

  /**
   * Get detailed embedding result with metadata.
   */
  async embedWithDetails(text: string): Promise<EmbeddingResult> {
    const embedding = await this.embed(text);
    return {
      embedding,
      model: this.modelId,
      dimensions: this.dimensions,
    };
  }

  /**
   * No-op — ContentGenerator lifecycle is managed externally.
   */
  async dispose(): Promise<void> {
    this.ready = false;
    log.debug('GeminiEmbedder disposed');
  }
}
