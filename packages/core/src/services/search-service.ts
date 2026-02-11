/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 * @license
 */

/* eslint-disable no-console */

// AUDITARIA_LOCAL_SEARCH - Search Service Manager
// Singleton service that maintains a persistent SearchSystem instance
// with background indexing capabilities.
// AUDITARIA_FEATURE: Integrated with SearchSystemSupervisor for automatic memory management.

import type {
  SearchSystem,
  SearchSystemSupervisor,
  SupervisorState,
} from '@thacio/auditaria-search';

// ============================================================================
// Types
// ============================================================================

export interface SearchServiceState {
  status: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  rootPath: string | null;
  startedAt: Date | null;
  lastSyncAt: Date | null;
  error: string | null;
}

export interface IndexingProgress {
  status:
    | 'idle'
    | 'discovering'
    | 'syncing'
    | 'indexing'
    | 'completed'
    | 'failed';
  totalFiles: number;
  processedFiles: number;
  failedFiles: number;
  currentFile: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}

export interface SearchServiceStartOptions {
  /** Force full reindex even if index exists */
  forceReindex?: boolean;
  /** Skip initial sync (for faster startup) */
  skipInitialSync?: boolean;
  /** Explicitly start indexing for this session (used by /knowledge-base init) */
  startIndexing?: boolean;
}

// ============================================================================
// SearchServiceManager - Singleton
// ============================================================================

/**
 * Singleton service manager for the search system.
 * Maintains a persistent SearchSystem instance with:
 * - Background queue processing
 * - Concurrent search during indexing
 */
export class SearchServiceManager {
  private static instance: SearchServiceManager;

  // AUDITARIA_FEATURE: Can be either SearchSystem directly or SearchSystemSupervisor wrapper
  private searchSystem: SearchSystem | SearchSystemSupervisor | null = null;
  private state: SearchServiceState = {
    status: 'stopped',
    rootPath: null,
    startedAt: null,
    lastSyncAt: null,
    error: null,
  };
  private indexingProgress: IndexingProgress = {
    status: 'idle',
    totalFiles: 0,
    processedFiles: 0,
    failedFiles: 0,
    currentFile: null,
    startedAt: null,
    completedAt: null,
    lastError: null,
  };

  private queueProcessorInterval: ReturnType<typeof setInterval> | null = null;
  private eventUnsubscribers: Array<() => void> = [];
  private isProcessingQueue: boolean = false;

  // AUDITARIA: Set to true to silence SearchService info/debug console output
  private static SILENT_MODE = true;

  // Helper to conditionally log (info/debug are silenced, errors always show)
  private log(...args: unknown[]): void {
    if (!SearchServiceManager.SILENT_MODE) console.log(...args);
  }
  private warn(...args: unknown[]): void {
    if (!SearchServiceManager.SILENT_MODE) console.warn(...args);
  }
  private error(...args: unknown[]): void {
    console.error(...args); // Errors always show regardless of SILENT_MODE
  }

