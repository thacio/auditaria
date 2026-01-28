/**
 * PythonEmbedder - TypeScript bridge for the Python ONNX embedder.
 *
 * Spawns a Python process and communicates via JSONL protocol.
 * Produces IDENTICAL embeddings to TransformersJsEmbedder by using
 * the same ONNX model files.
 *
 * Features:
 * - Same interface as TransformersJsEmbedder/WorkerEmbedder
 * - JSONL communication with Python subprocess
 * - Automatic process management and cleanup
 * - Graceful shutdown
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import type {
  TextEmbedder,
  ProgressCallback,
  EmbeddingResult,
  EmbedderQuantization,
} from './types.js';
import type { Embedder } from '../indexing/types.js';
import { getPythonCommand } from './python-detection.js';
import { debugLog } from './gpu-detection.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for PythonEmbedder.
 */
export interface PythonEmbedderConfig {
  /** Model ID. Default: 'Xenova/multilingual-e5-small' */
  modelId?: string;
  /** Quantization. Default: 'q8' */
  quantization?: EmbedderQuantization;
  /** HuggingFace cache directory */
  cacheDir?: string;
  /** Batch size for embedding. Default: 16 */
  batchSize?: number;
}

/**
 * Pending request tracking.
 */
interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  type: string;
}

/**
 * Python process response types.
 */
