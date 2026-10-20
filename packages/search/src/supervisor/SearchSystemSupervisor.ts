/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

// AUDITARIA_FEATURE: SearchSystem Supervisor
// Main supervisor class that wraps SearchSystem with automatic restart capabilities.
// Provides the same API as SearchSystem, delegating to a restart strategy.

/* eslint-disable no-console */

import { join } from 'node:path';
import { EventEmitter } from '../core/EventEmitter.js';
import type {
  SearchSystemConfig,
  DeepPartial,
  SupervisorStrategy,
} from '../config.js';
import {
  createConfig,
  loadMergedConfig,
  loadUserConfig,
  deepMerge,
} from '../config.js';
import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchStats,
  QueueStatus,
  QueueDetailedStatus,
  DiscoveredFile,
  SearchFilters,
  QueuePriority,
  Document,
  DocumentChunk,
} from '../types.js';
import type { OcrQueueStatus } from '../ocr/OcrQueueManager.js';
import type { SearchSystemState } from '../core/SearchSystem.js';
import type {
  SupervisorConfig,
  SupervisorState,
  SupervisorEvents,
  IndexAllResult,
  IndexAllOptions,
  SupervisorInitOptions,
} from './types.js';
import {
  INITIAL_SUPERVISOR_STATE,
  createSupervisorConfig,
  getMemoryUsageMb,
} from './types.js';
import type { RestartStrategy } from './strategies/RestartStrategy.js';
import { InProcessStrategy } from './strategies/InProcessStrategy.js';
import { ChildProcessStrategy } from './strategies/ChildProcessStrategy.js';

// ============================================================================
// SearchSystemSupervisor Implementation
// ============================================================================

/**
 * SearchSystem Supervisor - wraps SearchSystem with automatic restart capabilities.
 *
 * Provides the same API as SearchSystem, but automatically restarts the system
 * after processing a configurable number of documents to prevent memory bloat.
 *
 * Two strategies are available:
 * - 'in-process': Close/GC/reinitialize in same process (~60-80% memory recovery)
 * - 'child-process': Run in child process, kill/respawn (100% memory recovery)
 */
export class SearchSystemSupervisor extends EventEmitter<SupervisorEvents> {
  private strategy: RestartStrategy | null = null;
  private restartPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private indexing = false;
  private indexingCancelled = false;
  private config: SearchSystemConfig;
  /** Original partial config - passed to SearchSystem for proper user config merging */
  private partialConfig: DeepPartial<SearchSystemConfig>;
  private supervisorConfig: SupervisorConfig;
  private state: SupervisorState = { ...INITIAL_SUPERVISOR_STATE };
  private rootPath: string;
  private databasePath: string;

  // Track last progress for delta calculation (must be class property to reset on restart)
  private lastProgressCurrent: number = 0;

  private constructor(
    rootPath: string,
    config: SearchSystemConfig,
    partialConfig: DeepPartial<SearchSystemConfig>,
    supervisorConfig: SupervisorConfig,
  ) {
    super();
    this.rootPath = rootPath;
    this.config = config;
    this.partialConfig = partialConfig;
    this.supervisorConfig = supervisorConfig;
    this.databasePath = join(rootPath, config.database.path);
  }

  // -------------------------------------------------------------------------
  // Static Factory Methods
  // -------------------------------------------------------------------------

