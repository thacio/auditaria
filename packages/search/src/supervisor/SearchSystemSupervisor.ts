/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: SearchSystem Supervisor
// Main supervisor class that wraps SearchSystem with automatic restart capabilities.
// Provides the same API as SearchSystem, delegating to a restart strategy.

/* eslint-disable no-console */

import { join } from 'node:path';
import { EventEmitter } from '../core/EventEmitter.js';
import type { SearchSystemConfig, DeepPartial, SupervisorStrategy } from '../config.js';
import { createConfig } from '../config.js';
import type {
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchStats,
  QueueStatus,
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
  DEFAULT_SUPERVISOR_CONFIG,
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
  private config: SearchSystemConfig;
  private supervisorConfig: SupervisorConfig;
  private state: SupervisorState = { ...INITIAL_SUPERVISOR_STATE };
  private rootPath: string;
  private databasePath: string;

  // Track last progress for delta calculation (must be class property to reset on restart)
  private lastProgressCurrent: number = 0;

  // Restart loop protection (commented out - enable if needed)
  // private lastMemoryRestartAt: number = 0;
  // private consecutiveMemoryRestarts: number = 0;
  // private static readonly MIN_RESTART_COOLDOWN_MS = 60000; // 1 minute
  // private static readonly MAX_CONSECUTIVE_MEMORY_RESTARTS = 3;

  private constructor(
    rootPath: string,
    config: SearchSystemConfig,
    supervisorConfig: SupervisorConfig,
  ) {
    super();
    this.rootPath = rootPath;
    this.config = config;
    this.supervisorConfig = supervisorConfig;
    this.databasePath = join(rootPath, config.database.path);
  }

  // -------------------------------------------------------------------------
  // Static Factory Methods
  // -------------------------------------------------------------------------

  /**
   * Create and initialize a new supervisor.
   */
  static async create(options: SupervisorInitOptions): Promise<SearchSystemSupervisor> {
    const config = createConfig(options.config);
    const supervisorConfig = createSupervisorConfig(
      config.indexing,
      options.supervisorConfig,
    );

    const supervisor = new SearchSystemSupervisor(
      options.rootPath,
      config,
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
    void this.emit('supervisor:starting', { strategy: this.supervisorConfig.strategy });

    // console.log(`[SearchSystemSupervisor] Initializing with strategy: ${this.supervisorConfig.strategy}`);

    // Create the appropriate strategy
    this.strategy = this.createStrategy(this.supervisorConfig.strategy);

    // Initialize the strategy
    await this.strategy.initialize(
      this.rootPath,
      this.databasePath,
      this.config,
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
  async close(): Promise<void> {
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
    return this.call<IndexAllResult>('indexAll', [options]);
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
  async queueFiles(filePaths: string[], priority?: QueuePriority): Promise<void> {
    return this.call<void>('queueFiles', [filePaths, priority]);
  }

  /**
   * Start processing queued items.
   */
  startProcessing(): void {
    void this.call<void>('startProcessing', []);
  }

  /**
   * Stop processing.
   */
  async stopProcessing(): Promise<void> {
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
  async processQueue(): Promise<{ indexed: number; failed: number; duration: number }> {
    return this.call<{ indexed: number; failed: number; duration: number }>('processQueue', []);
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
      indexingInProgress: false, // Would need to track this
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
      indexingInProgress: false, // Would need to track this separately
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

            // Check if restart is needed (async, don't await)
            void this.checkAndRestartIfNeeded();
          }
        }

        // Reset progress counter on indexing:completed
        if (event === 'indexing:completed') {
          this.lastProgressCurrent = 0;
        }

        // Forward the event
        void this.emit(event, data as SupervisorEvents[typeof event]);
      });
    }
  }

  /**
   * Check if restart is needed and perform it if so.
   */
  private async checkAndRestartIfNeeded(): Promise<void> {
    // Skip if restart is disabled
    if (
      this.supervisorConfig.strategy === 'none' ||
      this.supervisorConfig.restartThreshold <= 0
    ) {
      return;
    }

    // Check document threshold
    if (
      this.state.documentsProcessedSinceRestart >= this.supervisorConfig.restartThreshold
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
    const currentMemoryMb = this.strategy?.getMemoryUsageMb() ?? getMemoryUsageMb();
    if (currentMemoryMb >= this.supervisorConfig.memoryThresholdMb) {
      // RESTART LOOP PROTECTION (uncomment if experiencing continuous restarts)
      // Prevents restart loops when memory is naturally high (e.g., large embedding model)
      // const now = Date.now();
      // const timeSinceLastRestart = now - this.lastMemoryRestartAt;
      //
      // // Enforce minimum cooldown between memory-based restarts
      // if (timeSinceLastRestart < SearchSystemSupervisor.MIN_RESTART_COOLDOWN_MS) {
      //   return; // Too soon since last restart, skip
      // }
      //
      // // Check if we've exceeded max consecutive memory restarts
      // if (this.consecutiveMemoryRestarts >= SearchSystemSupervisor.MAX_CONSECUTIVE_MEMORY_RESTARTS) {
      //   console.warn(
      //     `[SearchSystemSupervisor] Memory threshold exceeded but max restarts (${SearchSystemSupervisor.MAX_CONSECUTIVE_MEMORY_RESTARTS}) reached. ` +
      //     `Memory may be naturally high. Disabling memory-based restarts for this session.`
      //   );
      //   return;
      // }
      //
      // this.lastMemoryRestartAt = now;
      // this.consecutiveMemoryRestarts++;

      void this.emit('supervisor:memory:warning', {
        currentMb: currentMemoryMb,
        thresholdMb: this.supervisorConfig.memoryThresholdMb,
      });
      await this.performRestart(`Memory threshold reached: ${currentMemoryMb}MB`);

      // Reset consecutive counter after successful document-based restart
      // (uncomment if using restart loop protection)
      // Note: This reset should happen after document threshold restarts, not memory restarts
    }
  }

  /**
   * Perform a restart of the SearchSystem.
   */
  private async performRestart(reason: string): Promise<void> {
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

      console.error('[SearchSystemSupervisor] Restart failed:', this.state.error);
      throw error;
    }
  }

  /**
   * Call a method on the SearchSystem via the strategy.
   */
  private async call<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.strategy || !this.state.isReady) {
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
