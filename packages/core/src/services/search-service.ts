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

  // AUDITARIA: Lifecycle operations join in-flight work instead of polling flags.
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private syncPromise: Promise<void> | null = null;
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
      const inst = SearchServiceManager.instance;
      inst.stopQueueProcessor();
      void inst.stop();
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
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) {
      await this.startPromise;
    }
    if (this.state.status === 'running') {
      if (this.state.rootPath !== rootPath)
        throw new Error(
          'Search service is already running for another workspace',
        );
      if (options.startIndexing) this.enableIndexing();
      return;
    }
    this.startPromise = this.startService(rootPath, options).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startService(
    rootPath: string,
    options: SearchServiceStartOptions,
  ): Promise<void> {
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
      this.stopQueueProcessor();
      await this.searchSystem?.close().catch(() => undefined);
      this.searchSystem = null;
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
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.startPromise && this.state.status === 'stopped')
      return Promise.resolve();
    this.stopPromise = this.stopService().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  private async stopService(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
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
        await this.syncPromise?.catch(() => undefined);
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
      return this.searchSystem.getSupervisorState();
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

  private async checkAutoIndexConfig(): Promise<boolean> {
    return (
      (await this.searchSystem?.getConfigValue<boolean>('autoIndex')) === true
    );
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
    if (
      !this.searchSystem ||
      this.isProcessingQueue ||
      this.state.status !== 'running'
    )
      return;
    this.isProcessingQueue = true;
    const system = this.searchSystem;

    try {
      const queueStatus = await system.getQueueStatus();

      if (queueStatus.pending > 0) {
        this.isProcessingQueue = true;

        // Use processQueue() to process items already in the queue
        // This properly emits indexing:progress events for supervisor auto-restart tracking
        if (this.state.status !== 'running') return;
        const result = await system.processQueue();

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
    } finally {
      this.isProcessingQueue = false;
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
  private performSync(force: boolean): Promise<void> {
    this.syncPromise ??= this.syncFiles(force).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async syncFiles(force: boolean): Promise<void> {
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

      // SearchSystem owns discovery, queue recovery, and processing. Scanning here
      // duplicated all I/O and skipped deletions when the directory became empty.
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