  /**
   * Create and initialize a new supervisor.
   */
  static async create(
    options: SupervisorInitOptions,
  ): Promise<SearchSystemSupervisor> {
    // Store the original partial config - this will be passed to SearchSystem
    // so it can properly merge with user config (knowledge-base.config.json).
    // Priority: database metadata > user config > programmatic options > defaults
    const partialConfig = options.config ?? {};

    // Create full config for Supervisor's internal use (e.g., databasePath, ocr.enabled)
    const auditariaDir = join(options.rootPath, '.auditaria');
    const preferences = loadUserConfig(auditariaDir)?.config ?? {};
    const preliminary = createConfig(deepMerge(preferences, partialConfig));
    const { config } = loadMergedConfig(
      auditariaDir,
      join(options.rootPath, preliminary.database.path),
      partialConfig,
    );

    const supervisorConfig = createSupervisorConfig(
      config.indexing,
      options.supervisorConfig,
    );

    const supervisor = new SearchSystemSupervisor(
      options.rootPath,
      config,
      partialConfig,
      supervisorConfig,
    );

    await supervisor.initialize();
    return supervisor;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the supervisor and its strategy.
   */
  private async initialize(): Promise<void> {
    this.state.status = 'starting';
    void this.emit('supervisor:starting', {
      strategy: this.supervisorConfig.strategy,
    });

    // console.log(`[SearchSystemSupervisor] Initializing with strategy: ${this.supervisorConfig.strategy}`);

    // Create the appropriate strategy
    this.strategy = this.createStrategy(this.supervisorConfig.strategy);

    // Initialize the strategy with PARTIAL config
    // The strategy passes this to SearchSystem.initialize() which merges it properly
    // with user config (knowledge-base.config.json) using the correct priority order.
    await this.strategy.initialize(
      this.rootPath,
      this.databasePath,
      this.partialConfig,
      this.supervisorConfig,
    );

    // Subscribe to strategy events and forward them
    this.subscribeToStrategyEvents();

    this.state.status = 'running';
    this.state.isReady = true;
    void this.emit('supervisor:ready', {
      strategy: this.supervisorConfig.strategy,
      memoryMb: this.strategy.getMemoryUsageMb(),
    });

    // console.log('[SearchSystemSupervisor] Ready');
  }

  /**
   * Close the supervisor and release all resources.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.state.isReady = false;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    await this.restartPromise?.catch(() => undefined);
    this.state.status = 'stopping';
    void this.emit('supervisor:stopping', { reason: 'close() called' });

    // console.log('[SearchSystemSupervisor] Closing...');

    if (this.strategy) {
      await this.strategy.dispose();
      this.strategy = null;
    }

    this.state.status = 'idle';
    this.state.isReady = false;
    void this.emit('supervisor:stopped', {
      totalDocumentsProcessed: this.state.totalDocumentsProcessed,
      restartCount: this.state.restartCount,
    });

    // console.log('[SearchSystemSupervisor] Closed');
  }

  // -------------------------------------------------------------------------
  // Search Methods (Proxy to SearchSystem)
  // -------------------------------------------------------------------------

  /**
   * Perform a search.
   */
  async search(options: SearchOptions): Promise<SearchResponse> {
    return this.call<SearchResponse>('search', [options]);
  }

  /**
   * Quick keyword search.
   */
  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('searchKeyword', [query, filters, limit]);
  }

  /**
   * Quick semantic search.
   */
  async searchSemantic(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('searchSemantic', [query, filters, limit]);
  }

  /**
   * Quick hybrid search.
   */
  async searchHybrid(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    return this.call<SearchResult[]>('searchHybrid', [query, filters, limit]);
  }

  // -------------------------------------------------------------------------
  // Indexing Methods (Proxy to SearchSystem)
  // -------------------------------------------------------------------------

  /**
   * Index all discovered files.
   * Note: Document tracking is done via indexing:progress events, not here,
   * to support long-running indexing with automatic restarts during processing.
   */
  async indexAll(options: IndexAllOptions = {}): Promise<IndexAllResult> {
    if (options.useChildProcess) {
      const result = await this.call<IndexAllResult>('indexAll', [options]);
      await this.checkAndRestartIfNeeded();
      return result;
    }
    return this.runIndexing('indexAll', options);
  }

  /**
   * Index a single file.
   */
  async indexFile(filePath: string): Promise<boolean> {
    const result = await this.call<boolean>('indexFile', [filePath]);

    if (result) {
      this.state.documentsProcessedSinceRestart++;
      this.state.totalDocumentsProcessed++;
      await this.checkAndRestartIfNeeded();
    }

    return result;
  }

  /**
   * Reindex a file (delete and re-process).
   */
  async reindexFile(filePath: string): Promise<boolean> {
    return this.call<boolean>('reindexFile', [filePath]);
  }

  /**
   * Discover files to index.
   */
  async discoverFiles(): Promise<DiscoveredFile[]> {
    return this.call<DiscoveredFile[]>('discoverFiles', []);
  }

