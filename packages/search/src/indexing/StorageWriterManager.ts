/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * StorageWriterManager - Manages the thin storage writer child process.
 *
 * This manager:
 * 1. Spawns a child process that only has PGlite (no embedder, no pipeline)
 * 2. Sends document write commands to the child
 * 3. Tracks responses and emits progress events
 * 4. Respawns child after N writes to release WASM memory
 *
 * The main process handles discovery/parsing/chunking/embedding.
 * This manager handles storage writes via the child.
 */

import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import type { Interface } from 'node:readline';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from '../core/EventEmitter.js';
import { createModuleLogger } from '../core/Logger.js';
import type {
  StorageWriterRequest,
  StorageWriterResponse,
  PreparedDocumentWrite,
} from './storage-writer-types.js';
import type { DeepPartial, SearchSystemConfig } from '../config.js';

const log = createModuleLogger('StorageWriterManager');

// ============================================================================
// Configuration
// ============================================================================

export interface StorageWriterConfig {
  /** Documents to write before respawning child. Default: 200 */
  batchSize: number;
  /** Memory threshold (MB) for early respawn. Default: 2000 */
  memoryThresholdMb: number;
  /** Startup timeout (ms). Default: 60000 (1 min) */
  startupTimeoutMs: number;
  /** Write timeout (ms). Default: 30000 (30 sec per document) */
  writeTimeoutMs: number;
}

const DEFAULT_CONFIG: StorageWriterConfig = {
  batchSize: 200,
  memoryThresholdMb: 2000,
  startupTimeoutMs: 60000,
  writeTimeoutMs: 30000,
};

// ============================================================================
// Events
// ============================================================================

export interface StorageWriterEvents {
  [key: string]: unknown;

  /** Document successfully written */
  'document:written': {
    documentId: string;
    filePath: string;
    chunksWritten: number;
    embeddingsWritten: number;
    memoryMb: number;
  };

  /** Error writing document */
  'document:error': {
    filePath: string;
    error: string;
  };

  /** Child spawned */
  'child:spawned': {
    pid: number;
    batchNumber: number;
  };

  /** Child exited */
  'child:exited': {
    pid: number;
    code: number | null;
    batchNumber: number;
    documentsWritten: number;
  };

  /** Batch complete (child will exit) */
  'batch:complete': {
    batchNumber: number;
    documentsWritten: number;
    chunksWritten: number;
    memoryMb: number;
  };
}

// ============================================================================
// Pending Request Tracking
// ============================================================================

