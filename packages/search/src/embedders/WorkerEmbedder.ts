/**
 * WorkerEmbedder - Worker thread-based embedder for non-blocking embeddings.
 *
 * This class wraps TransformersJsEmbedder and runs it in a separate worker thread,
 * preventing ML inference from blocking the main thread and keeping the CLI responsive.
 *
 * Implements the same TextEmbedder and Embedder interfaces for drop-in compatibility.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  TextEmbedder,
  TransformersJsEmbedderConfig,
  ProgressCallback,
  EmbeddingResult,
  EmbedderDevice,
  EmbedderQuantization,
} from './types.js';
import type { Embedder } from '../indexing/types.js';
import type {
  WorkerResponse,
  InitializedResponse,
  EmbeddingResponse,
  EmbeddingBatchResponse,
} from './worker-types.js';
import { debugLog } from './gpu-detection.js';

// ============================================================================
// Constants
// ============================================================================

/** Default timeout for initialization (includes model download) */
const INIT_TIMEOUT_MS = 600000; // 10 minutes

/** Default timeout for embedding operations */
const EMBED_TIMEOUT_MS = 300000; // 5 minutes

/** Model dimensions by model ID */
const MODEL_DIMENSIONS: Record<string, number> = {
  'Xenova/multilingual-e5-small': 384,
  'Xenova/multilingual-e5-base': 768,
  'Xenova/multilingual-e5-large': 1024,
  'Xenova/all-MiniLM-L6-v2': 384,
  'Xenova/all-mpnet-base-v2': 768,
};

/** Default model */
const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';

// ============================================================================
// Types
// ============================================================================

interface PendingRequest<T = unknown> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface WorkerEmbedderConfig extends TransformersJsEmbedderConfig {
  /** Timeout for initialization in ms (default: 600000 = 10 min) */
  initTimeout?: number;
  /** Timeout for embed operations in ms (default: 300000 = 5 min) */
  embedTimeout?: number;
  /** Device to run on ('cpu', 'dml', 'cuda') */
  device?: EmbedderDevice;
  /** Quantization type ('fp32', 'fp16', 'q8', 'q4') */
  quantization?: EmbedderQuantization;
}

// ============================================================================
// WorkerEmbedder Class
// ============================================================================

/**
 * Embedder that runs TransformersJsEmbedder in a worker thread.
 * Provides non-blocking embeddings by offloading ML inference to a separate thread.
 */
export class WorkerEmbedder implements TextEmbedder, Embedder {
  readonly name = 'worker-embedder';
  readonly priority = 100;

  // These are set after initialization
  private _modelId: string;
  private _dimensions: number;
  private _maxTokens = 512;
  private _isMultilingual = true;
  private _device: EmbedderDevice;
  private _quantization: EmbedderQuantization;

  private worker: Worker | null = null;
  private ready = false;
  private initializing = false;
  private initPromise: Promise<void> | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private config: WorkerEmbedderConfig;
  private progressCallback?: ProgressCallback;

  constructor(config?: WorkerEmbedderConfig) {
    this.config = config ?? {};
    this._modelId = config?.modelId ?? DEFAULT_MODEL_ID;
    this._dimensions = MODEL_DIMENSIONS[this._modelId] ?? 384;
    this._device = config?.device ?? 'cpu';
    this._quantization = config?.quantization ?? 'q8';
  }

  // -------------------------------------------------------------------------
  // TextEmbedder Interface Properties
  // -------------------------------------------------------------------------

  get modelId(): string {
    return this._modelId;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  get maxTokens(): number {
    return this._maxTokens;
  }

  get isMultilingual(): boolean {
    return this._isMultilingual;
  }

  /** The device this embedder is configured to use */
  get device(): EmbedderDevice {
    return this._device;
  }

  /** The quantization this embedder is configured to use */
  get quantization(): EmbedderQuantization {
    return this._quantization;
  }

  // -------------------------------------------------------------------------
  // Lifecycle Methods
  // -------------------------------------------------------------------------

  /**
   * Initialize the embedder by spawning a worker and loading the model.
   */
  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.ready) {
      return;
    }