  /**
   * Queue files for indexing.
   */
  async queueFiles(
    filePaths: string[],
    priority?: QueuePriority,
  ): Promise<void> {
    return this.call<void>('queueFiles', [filePaths, priority]);
  }

  /**
   * Start processing queued items.
   */
  startProcessing(): void {
    if (this.indexing) return;
    void this.processQueue().catch((error: unknown) => {
      void this.emit('supervisor:error', {
        error: error instanceof Error ? error.message : String(error),
        fatal: false,
      });
    });
  }

  /**
   * Stop processing.
   */
  async stopProcessing(): Promise<void> {
    this.indexingCancelled = true;
    return this.call<void>('stopProcessing', []);
  }

  /**
   * Check if the indexing pipeline is idle.
   * Used by SearchService to wait for processing to complete.
   */
  async isProcessingIdle(): Promise<boolean> {
    return this.call<boolean>('isProcessingIdle', []);
  }

  /**
   * Process items already in the queue with proper event emission.
   * Use this to resume processing after a restart.
   */
  async processQueue(
    options: { maxDocuments?: number } = {},
  ): Promise<IndexAllResult> {
    return this.runIndexing('processQueue', options);
  }

  /** Restart only between completed batches, then resume the persisted queue. */
  private async runIndexing(
    method: 'indexAll' | 'processQueue',
    options: IndexAllOptions,
  ): Promise<IndexAllResult> {
    if (this.indexing) throw new Error('Indexing already in progress');
    if (
      options.maxDocuments !== undefined &&
      (!Number.isSafeInteger(options.maxDocuments) || options.maxDocuments <= 0)
    ) {
      throw new Error('maxDocuments must be a positive integer');
    }
    this.indexing = true;
    this.indexingCancelled = false;
    const started = Date.now();
    let indexed = 0;
    let failed = 0;
    try {
      const bounded =
        this.supervisorConfig.strategy !== 'none' &&
        this.supervisorConfig.restartThreshold > 0;
      let nextMethod = method;
      while (!this.closing && !this.indexingCancelled) {
        const remaining = (options.maxDocuments ?? Infinity) - indexed - failed;
        const batchSize = bounded
          ? Math.min(remaining, this.supervisorConfig.restartThreshold)
          : remaining;
        const result = await this.call<IndexAllResult>(nextMethod, [
          {
            ...options,
            // The supervisor already owns process lifetime and memory recovery.
            useChildProcess: false,
            maxDocuments: Number.isFinite(batchSize) ? batchSize : undefined,
          },
        ]);
        indexed += result.indexed;
        failed += result.failed;
        if (!this.indexingCancelled) await this.checkAndRestartIfNeeded();
        if (
          this.closing ||
          this.indexingCancelled ||
          indexed + failed >= (options.maxDocuments ?? Infinity)
        )
          break;
        const queue = await this.getQueueStatus();
        if (queue.pending === 0 || result.indexed + result.failed === 0) break;
        nextMethod = 'processQueue';
      }
      return { indexed, failed, duration: Date.now() - started };
    } finally {
      this.indexing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Status Methods (Proxy to SearchSystem)
  // -------------------------------------------------------------------------

  /**
   * Get search system statistics.
   */
  async getStats(): Promise<SearchStats> {
    return this.call<SearchStats>('getStats', []);
  }

  /**
   * Get queue status.
   */
  async getQueueStatus(): Promise<QueueStatus> {
    return this.call<QueueStatus>('getQueueStatus', []);
  }

  /**
   * Get queue status with precision metadata and deferred reason breakdown.
   */
  async getQueueDetailedStatus(): Promise<QueueDetailedStatus> {
    return this.call<QueueDetailedStatus>('getQueueDetailedStatus', []);
  }

  /**
   * Get current system state (synchronous version for compatibility).
   */
  getSearchSystemState(): {
    initialized: boolean;
    rootPath: string;
    databasePath: string;
    indexingInProgress: boolean;
    ocrEnabled: boolean;
    ocrAvailable: boolean;
  } {
    // This is synchronous, so we can't proxy to child process
    // Return cached/derived state
    return {
      initialized: this.state.isReady,
      rootPath: this.rootPath,
      databasePath: this.databasePath,
      indexingInProgress: this.indexing,
      ocrEnabled: this.config.ocr.enabled,
      ocrAvailable: false, // Would need to track this
    };
  }

  /**
   * Get current system state (synchronous - returns cached/derived state).
   * Note: For child-process strategy, some fields may not reflect real-time values.
   */
  getState(): SearchSystemState {
    // Return synchronous state based on cached/known values
    // This maintains API compatibility with SearchSystem.getState()
    return {
      initialized: this.state.isReady,
      rootPath: this.rootPath,
      databasePath: this.databasePath,
      indexingInProgress: this.indexing,
      ocrEnabled: this.config.ocr.enabled,
      ocrAvailable: false, // Would need to track this separately
    };
  }

  /**
   * Get OCR queue status (synchronous).
   * Note: For child-process strategy, this returns null as we don't track OCR state.
   */
  getOcrQueueStatus(): OcrQueueStatus | null {
    // For supervisor, we don't track OCR queue state directly
    // Return null - callers should check if running in supervisor mode
    return null;
  }

  /**
   * Get a document by ID.
   */
  async getDocument(documentId: string): Promise<Document | null> {
    return this.call<Document | null>('getDocument', [documentId]);
  }

  /**
   * Get a document by file path.
   */
  async getDocumentByPath(filePath: string): Promise<Document | null> {
    return this.call<Document | null>('getDocumentByPath', [filePath]);
  }

  /**
   * Get all chunks for a document.
   */
  async getDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
    return this.call<DocumentChunk[]>('getDocumentChunks', [documentId]);
  }

  // -------------------------------------------------------------------------
  // Supervisor-Specific Methods
  // -------------------------------------------------------------------------

  /**
   * Get supervisor state.
   */
  getSupervisorState(): SupervisorState {
    return {
      ...this.state,
      currentMemoryMb: this.strategy?.getMemoryUsageMb() ?? getMemoryUsageMb(),
      childPid: this.strategy?.getChildPid() ?? null,
    };
  }

  /**
   * Force a restart of the SearchSystem.
   */
  async forceRestart(reason: string = 'Manual restart'): Promise<void> {
    await this.performRestart(reason);
  }

  /**
   * Update the restart threshold.
   */
  setRestartThreshold(threshold: number): void {
    this.supervisorConfig.restartThreshold = threshold;
    // console.log(`[SearchSystemSupervisor] Restart threshold set to ${threshold}`);
  }

  /**
   * Get the current configuration.
   */
  getConfigValue<T>(key: string): Promise<T | null> {
    return this.call<T | null>('getConfigValue', [key]);
  }

  getConfig(): SearchSystemConfig {
    return { ...this.config };
  }

  /**
   * Get the supervisor configuration.
   */
  getSupervisorConfig(): SupervisorConfig {
    return { ...this.supervisorConfig };
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Create a restart strategy based on configuration.
   */
  private createStrategy(strategyType: SupervisorStrategy): RestartStrategy {
    switch (strategyType) {
      case 'child-process':
        return new ChildProcessStrategy();
      case 'in-process':
      case 'none':
      default:
        return new InProcessStrategy();
    }
  }

  /**
   * Subscribe to strategy events and forward them.
   * Also tracks document progress for automatic restart triggering.
   */
  private subscribeToStrategyEvents(): void {
    if (!this.strategy) return;

    // Forward all events from strategy
    const events: Array<keyof SupervisorEvents> = [
      'search:started',
      'search:completed',
      'indexing:started',
      'indexing:progress',
      'indexing:completed',
      'ocr:started',
      'ocr:progress',
      'ocr:completed',
      'ocr:failed',
    ];

    for (const event of events) {
      this.strategy.onEvent(event, (data) => {
        // Track document progress for restart threshold
        if (event === 'indexing:progress') {
          const progress = data as { current: number; total: number };
          const delta = progress.current - this.lastProgressCurrent;

          if (delta > 0) {
            this.state.documentsProcessedSinceRestart += delta;
            this.state.totalDocumentsProcessed += delta;
            this.lastProgressCurrent = progress.current;

            // The caller checks restart thresholds at the next batch boundary.
          }
        }

        // Reset progress counter on indexing:completed
        if (event === 'indexing:completed') {
          this.lastProgressCurrent = 0;
        }

        // Forward the event
        void this.emit(event, data);
      });
    }
  }

  /**
   * Check if restart is needed and perform it if so.
   */
  private async checkAndRestartIfNeeded(): Promise<void> {
    // Skip if restart is disabled
    if (
      this.closing ||
      this.config.database.inMemory ||
      this.state.status !== 'running' ||
      this.supervisorConfig.strategy === 'none' ||
      this.supervisorConfig.restartThreshold <= 0
    ) {
      return;
    }

    // Check document threshold
    if (
      this.state.documentsProcessedSinceRestart >=
      this.supervisorConfig.restartThreshold
    ) {
      await this.performRestart(
        `Threshold reached: ${this.state.documentsProcessedSinceRestart} documents`,
      );
      // Reset consecutive memory restart counter after successful document-based restart
      // (uncomment if using restart loop protection)
      // this.consecutiveMemoryRestarts = 0;
      return;
    }

    // Check memory threshold
    const currentMemoryMb =
      this.strategy?.getMemoryUsageMb() ?? getMemoryUsageMb();
    if (currentMemoryMb >= this.supervisorConfig.memoryThresholdMb) {
      void this.emit('supervisor:memory:warning', {
        currentMb: currentMemoryMb,
        thresholdMb: this.supervisorConfig.memoryThresholdMb,
      });
      await this.performRestart(
        `Memory threshold reached: ${currentMemoryMb}MB`,
      );

      // Reset consecutive counter after successful document-based restart
      // (uncomment if using restart loop protection)
      // Note: This reset should happen after document threshold restarts, not memory restarts
    }
  }

  /**
   * Perform a restart of the SearchSystem.
   */
  private performRestart(reason: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.restartPromise) return this.restartPromise;
    this.restartPromise = this.restart(reason).finally(() => {
      this.restartPromise = null;
    });
    return this.restartPromise;
  }

  private async restart(reason: string): Promise<void> {
    if (!this.strategy || this.state.status === 'restarting') {
      return;
    }

    const memoryBefore = this.strategy.getMemoryUsageMb();
    const startTime = Date.now();

    this.state.status = 'restarting';
    void this.emit('supervisor:restart:starting', {
      reason,
      documentsProcessed: this.state.documentsProcessedSinceRestart,
      memoryMb: memoryBefore,
    });

    // console.log(`[SearchSystemSupervisor] Restarting: ${reason} (memory: ${memoryBefore}MB)`);

    try {
      await this.strategy.restart(reason);
      if (this.closing) return;

      // Reset counters for fresh start
      this.state.documentsProcessedSinceRestart = 0;
      this.lastProgressCurrent = 0; // Reset progress tracker for new SearchSystem
      this.state.restartCount++;
      this.state.lastRestartAt = new Date();
      this.state.status = 'running';
      this.state.error = null;

      const memoryAfter = this.strategy.getMemoryUsageMb();
      const durationMs = Date.now() - startTime;

      void this.emit('supervisor:restart:completed', {
        restartCount: this.state.restartCount,
        durationMs,
        memoryBeforeMb: memoryBefore,
        memoryAfterMb: memoryAfter,
      });

      // console.log(`[SearchSystemSupervisor] Restart #${this.state.restartCount} complete (memory: ${memoryBefore}MB → ${memoryAfter}MB, duration: ${durationMs}ms)`);
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);

      void this.emit('supervisor:error', {
        error: this.state.error,
        fatal: true,
      });

      console.error(
        '[SearchSystemSupervisor] Restart failed:',
        this.state.error,
      );
      throw error;
    }
  }

  /**
   * Call a method on the SearchSystem via the strategy.
   */
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    if (this.closing) throw new Error('Supervisor is stopping');
    if (this.restartPromise) await this.restartPromise;
    if (this.closing || !this.strategy || !this.state.isReady) {
      throw new Error('Supervisor not ready');
    }

    return this.strategy.call<T>(method, args);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new SearchSystem supervisor.
 */
export async function createSearchSystemSupervisor(
  options: SupervisorInitOptions,
): Promise<SearchSystemSupervisor> {
  return SearchSystemSupervisor.create(options);
}