interface PythonResponse {
  type: string;
  id?: string;
  embedding?: number[];
  embeddings?: number[][];
  dimensions?: number;
  model?: string;
  quantization?: string;
  message?: string;
  stage?: string;
  progress?: number;
  error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';
const MODEL_DIMENSIONS: Record<string, number> = {
  'Xenova/multilingual-e5-small': 384,
  'Xenova/multilingual-e5-base': 768,
  'Xenova/multilingual-e5-large': 1024,
};

import { existsSync } from 'node:fs';

// Get the directory containing this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get the path to the Python embedder script.
 * Works in both development (src/) and production (dist/) environments.
 *
 * Possible locations:
 * - Development: packages/search/src/embedders/ -> ../../python/embedder.py
 * - Built (dist/src/embedders/): -> ../../../python/embedder.py
 * - Built (dist/embedders/): -> ../../python/embedder.py
 */
function getPythonScriptPath(): string {
  // Try multiple possible paths
  const candidates = [
    // From src/embedders/ or dist/embedders/
    join(__dirname, '..', '..', 'python', 'embedder.py'),
    // From dist/src/embedders/
    join(__dirname, '..', '..', '..', 'python', 'embedder.py'),
    // Absolute fallback using process.cwd()
    join(process.cwd(), 'python', 'embedder.py'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Default to first candidate (will fail with clear error if not found)
  return candidates[0];
}

const PYTHON_SCRIPT_PATH = getPythonScriptPath();

// ============================================================================
// PythonEmbedder Class
// ============================================================================

/**
 * Text embedder using Python subprocess with ONNX runtime.
 * Produces identical embeddings to TransformersJsEmbedder.
 */
export class PythonEmbedder
  extends EventEmitter
  implements TextEmbedder, Embedder
{
  readonly name = 'python-onnx';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxTokens = 512;
  readonly isMultilingual: boolean;
  readonly priority = 90; // Slightly lower than TransformersJs

  readonly quantization: EmbedderQuantization;

  private config: Required<PythonEmbedderConfig>;
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private ready = false;
  private initializingPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private currentBatchSize: number;

  constructor(config?: PythonEmbedderConfig) {
    super();

    this.config = {
      modelId: config?.modelId ?? DEFAULT_MODEL_ID,
      quantization: config?.quantization ?? 'q8',
      cacheDir: config?.cacheDir ?? '',
      batchSize: config?.batchSize ?? 16,
    };

    this.modelId = this.config.modelId;
    this.dimensions = MODEL_DIMENSIONS[this.modelId] ?? 384;
    this.isMultilingual = this.modelId.includes('multilingual');
    this.quantization = this.config.quantization;
    this.currentBatchSize = this.config.batchSize;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the Python embedder by spawning the process.
   */
  async initialize(onProgress?: ProgressCallback): Promise<void> {
    if (this.ready) return;

    if (this.initializingPromise) {
      await this.initializingPromise;
      return;
    }

    this.initializingPromise = this.doInitialize(onProgress);

    try {
      await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
    }
  }

  private async doInitialize(onProgress?: ProgressCallback): Promise<void> {
    debugLog('[PythonEmbedder] Initializing...');

    onProgress?.({
      stage: 'download',
      progress: 0,
      message: 'Starting Python embedder...',
    });

    // Get Python command
    const pythonCmd = await getPythonCommand();
    if (!pythonCmd) {
      throw new Error(
        'Python not available. Install Python 3.8+ to use Python embedder.',
      );
    }

    debugLog(`[PythonEmbedder] Using Python command: ${pythonCmd}`);
    debugLog(`[PythonEmbedder] Script path: ${PYTHON_SCRIPT_PATH}`);

    // Spawn Python process with UTF-8 encoding
    // PYTHONIOENCODING is critical on Windows where default encoding may be cp1252
    this.process = spawn(pythonCmd, [PYTHON_SCRIPT_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8', // Force UTF-8 for stdin/stdout (critical on Windows)
        PYTHONUNBUFFERED: '1', // Ensure unbuffered output
      },
    });

    // Set up readline for stdout
    this.readline = createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    });

    // Handle stdout lines (JSONL responses)
    this.readline.on('line', (line) => {
      this.handleResponse(line);
    });

    // Handle stderr (debug logs)
    this.process.stderr?.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        debugLog(`[PythonEmbedder:stderr] ${message}`);
      }
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      debugLog(
        `[PythonEmbedder] Process exited: code=${code}, signal=${signal}`,
      );
      this.handleProcessExit(code, signal);
    });

    // Handle process error
    this.process.on('error', (err) => {
      debugLog(`[PythonEmbedder] Process error: ${err.message}`);
      this.handleProcessError(err);
    });

    onProgress?.({
      stage: 'load',
      progress: 20,
      message: 'Initializing Python ONNX runtime...',
    });

    // Send init command
    await this.sendInitCommand(onProgress);

    this.ready = true;

    onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Python embedder ready',
    });

    debugLog('[PythonEmbedder] Initialization complete');
  }

  /**
   * Send init command and wait for ready response.
   */
  private async sendInitCommand(onProgress?: ProgressCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = {
        type: 'init',
        model: this.config.modelId,
        quantization: this.config.quantization,
        cache_dir: this.config.cacheDir || undefined,
        batch_size: this.config.batchSize,
      };

      // Set up temporary handler for init response
      const initHandler = (line: string) => {
        try {
          const response: PythonResponse = JSON.parse(line);

          if (response.type === 'progress' && onProgress) {
            const stage = (response.stage ?? 'load') as
              | 'download'
              | 'load'
              | 'ready';
            onProgress({
              stage,
              progress: response.progress ?? 50,
              message: response.message ?? 'Loading...',
            });
          } else if (response.type === 'ready') {
            debugLog(
              `[PythonEmbedder] Ready: dimensions=${response.dimensions}`,
            );
            resolve();
          } else if (response.type === 'error') {
            reject(new Error(response.message ?? 'Unknown error'));
          }
        } catch {
          // Ignore parse errors during init (could be debug output)
        }
      };

      // Temporarily add listener
      this.readline?.on('line', initHandler);

      // Set timeout for initialization
      const timeout = setTimeout(() => {
        this.readline?.removeListener('line', initHandler);
        reject(new Error('Python embedder initialization timeout'));
      }, 120000); // 2 minutes timeout for model download

      // Clean up handler on completion
      const cleanup = () => {
        clearTimeout(timeout);
        this.readline?.removeListener('line', initHandler);
      };

      // Wrap resolve/reject to clean up
      const wrappedResolve = () => {
        cleanup();
        resolve();
      };

      const wrappedReject = (err: Error) => {
        cleanup();
        reject(err);
      };

      // Re-assign handler with cleanup
      this.readline?.removeListener('line', initHandler);
      const finalHandler = (line: string) => {
        try {
          const response: PythonResponse = JSON.parse(line);

          if (response.type === 'progress' && onProgress) {
            const stage = (response.stage ?? 'load') as
              | 'download'
              | 'load'
              | 'ready';
            onProgress({
              stage,
              progress: response.progress ?? 50,
              message: response.message ?? 'Loading...',
            });
          } else if (response.type === 'ready') {
            debugLog(
              `[PythonEmbedder] Ready: dimensions=${response.dimensions}`,
            );
            wrappedResolve();
          } else if (response.type === 'error') {
            wrappedReject(new Error(response.message ?? 'Unknown error'));
          }
        } catch {
          // Ignore parse errors
        }
      };

      this.readline?.on('line', finalHandler);

      // Store cleanup for later
      (this as unknown as { _initCleanup: () => void })._initCleanup = () => {
        cleanup();
        this.readline?.removeListener('line', finalHandler);
      };

      // Send the init command
      this.sendRequest(request);
    });
  }

  /**
   * Check if the embedder is ready.
   */
  isReady(): boolean {
    return this.ready && this.process !== null;
  }

  /**
   * Dispose of the embedder and release resources.
   */
  async dispose(): Promise<void> {
    if (this.process) {
      // Send shutdown command
      try {
        this.sendRequest({ type: 'shutdown' });
      } catch {
        // Ignore errors during shutdown
      }

      // Give process time to exit gracefully
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if not exited
          this.process?.kill('SIGKILL');
          resolve();
        }, 5000);

        this.process?.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.process = null;
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Embedder disposed'));
    }
    this.pendingRequests.clear();

    this.ready = false;
    debugLog('[PythonEmbedder] Disposed');
  }

  // -------------------------------------------------------------------------
  // Communication
  // -------------------------------------------------------------------------

  /**
   * Send a request to the Python process.
   */
  private sendRequest(request: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      throw new Error('Python process not running');
    }

    const json = JSON.stringify(request);
    this.process.stdin.write(json + '\n');
  }

  /**
   * Send a request and wait for response.
   */
  private async sendRequestWithResponse<T>(
    request: Record<string, unknown>,
    type: string,
  ): Promise<T> {
    const id = `req_${++this.requestCounter}`;
    request.id = id;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        type,
      });

      try {
        this.sendRequest(request);
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }

      // Set timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${type}`));
        }
      }, 300000); // 5 minutes timeout for large batches
    });
  }

  /**
   * Handle response from Python process.
   */
  private handleResponse(line: string): void {
    let response: PythonResponse;

    try {
      response = JSON.parse(line);
    } catch {
      debugLog(`[PythonEmbedder] Invalid JSON: ${line}`);
      return;
    }

    const id = response.id;

    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      this.pendingRequests.delete(id);

      if (response.type === 'error') {
        pending.reject(new Error(response.message ?? 'Unknown error'));
      } else if (response.type === 'embedding') {
        pending.resolve(response.embedding);
      } else if (response.type === 'embeddings') {
        pending.resolve(response.embeddings);
      } else {
        pending.resolve(response);
      }
    }
  }

  /**
   * Handle process exit.
   */
  private handleProcessExit(code: number | null, signal: string | null): void {
    this.ready = false;

    // Reject all pending requests
    const error = new Error(
      `Python process exited: code=${code}, signal=${signal}`,
    );
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Handle process error.
   */
  private handleProcessError(err: Error): void {
    this.ready = false;

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }

  // -------------------------------------------------------------------------
  // Embedding Methods
  // -------------------------------------------------------------------------

  /**
   * Generate embedding for a single text.
   */
  async embed(text: string): Promise<number[]> {
    this.ensureReady();

    return this.sendRequestWithResponse<number[]>(
      { type: 'embed', text },
      'embed',
    );
  }

  /**
   * Generate embeddings for multiple texts.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.ensureReady();

    // Process in batches
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.currentBatchSize) {
      const batch = texts.slice(i, i + this.currentBatchSize);
      const batchResults = await this.sendRequestWithResponse<number[][]>(
        { type: 'embed_batch', texts: batch },
        'embed_batch',
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Generate embedding for a search query.
   * For E5 models, adds "query:" prefix.
   */
  async embedQuery(query: string): Promise<number[]> {
    this.ensureReady();

    return this.sendRequestWithResponse<number[]>(
      { type: 'embed_query', text: query },
      'embed_query',
    );
  }

  /**
   * Generate embedding for a document/passage.
   * For E5 models, adds "passage:" prefix.
   */
  async embedDocument(text: string): Promise<number[]> {
    this.ensureReady();

    return this.sendRequestWithResponse<number[]>(
      { type: 'embed_document', text },
      'embed_document',
    );
  }

  /**
   * Generate embeddings for multiple documents/passages.
   * For E5 models, adds "passage:" prefix to each.
   */
  async embedBatchDocuments(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    this.ensureReady();

    // Process in batches
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.currentBatchSize) {
      const batch = texts.slice(i, i + this.currentBatchSize);
      const batchResults = await this.sendRequestWithResponse<number[][]>(
        { type: 'embed_batch_documents', texts: batch },
        'embed_batch_documents',
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Stream embeddings for multiple documents/passages.
   * Yields batches of embeddings for memory efficiency - prevents accumulation
   * of all embeddings in memory at once.
   * For E5 models, adds "passage:" prefix to each.
   */
  async *embedBatchDocumentsStreaming(
    texts: string[],
    batchSize?: number,
  ): AsyncGenerator<{ startIndex: number; embeddings: number[][] }> {
    if (texts.length === 0) return;

    this.ensureReady();

    const effectiveBatchSize = batchSize ?? this.currentBatchSize;

    for (let i = 0; i < texts.length; i += effectiveBatchSize) {
      const batch = texts.slice(i, i + effectiveBatchSize);
      const embeddings = await this.sendRequestWithResponse<number[][]>(
        { type: 'embed_batch_documents', texts: batch },
        'embed_batch_documents',
      );
      yield { startIndex: i, embeddings };
    }
  }

  /**
   * Generate embedding with detailed result.
   */
  async embedWithDetails(text: string): Promise<EmbeddingResult> {
    const embedding = await this.embed(text);

    return {
      embedding,
      model: this.modelId,
      dimensions: embedding.length,
      tokenCount: this.estimateTokens(text),
    };
  }

  // -------------------------------------------------------------------------
  // Batch Size Management (for interface compatibility)
  // -------------------------------------------------------------------------

  /**
   * Get the current effective batch size.
   */
  getCurrentBatchSize(): number {
    return this.currentBatchSize;
  }

  /**
   * Reset batch size to configured value.
   */
  resetBatchSize(): void {
    this.currentBatchSize = this.config.batchSize;
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Ensure the embedder is ready.
   */
  private ensureReady(): void {
    if (!this.ready || !this.process) {
      throw new Error(
        'PythonEmbedder not initialized. Call initialize() first.',
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
 * Create a new PythonEmbedder instance.
 */
export function createPythonEmbedder(
  config?: PythonEmbedderConfig,
): PythonEmbedder {
  return new PythonEmbedder(config);
}
