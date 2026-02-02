/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * IndexingChildManager - Orchestrates child processes for indexing.
 *
 * This class solves the fundamental WASM memory limitation (WASM memory can
 * only grow, never shrink) by running indexing in child processes. When a
 * child process exits after processing a batch of documents, ALL its memory
 * (including WASM heaps from PGlite) is completely released by the OS.
 *
 * Architecture:
 * - Main process spawns a child for each batch of documents
 * - Child runs full SearchSystem (PGliteStorage + IndexingPipeline + Embedder)
 * - Child reports progress via JSONL over stdout
 * - When batch completes, child exits and memory is freed
 * - Main process spawns new child for next batch if more work remains
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
  MainToChildMessage,
  ChildToMainMessage,
  BatchCompleteMessage,
  StartIndexingMessage,
} from './child-process-types.js';
import type { DeepPartial, SearchSystemConfig } from '../config.js';

const log = createModuleLogger('IndexingChildManager');

// ============================================================================
// Configuration
// ============================================================================

export interface ChildManagerConfig {
  /** Documents to process before child respawns. Default: 500 */
  batchSize: number;
  /** Memory threshold (MB) for early respawn. Default: 3000 */
  memoryThresholdMb: number;
  /** Startup timeout (ms). Default: 120000 (2 min) */
  startupTimeoutMs: number;
  /** Batch processing timeout (ms). Default: 3600000 (1 hour) */
  batchTimeoutMs: number;
}

const DEFAULT_CONFIG: ChildManagerConfig = {
  batchSize: 500,
  memoryThresholdMb: 3000,
  startupTimeoutMs: 120000,
  batchTimeoutMs: 3600000,
};

// ============================================================================
// Events
// ============================================================================

export interface IndexingChildEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;

  /** Progress update from child */
  progress: {
    current: number;
    total: number;
    memoryMb: number;
    event: string;
    data?: unknown;
  };
  /** Batch completed (child will exit) */
  'batch:complete': BatchCompleteMessage['stats'] & { hasMore: boolean };
  /** Error from child */
  error: { error: string; fatal: boolean };
  /** Child process spawned */
  'child:spawned': { pid: number; batchNumber: number };
  /** Child process exited */
  'child:exited': { pid: number; code: number | null; batchNumber: number };
}

// ============================================================================
// IndexingChildManager Class
// ============================================================================

export class IndexingChildManager extends EventEmitter<IndexingChildEvents> {
  private child: ChildProcess | null = null;
  private readline: Interface | null = null;
  private stderrReader: Interface | null = null;
  private config: ChildManagerConfig;
  private rootPath: string;
  private databasePath: string;
  private searchConfig: DeepPartial<SearchSystemConfig>;
  private batchNumber = 0;
  private isRunning = false;
  private abortRequested = false;