  // -------------------------------------------------------------------------
  // Singleton
  // -------------------------------------------------------------------------

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): SearchServiceManager {
    if (!SearchServiceManager.instance) {
      SearchServiceManager.instance = new SearchServiceManager();
    }
    return SearchServiceManager.instance;
  }

  /**
   * Reset the singleton instance (for testing only)
   */
  static resetInstance(): void {
    if (SearchServiceManager.instance) {
      // Force stop if running
      const inst = SearchServiceManager.instance;
      if (inst.searchSystem) {
        inst.searchSystem.close().catch(() => {});
      }
      SearchServiceManager.instance =
        undefined as unknown as SearchServiceManager;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the search service.
   * Initializes or loads the SearchSystem.
   */
  async start(
    rootPath: string,
    options: SearchServiceStartOptions = {},
  ): Promise<void> {
    if (this.state.status === 'running') {
      this.log('[SearchService] Already running');
      return;
    }

    if (this.state.status === 'starting') {
      this.log('[SearchService] Already starting');
      return;
    }

    this.state.status = 'starting';
    this.state.rootPath = rootPath;
    this.state.error = null;

    try {
      const {
        createSearchSystemSupervisor,
        createConfig,
        searchDatabaseExists,
      } = await import('@thacio/auditaria-search');

      const dbExists = searchDatabaseExists(rootPath);

      // IMPORTANT: Do NOT call createConfig() here and pass it to the supervisor!
      // SearchSystem.initialize() will load user config from knowledge-base.config.json
      // and merge it properly with defaults. If we pass a full config here,
      // it will override the user's preferences.
      // We only need createConfig() for logging the supervisor strategy.
      const defaultConfig = createConfig();

      this.log(`[SearchService] Starting... (dbExists: ${dbExists})`);
      this.log(
        `[SearchService] Supervisor strategy: ${defaultConfig.indexing.supervisorStrategy}, ` +
          `restart threshold: ${defaultConfig.indexing.supervisorRestartThreshold}`,
      );

      // Logging configuration - enabled, file only (no console), debug level
      const loggingOptions = {
        enabled: true,
        level: 'debug' as const,
        console: false, // Disable console logging
        // filePath defaults to .auditaria/search.log
        includeMemory: true,
      };

      // AUDITARIA_FEATURE: Use SearchSystemSupervisor for automatic memory management
      // The supervisor wraps SearchSystem and automatically restarts it after N documents
      // to prevent memory bloat from WASM, embedder models, and other resources.
      // Note: Do NOT pass a full config here - let SearchSystem load user config properly.
      this.log('[SearchService] Initializing with supervisor...');
      this.searchSystem = await createSearchSystemSupervisor({
        rootPath,
        // config is intentionally omitted - SearchSystem.initialize() will load
        // user config from .auditaria/knowledge-base.config.json with proper priority
        logging: loggingOptions,
      });

      // Reset any stuck queue items from previous crash
      await this.resetStaleQueueItems();

      // Subscribe to search system events
      this.subscribeToEvents();

      // Check if we should auto-index:
      // - startIndexing: true = explicitly requested (from /knowledge-base init)
      // - autoIndex config = persistent setting in database
      const shouldIndex =
        options.startIndexing === true || (await this.checkAutoIndexConfig());

      // Only start queue processor if indexing is enabled
      if (shouldIndex) {
        this.startQueueProcessor();
      }

      this.state.status = 'running';
      this.state.startedAt = new Date();
      this.log(
        `[SearchService] Started successfully (indexing: ${shouldIndex ? 'enabled' : 'disabled'})`,
      );

      // Perform initial sync only if indexing and not skipped
      if (shouldIndex && !options.skipInitialSync) {
        // Run sync in background, don't block startup
        this.performInitialSync(options.forceReindex ?? false).catch((err) => {
          this.warn('[SearchService] Initial sync failed:', err.message);
        });
      }
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      this.error('[SearchService] Failed to start:', this.state.error);
      throw error;
    }
  }

  /**
   * Stop the search service.
   * Cleans up all resources and closes the SearchSystem.
   */
  async stop(): Promise<void> {
    if (this.state.status === 'stopped') {
      return;
    }

    if (this.state.status === 'stopping') {
      // Wait for stop to complete
      while (this.state.status === 'stopping') {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return;
    }

    this.state.status = 'stopping';
    this.log('[SearchService] Stopping...');

    try {
      // Stop queue processor
      this.stopQueueProcessor();

      // Unsubscribe from events
      for (const unsub of this.eventUnsubscribers) {
        unsub();
      }
      this.eventUnsubscribers = [];

      // Close search system
      if (this.searchSystem) {
        await this.searchSystem.close();
        this.searchSystem = null;
      }

      this.state.status = 'stopped';
      this.state.startedAt = null;
      this.log('[SearchService] Stopped');
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      this.error('[SearchService] Error during stop:', this.state.error);
    }
  }

  // -------------------------------------------------------------------------
  // State Access
  // -------------------------------------------------------------------------

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  /**
   * Check if the indexing service is enabled (queue processor running).
   * This is true when /knowledge-base init was run or auto-index is enabled.
   * The indexing service handles background file watching and queue processing.
   */
  isIndexingEnabled(): boolean {
    return this.queueProcessorInterval !== null;
  }

  /**
   * Enable the indexing service if not already enabled.
   * This starts the queue processor for background indexing.
   * Use this when the service is already running but indexing wasn't initially enabled.
   */
  enableIndexing(): void {
    if (this.queueProcessorInterval) {
      this.log('[SearchService] Indexing already enabled');
      return;
    }
    if (this.state.status !== 'running') {
      this.log('[SearchService] Cannot enable indexing - service not running');
      return;
    }
    this.startQueueProcessor();
    this.log('[SearchService] Indexing enabled');
  }

  getState(): SearchServiceState {
    return { ...this.state };
  }

  getIndexingProgress(): IndexingProgress {
    return { ...this.indexingProgress };
  }

  /**
   * Get the shared SearchSystem instance (or SearchSystemSupervisor wrapper).
   * Returns null if service is not running.
   */
  getSearchSystem(): SearchSystem | SearchSystemSupervisor | null {
    return this.searchSystem;
  }

  /**
   * Get supervisor state if using SearchSystemSupervisor.
   * Returns null if not using supervisor or service not running.
   */
  getSupervisorState(): SupervisorState | null {
    if (!this.searchSystem) return null;
    // Check if it's a supervisor by looking for getSupervisorState method
    if ('getSupervisorState' in this.searchSystem) {
      return (this.searchSystem).getSupervisorState();
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  /**
   * Trigger a sync operation to discover and index new/modified files.
   */
  async triggerSync(options: { force?: boolean } = {}): Promise<void> {
    if (!this.searchSystem) {
      throw new Error('Search service not running');
    }

    if (
      this.indexingProgress.status === 'indexing' ||
      this.indexingProgress.status === 'syncing' ||
      this.indexingProgress.status === 'discovering'
    ) {
      this.log('[SearchService] Sync already in progress');
      return;
    }

    await this.performSync(options.force ?? false);
  }

  /**
   * Reindex a specific file.
   */
  async reindexFile(filePath: string): Promise<boolean> {
    if (!this.searchSystem) {
      throw new Error('Search service not running');
    }

    try {
      const result = await this.searchSystem.reindexFile(filePath);
      return result;
    } catch (error) {
      this.error('[SearchService] Reindex failed:', error);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Reset queue items stuck in 'processing' state from previous crash.
   */
  private async resetStaleQueueItems(): Promise<void> {
    if (!this.searchSystem) return;

    try {
      // Access storage directly to reset stale items
      const storage = (
        this.searchSystem as unknown as {
          storage: { execute: (sql: string) => Promise<void> };
        }
      ).storage;
      if (storage && typeof storage.execute === 'function') {
        await storage.execute(`
          UPDATE index_queue
          SET status = 'pending', started_at = NULL
          WHERE status = 'processing'
        `);
        this.log('[SearchService] Reset stale queue items');
      }
    } catch (error) {
      // Non-fatal, just log
      this.warn('[SearchService] Could not reset stale items:', error);
    }
  }

  /**
   * Check if auto-indexing is enabled in the database config.
   * Returns true if autoIndex config is explicitly set to true.
   */
  private async checkAutoIndexConfig(): Promise<boolean> {
    if (!this.searchSystem) return false;

    try {
      // Access storage to get config value (same pattern as resetStaleQueueItems)
      const storage = (
        this.searchSystem as unknown as {
          storage: { getConfigValue: <T>(key: string) => Promise<T | null> };
        }
      ).storage;

      if (storage && typeof storage.getConfigValue === 'function') {
        const autoIndex = await storage.getConfigValue<boolean>('autoIndex');
        return autoIndex === true;
      }
    } catch {
      // Non-fatal, default to false
    }
    return false;
  }

  /**
   * Subscribe to SearchSystem events.
   */
  private subscribeToEvents(): void {
    if (!this.searchSystem) return;

    // Indexing progress
    const unsubProgress = this.searchSystem.on(
      'indexing:progress',
      (event: { current: number; total: number }) => {
        this.indexingProgress.processedFiles = event.current;
        this.indexingProgress.totalFiles = event.total;
      },
    );
    this.eventUnsubscribers.push(unsubProgress);

    // Indexing completed
    const unsubCompleted = this.searchSystem.on(
      'indexing:completed',
      (event: { indexed: number; failed: number; duration: number }) => {
        this.indexingProgress.status = 'completed';
        this.indexingProgress.processedFiles = event.indexed;
        this.indexingProgress.failedFiles = event.failed;
        this.indexingProgress.completedAt = new Date();
        this.state.lastSyncAt = new Date();
        this.log(
          `[SearchService] Indexing completed: ${event.indexed} indexed, ${event.failed} failed (${event.duration}ms)`,
        );
      },
    );
    this.eventUnsubscribers.push(unsubCompleted);

    // AUDITARIA_FEATURE: Supervisor restart events (memory management)
    // These events are only emitted when using SearchSystemSupervisor
    // Use type assertion to handle supervisor-specific events
    const _searchSystemAny = this.searchSystem as unknown as {
      on: (event: string, handler: (data: unknown) => void) => () => void;
    };

    // NOTE: Supervisor event logging disabled to test if console output causes memory leak
    // const unsubRestartStarting = searchSystemAny.on(
    //   'supervisor:restart:starting',
    //   (data: unknown) => {
    //     const event = data as {
    //       reason: string;
    //       documentsProcessed: number;
    //       memoryMb: number;
    //     };
    //     console.log(
    //       `[SearchService] Supervisor restarting: ${event.reason} ` +
    //         `(docs: ${event.documentsProcessed}, memory: ${event.memoryMb}MB)`,
    //     );
    //   },
    // );
    // this.eventUnsubscribers.push(unsubRestartStarting);

    // const unsubRestartCompleted = searchSystemAny.on(
    //   'supervisor:restart:completed',
    //   (data: unknown) => {
    //     const event = data as {
    //       restartCount: number;
    //       durationMs: number;
    //       memoryBeforeMb: number;
    //       memoryAfterMb: number;
    //     };
    //     const memoryFreed = event.memoryBeforeMb - event.memoryAfterMb;
    //     console.log(
    //       `[SearchService] Supervisor restart #${event.restartCount} complete: ` +
    //         `${event.memoryBeforeMb}MB → ${event.memoryAfterMb}MB (freed ${memoryFreed}MB, took ${event.durationMs}ms)`,
    //     );
    //   },
    // );
    // this.eventUnsubscribers.push(unsubRestartCompleted);
  }

  /**
   * Start the queue processor interval.
   */
  private startQueueProcessor(): void {
    if (this.queueProcessorInterval) return;

    // Process queue every 10 seconds (increased from 5 to reduce overhead)
    this.queueProcessorInterval = setInterval(() => {
      this.processQueueIfNeeded().catch(() => {
        // Silently ignore errors - they're expected during active indexing
      });
    }, 10000);

    this.log('[SearchService] Queue processor started');
  }

  /**
   * Stop the queue processor interval.
   */
  private stopQueueProcessor(): void {
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval);
      this.queueProcessorInterval = null;
      this.log('[SearchService] Queue processor stopped');
    }
  }

  /**
   * Check queue and process items if needed.
   */
  private async processQueueIfNeeded(): Promise<void> {
    // Skip if already processing (either via queue processor or via indexAll/performSync)
    if (!this.searchSystem || this.isProcessingQueue) return;

    try {
      const queueStatus = await this.searchSystem.getQueueStatus();

      if (queueStatus.pending > 0) {
        this.isProcessingQueue = true;

        // Use processQueue() to process items already in the queue
        // This properly emits indexing:progress events for supervisor auto-restart tracking
        const result = await (
          this.searchSystem as unknown as {
            processQueue: () => Promise<{
              indexed: number;
              failed: number;
              duration: number;
            }>;
          }
        ).processQueue();

        // Update progress
        this.indexingProgress.processedFiles = result.indexed;
        this.indexingProgress.failedFiles = result.failed;
        this.indexingProgress.status = 'completed';
        this.indexingProgress.completedAt = new Date();
        this.state.lastSyncAt = new Date();

        this.isProcessingQueue = false;
      }
    } catch (error) {
      this.isProcessingQueue = false;
      // Only log if it's not the expected "already in progress" error during sync
      if (
        !(
          error instanceof Error &&
          error.message.includes('already in progress')
        )
      ) {
        this.warn('[SearchService] Queue check failed:', error);
      }
    }
  }

  /**
   * Perform initial sync on startup.
   */
  private async performInitialSync(force: boolean): Promise<void> {
    await this.performSync(force);
  }

  /**
   * Perform a sync operation.
   */
  private async performSync(force: boolean): Promise<void> {
    if (!this.searchSystem) return;

    // Prevent queue processor from interfering during sync
    this.isProcessingQueue = true;

    try {
      this.log('[SearchService] Starting sync...');

      // Update progress
      this.indexingProgress.status = 'syncing';
      this.indexingProgress.startedAt = new Date();
      this.indexingProgress.completedAt = null;
      this.indexingProgress.failedFiles = 0;
      this.indexingProgress.processedFiles = 0;

      // Discover files - get count then release array to avoid holding 38k+ objects in memory
      this.indexingProgress.status = 'discovering';
      const fileCount = (await this.searchSystem.discoverFiles()).length;
      this.indexingProgress.totalFiles = fileCount;

      this.log(`[SearchService] Discovered ${fileCount} files`);

      if (fileCount === 0) {
        this.indexingProgress.status = 'completed';
        this.indexingProgress.completedAt = new Date();
        return; // finally block will reset isProcessingQueue
      }

      // Index all files
      this.indexingProgress.status = 'indexing';
      const result = await this.searchSystem.indexAll({ force });

      this.indexingProgress.status = 'completed';
      this.indexingProgress.processedFiles = result.indexed;
      this.indexingProgress.failedFiles = result.failed;
      this.indexingProgress.completedAt = new Date();
      this.state.lastSyncAt = new Date();

      this.log(
        `[SearchService] Sync completed: ${result.indexed} indexed, ${result.failed} failed (${result.duration}ms)`,
      );
    } catch (error) {
      this.indexingProgress.status = 'failed';
      this.indexingProgress.lastError =
        error instanceof Error ? error.message : String(error);
      this.indexingProgress.completedAt = new Date();
      this.error('[SearchService] Sync failed:', error);
      throw error;
    } finally {
      this.isProcessingQueue = false;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Get the SearchServiceManager singleton instance.
 */
export function getSearchService(): SearchServiceManager {
  return SearchServiceManager.getInstance();
}
