/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/* eslint-disable no-console */

// AUDITARIA_LOCAL_SEARCH - Search Service Manager
// Singleton service that maintains a persistent SearchSystem instance
// with background indexing capabilities.

import type { SearchSystem } from '@thacio/search';

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

  private searchSystem: SearchSystem | null = null;
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
      console.log('[SearchService] Already running');
      return;
    }

    if (this.state.status === 'starting') {
      console.log('[SearchService] Already starting');
      return;
    }

    this.state.status = 'starting';
    this.state.rootPath = rootPath;
    this.state.error = null;

    try {
      const { initializeSearchSystem, loadSearchSystem, searchDatabaseExists } =
        await import('@thacio/search');

      const dbExists = searchDatabaseExists(rootPath);

      console.log(`[SearchService] Starting... (dbExists: ${dbExists})`);

      // Logging configuration - enabled, file only (no console), debug level
      const loggingOptions = {
        enabled: true,
        level: 'debug' as const,
        console: false, // Disable console logging
        // filePath defaults to .auditaria/search.log
        includeMemory: true,
      };

      // Initialize or load the search system
      if (dbExists && !options.forceReindex) {
        console.log('[SearchService] Loading existing database...');
        this.searchSystem = await loadSearchSystem(rootPath, {
          useMockEmbedder: false,
          logging: loggingOptions,
        });

        if (!this.searchSystem) {
          // Database exists but failed to load - reinitialize
          console.log('[SearchService] Failed to load, reinitializing...');
          this.searchSystem = await initializeSearchSystem({
            rootPath,
            useMockEmbedder: false,
            logging: loggingOptions,
          });
        }
      } else {
        console.log('[SearchService] Initializing new database...');
        this.searchSystem = await initializeSearchSystem({
          rootPath,
          useMockEmbedder: false,
          logging: loggingOptions,
        });
      }

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
      console.log(
        `[SearchService] Started successfully (indexing: ${shouldIndex ? 'enabled' : 'disabled'})`,
      );

      // Perform initial sync only if indexing and not skipped
      if (shouldIndex && !options.skipInitialSync) {
        // Run sync in background, don't block startup
        this.performInitialSync(options.forceReindex ?? false).catch((err) => {
          console.warn('[SearchService] Initial sync failed:', err.message);
        });
      }
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      console.error('[SearchService] Failed to start:', this.state.error);
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
    console.log('[SearchService] Stopping...');

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
      console.log('[SearchService] Stopped');
    } catch (error) {
      this.state.status = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      console.error('[SearchService] Error during stop:', this.state.error);
    }
  }

  // -------------------------------------------------------------------------
  // State Access
  // -------------------------------------------------------------------------

  isRunning(): boolean {
    return this.state.status === 'running';
  }

  getState(): SearchServiceState {
    return { ...this.state };
  }

  getIndexingProgress(): IndexingProgress {
    return { ...this.indexingProgress };
  }

  /**
   * Get the shared SearchSystem instance.
   * Returns null if service is not running.
   */
  getSearchSystem(): SearchSystem | null {
    return this.searchSystem;
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
      console.log('[SearchService] Sync already in progress');
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
      console.error('[SearchService] Reindex failed:', error);
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
        console.log('[SearchService] Reset stale queue items');
      }
    } catch (error) {
      // Non-fatal, just log
      console.warn('[SearchService] Could not reset stale items:', error);
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
        console.log(
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

    // Process queue every 5 seconds
    this.queueProcessorInterval = setInterval(() => {
      this.processQueueIfNeeded().catch((err) => {
        console.warn('[SearchService] Queue processing error:', err.message);
      });
    }, 5000);

    console.log('[SearchService] Queue processor started');
  }

  /**
   * Stop the queue processor interval.
   */
  private stopQueueProcessor(): void {
    if (this.queueProcessorInterval) {
      clearInterval(this.queueProcessorInterval);
      this.queueProcessorInterval = null;
      console.log('[SearchService] Queue processor stopped');
    }
  }

  /**
   * Check queue and process items if needed.
   */
  private async processQueueIfNeeded(): Promise<void> {
    if (!this.searchSystem || this.isProcessingQueue) return;

    try {
      const queueStatus = await this.searchSystem.getQueueStatus();

      if (queueStatus.pending > 0) {
        this.isProcessingQueue = true;

        console.log(
          `[SearchService] Processing ${queueStatus.pending} queued items...`,
        );

        // Update progress
        this.indexingProgress.status = 'indexing';
        this.indexingProgress.totalFiles = queueStatus.pending;
        this.indexingProgress.processedFiles = 0;
        this.indexingProgress.startedAt = new Date();
        this.indexingProgress.completedAt = null;

        // Start pipeline processing
        this.searchSystem.startProcessing();

        // Wait for pipeline to become idle
        while (
          this.searchSystem &&
          (
            this.searchSystem as unknown as {
              pipeline: { getState: () => string };
            }
          ).pipeline?.getState() !== 'idle'
        ) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        // Update progress
        const newStatus = await this.searchSystem.getQueueStatus();
        this.indexingProgress.processedFiles =
          queueStatus.pending - newStatus.pending;
        this.indexingProgress.status =
          newStatus.pending > 0 ? 'indexing' : 'completed';
        if (newStatus.pending === 0) {
          this.indexingProgress.completedAt = new Date();
          this.state.lastSyncAt = new Date();
        }

        this.isProcessingQueue = false;
      }
    } catch (error) {
      this.isProcessingQueue = false;
      console.warn('[SearchService] Queue check failed:', error);
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

    try {
      console.log('[SearchService] Starting sync...');

      // Update progress
      this.indexingProgress.status = 'syncing';
      this.indexingProgress.startedAt = new Date();
      this.indexingProgress.completedAt = null;
      this.indexingProgress.failedFiles = 0;

      // Discover files
      this.indexingProgress.status = 'discovering';
      const files = await this.searchSystem.discoverFiles();
      this.indexingProgress.totalFiles = files.length;

      console.log(`[SearchService] Discovered ${files.length} files`);

      if (files.length === 0) {
        this.indexingProgress.status = 'completed';
        this.indexingProgress.completedAt = new Date();
        return;
      }

      // Index all files
      this.indexingProgress.status = 'indexing';
      const result = await this.searchSystem.indexAll({ force });

      this.indexingProgress.status = 'completed';
      this.indexingProgress.processedFiles = result.indexed;
      this.indexingProgress.failedFiles = result.failed;
      this.indexingProgress.completedAt = new Date();
      this.state.lastSyncAt = new Date();

      console.log(
        `[SearchService] Sync completed: ${result.indexed} indexed, ${result.failed} failed (${result.duration}ms)`,
      );
    } catch (error) {
      this.indexingProgress.status = 'failed';
      this.indexingProgress.lastError =
        error instanceof Error ? error.message : String(error);
      this.indexingProgress.completedAt = new Date();
      console.error('[SearchService] Sync failed:', error);
      throw error;
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