  constructor(
    rootPath: string,
    databasePath: string,
    searchConfig: DeepPartial<SearchSystemConfig>,
    config?: Partial<ChildManagerConfig>,
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
   * Run indexing across multiple child processes.
   * Each child processes a batch then exits, releasing all WASM memory.
   */
  async indexAll(options: {
    force?: boolean;
  }): Promise<{ indexed: number; failed: number; duration: number }> {
    if (this.isRunning) {
      throw new Error('Indexing already in progress');
    }

    this.isRunning = true;
    this.abortRequested = false;
    const startTime = Date.now();
    let totalIndexed = 0;
    let totalFailed = 0;

    log.info('indexAll:start', {
      rootPath: this.rootPath,
      batchSize: this.config.batchSize,
      force: options.force,
    });

    try {
      // Loop: spawn child, wait for batch, respawn if more work
      while (!this.abortRequested) {
        this.batchNumber++;

        log.info('indexAll:batch', {
          batchNumber: this.batchNumber,
          totalIndexed,
          totalFailed,
        });

        const result = await this.runBatch({
          force: options.force && this.batchNumber === 1, // Only force on first batch
        });

        totalIndexed += result.stats.processed;
        totalFailed += result.stats.failed;

        void this.emit('batch:complete', {
          ...result.stats,
          hasMore: result.hasMore,
        });

        if (!result.hasMore) {
          log.info('indexAll:complete', {
            batchCount: this.batchNumber,
            totalIndexed,
            totalFailed,
          });
          break;
        }

        // Small delay between batches to let GC run in main process
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      return {
        indexed: totalIndexed,
        failed: totalFailed,
        duration: Date.now() - startTime,
      };
    } finally {
      this.isRunning = false;
      this.cleanup();
    }
  }

  /**
   * Stop the current indexing operation gracefully.
   */
  async stop(): Promise<void> {
    this.abortRequested = true;

    if (this.child) {
      log.info('stop:requested', { pid: this.child.pid });

      // Send shutdown command
      this.send({ type: 'shutdown', id: crypto.randomUUID() });

      // Wait for child to exit with timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          this.child?.once('exit', () => resolve());
        }),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            if (this.child) {
              log.warn('stop:forceKill', { pid: this.child.pid });
              this.child.kill('SIGKILL');
            }
            resolve();
          }, 5000);
        }),
      ]);

      this.cleanup();
    }
  }

  /**
   * Get current status.
   */
  getStatus(): {
    isRunning: boolean;
    batchNumber: number;
    childPid: number | null;
  } {
    return {
      isRunning: this.isRunning,
      batchNumber: this.batchNumber,
      childPid: this.child?.pid ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Child Process Management
  // -------------------------------------------------------------------------

  /**
   * Run a single batch in a child process.
   */
  private async runBatch(options: {
    force?: boolean;
  }): Promise<BatchCompleteMessage> {
    return new Promise((resolve, reject) => {
      // Get path to worker script
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const workerPath = join(currentDir, 'indexing-child-worker.js');

      log.debug('runBatch:spawning', {
        workerPath,
        batchNumber: this.batchNumber,
      });

      // Spawn child process
      // Note: fork() requires 'ipc' in stdio array when using custom stdio config
      // stderr is piped (not inherited) to prevent breaking the UI
      this.child = fork(workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'], // stdin/stdout/stderr all piped, ipc required by fork
        // No NODE_OPTIONS needed - child uses default heap
      });

      const pid = this.child.pid!;
      void this.emit('child:spawned', { pid, batchNumber: this.batchNumber });

      log.info('runBatch:spawned', {
        pid,
        batchNumber: this.batchNumber,
      });

      // Set up readline for JSONL parsing (stdout)
      this.readline = createInterface({
        input: this.child.stdout!,
        crlfDelay: Infinity,
      });

      // Set up readline for stderr (child logs in JSONL format)
      this.stderrReader = createInterface({
        input: this.child.stderr!,
        crlfDelay: Infinity,
      });

      // Handle child stderr logs - parse JSONL and log through our system
      this.stderrReader.on('line', (line) => {
        try {
          const logEntry = JSON.parse(line);
          // Forward to our logger based on level
          if (logEntry.level === 'error') {
            log.error(`child:${logEntry.message}`, logEntry.data);
          } else if (logEntry.level === 'warn') {
            log.warn(`child:${logEntry.message}`, logEntry.data);
          } else {
            log.debug(`child:${logEntry.message}`, logEntry.data);
          }
        } catch {
          // Non-JSON stderr output (e.g., native errors) - log as debug
          if (line.trim()) {
            log.debug('child:stderr', { raw: line });
          }
        }
      });

      // Timeouts and state
      let startupTimeout: ReturnType<typeof setTimeout> | null = null;
      let batchTimeout: ReturnType<typeof setTimeout> | null = null;
      let isResolved = false;
      let batchResult: BatchCompleteMessage | null = null;

      const cleanup = () => {
        if (startupTimeout) clearTimeout(startupTimeout);
        if (batchTimeout) clearTimeout(batchTimeout);
        startupTimeout = null;
        batchTimeout = null;
      };

      const doResolve = (result: BatchCompleteMessage) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(result);
        }
      };

      const doReject = (error: Error) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          this.cleanup();
          reject(error);
        }
      };

      // Startup timeout
      startupTimeout = setTimeout(() => {
        doReject(
          new Error(
            `Child process startup timeout after ${this.config.startupTimeoutMs}ms`,
          ),
        );
        this.child?.kill('SIGKILL');
      }, this.config.startupTimeoutMs);

      // Handle messages from child
      this.readline.on('line', (line) => {
        try {
          const msg: ChildToMainMessage = JSON.parse(line);

          switch (msg.type) {
            case 'ready': {
              // Clear startup timeout, start batch timeout
              if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
              }

              batchTimeout = setTimeout(() => {
                doReject(
                  new Error(
                    `Batch processing timeout after ${this.config.batchTimeoutMs}ms`,
                  ),
                );
                this.child?.kill('SIGKILL');
              }, this.config.batchTimeoutMs);

              // Send indexing command
              const startMsg: StartIndexingMessage = {
                type: 'start_indexing',
                id: crypto.randomUUID(),
                rootPath: this.rootPath,
                databasePath: this.databasePath,
                config: this.searchConfig,
                options: {
                  force: options.force,
                  maxDocuments: this.config.batchSize,
                },
              };
              this.send(startMsg);
              break;
            }

            case 'progress':
              void this.emit('progress', {
                current: msg.processed,
                total: msg.total,
                memoryMb: msg.memoryUsageMb,
                event: msg.event,
                data: msg.data,
              });
              break;

            case 'batch_complete':
              log.info('runBatch:complete', {
                batchNumber: this.batchNumber,
                stats: msg.stats,
                hasMore: msg.hasMore,
              });
              // Store result but DON'T resolve yet - wait for child to fully exit
              // This ensures the database is fully released before we spawn a new child
              // or reconnect main's PGlite
              batchResult = msg;
              break;

            case 'error':
              log.error('runBatch:error', {
                batchNumber: this.batchNumber,
                error: msg.error,
                fatal: msg.fatal,
              });
              void this.emit('error', { error: msg.error, fatal: msg.fatal });
              if (msg.fatal) {
                doReject(new Error(msg.error));
              }
              break;

            case 'pong':
              // Health check response, ignore
              break;

            default:
              // Unknown message type, ignore
              break;
          }
        } catch (parseError) {
          log.warn('runBatch:parseError', {
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            line: line.substring(0, 100),
          });
        }
      });

      // Handle child exit
      this.child.on('exit', (code, signal) => {
        void this.emit('child:exited', {
          pid,
          code,
          batchNumber: this.batchNumber,
        });

        log.info('runBatch:childExited', {
          pid,
          code,
          signal,
          batchNumber: this.batchNumber,
        });

        // Now resolve - child has fully exited and released database
        if (!isResolved) {
          if (batchResult) {
            // Normal completion: batch_complete was received, now child exited
            doResolve(batchResult);
          } else if (code === 0) {
            // Clean exit without batch_complete - maybe no work was needed
            doResolve({
              type: 'batch_complete',
              id: '',
              stats: {
                processed: 0,
                failed: 0,
                duration: 0,
                memoryUsageMb: 0,
              },
              hasMore: false,
            });
          } else {
            // Error exit
            doReject(
              new Error(
                `Child process exited unexpectedly with code ${code}, signal ${signal}`,
              ),
            );
          }
        }
      });

      // Handle child error
      this.child.on('error', (error) => {
        log.error('runBatch:childError', {
          error: error.message,
          batchNumber: this.batchNumber,
        });
        doReject(error);
      });
    });
  }

  /**
   * Send a message to the child process.
   */
  private send(msg: MainToChildMessage): void {
    if (this.child?.stdin && !this.child.killed) {
      const line = JSON.stringify(msg) + '\n';
      this.child.stdin.write(line);
    }
  }

  /**
   * Clean up child process resources.
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