    // Prevent concurrent initialization
    if (this.initPromise) {
      this.progressCallback = onProgress;
      return this.initPromise;
    }

    this.initializing = true;
    this.progressCallback = onProgress;

    this.initPromise = this.doInitialize();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
      this.initializing = false;
    }
  }

  private async doInitialize(): Promise<void> {
    debugLog(
      `WorkerEmbedder initializing: device=${this._device}, quantization=${this._quantization}`,
    );

    // Spawn worker thread
    await this.spawnWorker();

    // Send initialization request with device/quantization
    const response = await this.sendRequest<InitializedResponse>(
      {
        type: 'initialize',
        config: {
          ...this.config,
          device: this._device,
          quantization: this._quantization,
        },
      },
      this.config.initTimeout ?? INIT_TIMEOUT_MS,
    );

    if (!response.success) {
      throw new Error(`Worker initialization failed: ${response.error}`);
    }

    // Update properties from worker response
    if (response.dimensions) {
      this._dimensions = response.dimensions;
    }
    if (response.modelId) {
      this._modelId = response.modelId;
    }
    if (response.isMultilingual !== undefined) {
      this._isMultilingual = response.isMultilingual;
    }
    // Update device/quantization in case worker resolved them differently
    if (response.device) {
      this._device = response.device;
    }
    if (response.quantization) {
      this._quantization = response.quantization;
    }

    debugLog(
      `WorkerEmbedder initialized: device=${this._device}, quantization=${this._quantization}`,
    );

    this.ready = true;
  }

  /**
   * Check if the embedder is ready.
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Dispose of the embedder and terminate the worker.
   */
  async dispose(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      // Send dispose request to clean up embedder in worker
      await this.sendRequest({ type: 'dispose' }, 5000).catch(() => {
        // Ignore errors during dispose
      });
    } finally {
      // Terminate worker
      await this.terminateWorker();
    }
  }

  // -------------------------------------------------------------------------
  // Embedding Methods
  // -------------------------------------------------------------------------

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<number[]> {
    this.ensureReady();

    const response = await this.sendRequest<EmbeddingResponse>(
      { type: 'embed', text },
      this.config.embedTimeout ?? EMBED_TIMEOUT_MS,
    );

    return response.result;
  }

  /**
   * Generate embeddings for multiple texts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.ensureReady();

    const response = await this.sendRequest<EmbeddingBatchResponse>(
      { type: 'embedBatch', texts },
      this.config.embedTimeout ?? EMBED_TIMEOUT_MS,
    );

    return response.result;
  }

  /**
   * Generate embedding for a search query.
   * For E5 models, the worker adds the "query:" prefix.
   */
  async embedQuery(query: string): Promise<number[]> {
    this.ensureReady();

    const response = await this.sendRequest<EmbeddingResponse>(
      { type: 'embedQuery', query },
      this.config.embedTimeout ?? EMBED_TIMEOUT_MS,
    );

    return response.result;
  }

  /**
   * Generate embedding for a document/passage.
   * For E5 models, the worker adds the "passage:" prefix.
   */
  async embedDocument(text: string): Promise<number[]> {
    this.ensureReady();

    const response = await this.sendRequest<EmbeddingResponse>(
      { type: 'embedDocument', text },
      this.config.embedTimeout ?? EMBED_TIMEOUT_MS,
    );

    return response.result;
  }

  /**
   * Generate embeddings for multiple documents/passages.
   * For E5 models, the worker adds the "passage:" prefix to each.
   */
  async embedBatchDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.ensureReady();

    const response = await this.sendRequest<EmbeddingBatchResponse>(
      { type: 'embedBatchDocuments', texts },
      this.config.embedTimeout ?? EMBED_TIMEOUT_MS,
    );

    return response.result;
  }

  /**
   * Generate embedding with detailed result.
   */
  async embedWithDetails(text: string): Promise<EmbeddingResult> {
    const embedding = await this.embed(text);

    return {
      embedding,
      model: this._modelId,
      dimensions: embedding.length,
      tokenCount: this.estimateTokens(text),
    };
  }

  // -------------------------------------------------------------------------
  // Worker Management
  // -------------------------------------------------------------------------

  /**
   * Spawn the worker thread.
   */
  private async spawnWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Get the path to the worker script
        // In ESM, we need to use import.meta.url to get the current file's directory
        const currentDir = dirname(fileURLToPath(import.meta.url));
        const workerPath = join(currentDir, 'embedder-worker.js');

        this.worker = new Worker(workerPath);

        // Wait for worker to signal ready
        const onReady = (message: { type: string }) => {
          if (message.type === 'worker_ready') {
            this.worker!.off('message', onReady);
            resolve();
          }
        };

        const onError = (error: Error) => {
          this.worker!.off('message', onReady);
          reject(new Error(`Worker failed to start: ${error.message}`));
        };

        this.worker.on('message', onReady);
        this.worker.once('error', onError);

        // Set up message handler for all subsequent messages
        this.worker.on('message', (message: WorkerResponse) => {
          this.handleMessage(message);
        });

        // Handle worker errors
        this.worker.on('error', (error) => {
          this.handleWorkerError(error);
        });

        // Handle worker exit
        this.worker.on('exit', (code) => {
          if (code !== 0) {
            this.handleWorkerError(
              new Error(`Worker exited with code ${code}`),
            );
          }
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Terminate the worker thread.
   */
  private async terminateWorker(): Promise<void> {
    if (!this.worker) {
      return;
    }

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Worker terminated'));
    }
    this.pendingRequests.clear();

    // Terminate worker
    await this.worker.terminate();
    this.worker = null;
    this.ready = false;
  }

  /**
   * Handle worker error by rejecting all pending requests.
   */
  private handleWorkerError(error: Error): void {
    console.error('[WorkerEmbedder] Worker error:', error.message);

    // Reject all pending requests
    for (const [_id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Worker error: ${error.message}`));
    }
    this.pendingRequests.clear();

    // Mark as not ready
    this.ready = false;

    // Terminate worker
    this.worker?.terminate().catch(() => {});
    this.worker = null;
  }

  // -------------------------------------------------------------------------
  // Message Handling
  // -------------------------------------------------------------------------

  /**
   * Send a request to the worker and wait for response.
   */
  private sendRequest<T extends WorkerResponse>(
    request: { type: string } & Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'));
    }

    const id = `req_${++this.requestId}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
      });

      this.worker!.postMessage({ ...request, id });
    });
  }

  /**
   * Handle incoming messages from the worker.
   */
  private handleMessage(message: WorkerResponse): void {
    // Handle progress updates (don't resolve pending request)
    if (message.type === 'progress') {
      this.progressCallback?.(message.progress);
      return;
    }

    // Handle warnings (informational, don't resolve)
    if (message.type === 'warning') {
      console.warn(`[WorkerEmbedder] ${message.warning.message}`);
      return;
    }

    // Find and resolve/reject pending request
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      // No pending request - might be a late response after timeout
      return;
    }

    this.pendingRequests.delete(message.id);

    if (message.type === 'error') {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message);
    }
  }

  // -------------------------------------------------------------------------
  // Utility Methods
  // -------------------------------------------------------------------------

  /**
   * Ensure the embedder is ready.
   */
  private ensureReady(): void {
    if (!this.ready || !this.worker) {
      throw new Error(
        'WorkerEmbedder not initialized. Call initialize() first.',
      );
    }
  }

  /**
   * Rough estimate of token count.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new WorkerEmbedder instance.
 */
export function createWorkerEmbedder(
  config?: WorkerEmbedderConfig,
): WorkerEmbedder {
  return new WorkerEmbedder(config);
}