interface PendingRequest {
  resolve: (response: StorageWriterResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ============================================================================
// StorageWriterManager Class
// ============================================================================

export class StorageWriterManager extends EventEmitter<StorageWriterEvents> {
  private child: ChildProcess | null = null;
  private readline: Interface | null = null;
  private stderrReader: Interface | null = null;

  private config: StorageWriterConfig;
  private rootPath: string;
  private databasePath: string;
  private searchConfig: DeepPartial<SearchSystemConfig>;

  private batchNumber = 0;
  private documentsInBatch = 0;
  private totalDocumentsWritten = 0;
  private totalChunksWritten = 0;

  private isInitialized = false;
  private isShuttingDown = false;

  private pendingRequests = new Map<string, PendingRequest>();

  constructor(
    rootPath: string,
    databasePath: string,
    searchConfig: DeepPartial<SearchSystemConfig>,
    config?: Partial<StorageWriterConfig>,
  ) {
    super();
    this.rootPath = rootPath;
    this.databasePath = databasePath;
    this.searchConfig = searchConfig;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Initialize the storage writer (spawns child and initializes storage).
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await this.spawnChild();
    await this.initializeStorage();

    this.isInitialized = true;
  }

  /**
   * Write a prepared document to storage.
   * Automatically respawns child if batch size is reached.
   */
  async writeDocument(prepared: PreparedDocumentWrite): Promise<{
    documentId: string;
    chunkIds: string[];
  }> {
    if (!this.isInitialized || this.isShuttingDown) {
      throw new Error('StorageWriterManager not initialized or shutting down');
    }

    // Check if we need to respawn (batch size reached)
    if (this.documentsInBatch >= this.config.batchSize) {
      await this.respawnChild();
    }

    // Send write command
    const id = crypto.randomUUID();
    const response = await this.sendAndWait<StorageWriterResponse>({
      type: 'write_document',
      id,
      document: prepared.document,
      chunks: prepared.chunks,
      embeddings: prepared.embeddings,
      isReindex: prepared.isReindex,
    });

    if (response.type === 'error') {
      void this.emit('document:error', {
        filePath: prepared.document.filePath,
        error: response.error,
      });
      throw new Error(response.error);
    }

    if (response.type !== 'document_written') {
      throw new Error(`Unexpected response type: ${response.type}`);
    }

    // Update stats
    this.documentsInBatch++;
    this.totalDocumentsWritten++;
    this.totalChunksWritten += response.chunksWritten;

    void this.emit('document:written', {
      documentId: response.documentId,
      filePath: prepared.document.filePath,
      chunksWritten: response.chunksWritten,
      embeddingsWritten: response.embeddingsWritten,
      memoryMb: response.memoryUsageMb,
    });

    // Check memory threshold
    if (response.memoryUsageMb > this.config.memoryThresholdMb) {
      log.info('memoryThresholdReached', {
        memoryMb: response.memoryUsageMb,
        threshold: this.config.memoryThresholdMb,
      });
      // Will respawn on next write
      this.documentsInBatch = this.config.batchSize;
    }

    return {
      documentId: response.documentId,
      chunkIds: response.chunkIds,
    };
  }

  /**
   * Force a checkpoint on the child storage.
   */
  async checkpoint(): Promise<void> {
    if (!this.child || this.isShuttingDown) return;

    const id = crypto.randomUUID();
    await this.sendAndWait({
      type: 'checkpoint',
      id,
    });
  }

  /**
   * Get current stats.
   */
  async getStats(): Promise<{
    documentsWritten: number;
    chunksWritten: number;
    embeddingsWritten: number;
    memoryMb: number;
  }> {
    if (!this.child || this.isShuttingDown) {
      return {
        documentsWritten: this.totalDocumentsWritten,
        chunksWritten: this.totalChunksWritten,
        embeddingsWritten: 0,
        memoryMb: 0,
      };
    }

    const id = crypto.randomUUID();
    const response = await this.sendAndWait<StorageWriterResponse>({
      type: 'stats',
      id,
    });

    if (response.type === 'stats_response') {
      return {
        documentsWritten: response.documentsWritten,
        chunksWritten: response.chunksWritten,
        embeddingsWritten: response.embeddingsWritten,
        memoryMb: response.memoryUsageMb,
      };
    }

    return {
      documentsWritten: this.totalDocumentsWritten,
      chunksWritten: this.totalChunksWritten,
      embeddingsWritten: 0,
      memoryMb: 0,
    };
  }

  /**
   * Gracefully close the storage writer.
   */
  async close(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    log.info('close:starting', {
      totalDocuments: this.totalDocumentsWritten,
      totalChunks: this.totalChunksWritten,
    });

    // Send shutdown command
    if (this.child && !this.child.killed) {
      try {
        const id = crypto.randomUUID();
        this.send({ type: 'shutdown', id });

        // Wait for child to exit
        await Promise.race([
          new Promise<void>((resolve) => {
            this.child?.once('exit', () => resolve());
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              if (this.child && !this.child.killed) {
                log.warn('close:forceKill', { pid: this.child.pid });
                this.child.kill('SIGKILL');
              }
              resolve();
            }, 5000);
          }),
        ]);
      } catch (error) {
        log.warn('close:error', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.cleanup();
    this.isInitialized = false;

    log.info('close:complete', {
      totalDocuments: this.totalDocumentsWritten,
      totalChunks: this.totalChunksWritten,
    });
  }

  /**
   * Get status.
   */
  getStatus(): {
    isInitialized: boolean;
    batchNumber: number;
    documentsInBatch: number;
    totalDocumentsWritten: number;
    childPid: number | null;
  } {
    return {
      isInitialized: this.isInitialized,
      batchNumber: this.batchNumber,
      documentsInBatch: this.documentsInBatch,
      totalDocumentsWritten: this.totalDocumentsWritten,
      childPid: this.child?.pid ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Child Process Management
  // -------------------------------------------------------------------------

  /**
   * Spawn the storage writer child process.
   */
  private async spawnChild(): Promise<void> {
    this.batchNumber++;
    this.documentsInBatch = 0;

    const currentDir = dirname(fileURLToPath(import.meta.url));
    const workerPath = join(currentDir, 'storage-writer-child.js');

    log.info('spawnChild:starting', {
      workerPath,
      batchNumber: this.batchNumber,
    });

    // Spawn child
    this.child = fork(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    const pid = this.child.pid!;
    void this.emit('child:spawned', { pid, batchNumber: this.batchNumber });

    log.info('spawnChild:spawned', {
      pid,
      batchNumber: this.batchNumber,
    });

    // Set up stdout reader (JSONL responses)
    this.readline = createInterface({
      input: this.child.stdout!,
      crlfDelay: Infinity,
    });

    // Set up stderr reader (logs)
    this.stderrReader = createInterface({
      input: this.child.stderr!,
      crlfDelay: Infinity,
    });

    // Handle responses
    this.readline.on('line', (line) => {
      this.handleResponse(line);
    });

    // Handle stderr logs
    this.stderrReader.on('line', (line) => {
      try {
        const logEntry = JSON.parse(line);
        if (logEntry.level === 'error') {
          log.error(`child:${logEntry.message}`, logEntry.data);
        } else if (logEntry.level === 'warn') {
          log.warn(`child:${logEntry.message}`, logEntry.data);
        } else {
          log.debug(`child:${logEntry.message}`, logEntry.data);
        }
      } catch {
        if (line.trim()) {
          log.debug('child:stderr', { raw: line });
        }
      }
    });

    // Handle child exit
    this.child.on('exit', (code, signal) => {
      void this.emit('child:exited', {
        pid,
        code,
        batchNumber: this.batchNumber,
        documentsWritten: this.documentsInBatch,
      });

      log.info('child:exited', {
        pid,
        code,
        signal,
        batchNumber: this.batchNumber,
        documentsInBatch: this.documentsInBatch,
      });

      // Reject any pending requests
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Child process exited'));
        this.pendingRequests.delete(id);
      }
    });

    // Handle child error
    this.child.on('error', (error) => {
      log.error('child:error', { error: error.message });
    });

    // Wait for ready message
    await this.waitForReady();
  }

  /**
   * Wait for child to signal ready.
   */
  private waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Child startup timeout after ${this.config.startupTimeoutMs}ms`,
          ),
        );
        this.child?.kill('SIGKILL');
      }, this.config.startupTimeoutMs);

      const handler = (line: string) => {
        try {
          const msg: StorageWriterResponse = JSON.parse(line);
          if (msg.type === 'ready') {
            clearTimeout(timeout);
            this.readline?.off('line', handler);
            log.info('child:ready', { memoryMb: msg.memoryUsageMb });
            resolve();
          }
        } catch {
          // Ignore parse errors during startup
        }
      };

      this.readline?.on('line', handler);
    });
  }

  /**
   * Initialize storage in the child.
   */
  private async initializeStorage(): Promise<void> {
    const id = crypto.randomUUID();
    const response = await this.sendAndWait<StorageWriterResponse>({
      type: 'init',
      id,
      databasePath: this.databasePath,
      rootPath: this.rootPath,
      config: this.searchConfig,
    });

    if (response.type === 'error') {
      throw new Error(`Failed to initialize storage: ${response.error}`);
    }

    if (
      response.type === 'init_complete' &&
      !('success' in response && response.success)
    ) {
      throw new Error(
        `Failed to initialize storage: ${(response as { error?: string }).error || 'Unknown error'}`,
      );
    }

    log.info('storage:initialized', {
      memoryMb:
        response.type === 'init_complete' ? response.memoryUsageMb : 0,
    });
  }

  /**
   * Respawn child (graceful close + spawn new).
   */
  private async respawnChild(): Promise<void> {
    log.info('respawnChild:starting', {
      batchNumber: this.batchNumber,
      documentsInBatch: this.documentsInBatch,
    });

    void this.emit('batch:complete', {
      batchNumber: this.batchNumber,
      documentsWritten: this.documentsInBatch,
      chunksWritten: this.totalChunksWritten,
      memoryMb: 0,
    });

    // Send shutdown to current child
    if (this.child && !this.child.killed) {
      const id = crypto.randomUUID();
      this.send({ type: 'shutdown', id });

      // Wait for exit
      await Promise.race([
        new Promise<void>((resolve) => {
          this.child?.once('exit', () => resolve());
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);
    }

    this.cleanup();

    // Spawn new child
    await this.spawnChild();
    await this.initializeStorage();

    log.info('respawnChild:complete', {
      batchNumber: this.batchNumber,
    });
  }

  // -------------------------------------------------------------------------
  // IPC Helpers
  // -------------------------------------------------------------------------

  /**
   * Send a message to the child.
   */
  private send(msg: StorageWriterRequest): void {
    if (this.child?.stdin && !this.child.killed) {
      const line = JSON.stringify(msg) + '\n';
      this.child.stdin.write(line);
    }
  }

  /**
   * Send a message and wait for response.
   */
  private sendAndWait<T extends StorageWriterResponse>(
    msg: StorageWriterRequest,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = 'id' in msg ? msg.id : crypto.randomUUID();

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout after ${this.config.writeTimeoutMs}ms`));
      }, this.config.writeTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (response: StorageWriterResponse) => void,
        reject,
        timeout,
      });

      this.send(msg);
    });
  }

  /**
   * Handle response from child.
   */
  private handleResponse(line: string): void {
    try {
      const msg: StorageWriterResponse = JSON.parse(line);

      // Get request ID from response
      const id = 'id' in msg ? (msg as { id: string }).id : undefined;

      if (id && this.pendingRequests.has(id)) {
        const pending = this.pendingRequests.get(id)!;
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.resolve(msg);
      }
    } catch {
      log.warn('handleResponse:parseError', { line: line.substring(0, 100) });
    }
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.stderrReader) {
      this.stderrReader.close();
      this.stderrReader = null;
    }

    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
  }
}
