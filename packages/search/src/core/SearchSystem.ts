/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console */

import { join, resolve, extname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Image extensions that should be directly OCR'd
const IMAGE_EXTENSIONS_FOR_OCR = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
]);

import { EventEmitter } from './EventEmitter.js';
import type {
  SearchSystemConfig,
  DeepPartial,
  DatabaseConfig,
} from '../config.js';
import { createConfig, validateConfig } from '../config.js';
import type {
  SearchStats,
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchFilters,
  TagCount,
  QueueStatus,
  QueuePriority,
  DiscoveredFile,
} from '../types.js';
import { PGliteStorage } from '../storage/PGliteStorage.js';
import type { StorageAdapter } from '../storage/types.js';
import {
  createFileDiscovery,
  type FileDiscovery,
} from '../discovery/FileDiscovery.js';
import { createParserRegistry } from '../parsers/index.js';
import { createChunkerRegistry } from '../chunkers/index.js';
import { MockEmbedder, createEmbedders } from '../embedders/index.js';
import type { TextEmbedder } from '../embedders/types.js';
import type { ResolvedEmbedderConfig } from '../embedders/gpu-detection.js';
import { IndexingPipeline } from '../indexing/index.js';
import { IndexingChildManager } from '../indexing/IndexingChildManager.js';
import type { Embedder } from '../indexing/types.js';
import { createSearchEngine, type SearchEngine } from '../search/index.js';
import { createStartupSync, type StartupSync } from '../sync/StartupSync.js';
import type {
  SyncResult,
  SyncOptions as FileSyncOptions,
} from '../sync/types.js';
import {
  createOcrRegistryAsync,
  createOcrQueueManager,
  isTesseractAvailable,
  type OcrRegistry,
  type OcrQueueManager,
  type OcrQueueStatus,
  type OcrResult,
} from '../ocr/index.js';

import type { EmbedderQuantization } from '../embedders/types.js';
import { globalLogger, LogLevel } from './Logger.js';

// ============================================================================
// Constants
// ============================================================================

/** Key used to store embedder config in the database */
const EMBEDDER_CONFIG_KEY = 'embedder_config';

/**
 * Database format version for compatibility detection.
 * Increment this when making breaking changes to:
 * - Embedding format or dimensions
 * - Chunking strategy that affects stored data
 * - Storage schema in ways that affect search quality
 */
export const SEARCH_DB_VERSION = '1.0.0';

// ============================================================================
// Types
// ============================================================================

/**
 * Embedder configuration stored in the database.
 * This ensures consistency across different machines/sessions.
 */
export interface StoredEmbedderConfig {
  /** Database format version for compatibility detection */
  version: string;
  /** Model ID used for embeddings */
  model: string;
  /** Quantization used (fp16, q8, etc.) */
  quantization: EmbedderQuantization;
  /** Embedding dimensions */
  dimensions: number;
  /** When the config was first stored */
  createdAt: string;
}

/**
 * Logging configuration options.
 */
export interface LoggingOptions {
  /** Enable logging (default: false) */
  enabled?: boolean;
  /** Log level (default: INFO) */
  level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  /** Log to console (default: true) */
  console?: boolean;
  /** Log file path (default: .auditaria/search.log) */
  filePath?: string;
  /** Include memory stats in logs (default: true when enabled) */
  includeMemory?: boolean;
}

export interface SearchSystemInitOptions {
  /** Root path to index. Defaults to current working directory */
  rootPath?: string;
  /** Configuration overrides */
  config?: DeepPartial<SearchSystemConfig>;
  /** Use mock embedder (for testing) */
  useMockEmbedder?: boolean;
  /** Logging configuration for debugging */
  logging?: LoggingOptions;
}

export interface SearchSystemState {
  initialized: boolean;
  rootPath: string;
  databasePath: string;
  indexingInProgress: boolean;
  ocrEnabled: boolean;
  ocrAvailable: boolean;
}

export interface SearchSystemEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;
  'search:started': { query: string };
  'search:completed': { query: string; resultCount: number; duration: number };
  'indexing:started': { fileCount: number };
  'indexing:progress': { current: number; total: number };
  'indexing:completed': { indexed: number; failed: number; duration: number };
  'ocr:started': { documentId: string; filePath: string; regions: number };
  'ocr:progress': {
    documentId: string;
    filePath: string;
    completed: number;
    total: number;
  };
  'ocr:completed': {
    documentId: string;
    filePath: string;
    text: string;
    confidence: number;
  };
  'ocr:failed': { documentId: string; filePath: string; error: Error };
}

// ============================================================================
// SearchSystem Class
// ============================================================================

/**
 * Main orchestrator for the search system.
 * Provides a unified API for all search operations.
 */
export class SearchSystem extends EventEmitter<SearchSystemEvents> {
  private config: SearchSystemConfig;
  private rootPath: string;
  private storage: StorageAdapter | null = null;
  private discovery: FileDiscovery | null = null;
  private pipeline: IndexingPipeline | null = null;
  private searchEngine: SearchEngine | null = null;
  private startupSync: StartupSync | null = null;
  /** Embedder for indexing operations (may use GPU) */
  private indexingEmbedder: TextEmbedder | null = null;
  /** Embedder for search operations (always CPU, same dtype) */
  private searchEmbedder: TextEmbedder | null = null;
  /** Resolved embedder configuration (for debugging/info) */
  private resolvedEmbedderConfig: ResolvedEmbedderConfig | null = null;
  private ocrRegistry: OcrRegistry | null = null;
  private ocrQueueManager: OcrQueueManager | null = null;
  private initialized: boolean = false;
  private indexingInProgress: boolean = false;
  private useMockEmbedder: boolean = false;
  private ocrAvailable: boolean = false;
  private loggingOptions?: LoggingOptions;
  /** Flag to signal graceful shutdown is in progress */
  private closing: boolean = false;
  /** Child process manager for memory-safe indexing */
  private childManager: IndexingChildManager | null = null;

  private constructor(
    rootPath: string,
    config: SearchSystemConfig,
    useMockEmbedder: boolean = false,
    loggingOptions?: LoggingOptions,
  ) {
    super();
    this.rootPath = resolve(rootPath);
    this.config = config;
    this.useMockEmbedder = useMockEmbedder;
    this.loggingOptions = loggingOptions;
  }

  // -------------------------------------------------------------------------
  // Static Factory Methods
  // -------------------------------------------------------------------------

  /**
   * Initialize a new search system.
   * Creates database and sets up all components.
   */
  static async initialize(
    options: SearchSystemInitOptions = {},
  ): Promise<SearchSystem> {
    const rootPath = options.rootPath ?? process.cwd();
    const config = createConfig(options.config);
    validateConfig(config);

    const system = new SearchSystem(
      rootPath,
      config,
      options.useMockEmbedder ?? false,
      options.logging,
    );

    await system.setup();
    return system;
  }

  /**
   * Load an existing search system from database.
   * Returns null if database doesn't exist.
   */
  static async load(
    rootPath?: string,
    options: Omit<SearchSystemInitOptions, 'rootPath'> = {},
  ): Promise<SearchSystem | null> {
    const resolvedRoot = resolve(rootPath ?? process.cwd());
    const config = createConfig(options.config);
    const dbPath = join(resolvedRoot, config.database.path);

    // Check if database exists
    if (!existsSync(dbPath) && !config.database.inMemory) {
      return null;
    }

    const system = new SearchSystem(
      resolvedRoot,
      config,
      options.useMockEmbedder ?? false,
      options.logging,
    );

    await system.setup();
    return system;
  }

  /**
   * Check if a search database exists.
   */
  static exists(rootPath?: string, dbPath?: string): boolean {
    const resolvedRoot = resolve(rootPath ?? process.cwd());
    const path = dbPath ?? join(resolvedRoot, '.auditaria/search.db');
    return existsSync(path);
  }

  // -------------------------------------------------------------------------
  // Setup & Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Set up all components.
   */
  private async setup(): Promise<void> {
    // Configure logging if enabled
    if (this.loggingOptions?.enabled) {
      this.configureLogging();
    }

    // Ensure database directory exists
    const dbDir = join(this.rootPath, '.auditaria');
    if (!existsSync(dbDir)) {
      await mkdir(dbDir, { recursive: true });
    }

    // Initialize storage with vector index configuration
    const dbPath = join(this.rootPath, this.config.database.path);
    const dbConfig: DatabaseConfig = {
      path: dbPath,
      inMemory: this.config.database.inMemory,
      backupEnabled: this.config.database.backupEnabled,
    };

    // Initialize storage - it handles metadata file automatically
    this.storage = new PGliteStorage(
      dbConfig,
      this.config.vectorIndex,
      this.config.embeddings.dimensions,
    );
    await this.storage.initialize();

    // Recover documents stuck in intermediate states (crash recovery)
    // This handles cases where indexing was interrupted by crash/power loss
    if (this.storage.recoverStuckDocuments) {
      const recoveredCount = await this.storage.recoverStuckDocuments();
      if (recoveredCount > 0) {
        console.log(
          `[SearchSystem] Recovered ${recoveredCount} document(s) from interrupted indexing`,
        );
      }
    }

    // Initialize file discovery
    this.discovery = createFileDiscovery({
      rootPath: this.rootPath,
      ignorePaths: this.config.indexing.ignorePaths,
      includePatterns:
        this.config.indexing.includePaths.length > 0
          ? this.config.indexing.includePaths
          : undefined,
      fileTypes: this.config.indexing.fileTypes,
      maxFileSize: this.config.indexing.maxFileSize,
      respectGitignore: this.config.indexing.respectGitignore,
    });

    // Initialize embedders using factory (handles GPU detection and fallback)
    if (this.useMockEmbedder) {
      // Mock embedder for testing
      const mockEmbedder = new MockEmbedder(this.config.embeddings.dimensions);
      this.indexingEmbedder = mockEmbedder;
      this.searchEmbedder = mockEmbedder;
      this.resolvedEmbedderConfig = {
        device: 'cpu',
        quantization: 'q8',
        gpuDetected: false,
        gpuUsedForIndexing: false,
      };
      console.log('[SearchSystem] Using MockEmbedder');
    } else {
      // Check for stored embedder config (ensures consistency across machines/sessions)
      const storedConfig =
        await this.storage.getConfigValue<StoredEmbedderConfig>(
          EMBEDDER_CONFIG_KEY,
        );

      // Determine effective model and quantization
      // If stored config exists, use it (database dictates settings)
      // Otherwise, use current config (new database)
      const effectiveModel =
        storedConfig?.model ?? this.config.embeddings.model;
      const effectiveQuantization =
        storedConfig?.quantization ?? this.config.embeddings.quantization;

      if (storedConfig) {
        console.log(
          `[SearchSystem] Using stored embedder config: version=${storedConfig.version ?? 'unknown'}, ` +
            `model=${storedConfig.model}, quantization=${storedConfig.quantization} ` +
            `(created: ${storedConfig.createdAt})`,
        );
      } else {
        console.log(
          '[SearchSystem] Fresh database, will store embedder config',
        );
      }

      // Use factory to create embedders
      console.log('[SearchSystem] Initializing embedders...');

      const { indexingEmbedder, searchEmbedder, resolvedConfig } =
        await createEmbedders(
          {
            model: effectiveModel,
            device: this.config.embeddings.device, // Device is per-machine
            quantization: effectiveQuantization,
            preferGpuForIndexing: this.config.embeddings.preferGpuForIndexing,
            useWorkerThread: this.config.embeddings.useWorkerThread,
            batchSize: this.config.embeddings.batchSize,
            workerHeapSizeMb: this.config.embeddings.workerHeapSizeMb,
            preferPythonEmbedder: this.config.embeddings.preferPythonEmbedder,
            cacheDir: this.config.embeddings.cacheDir, // Use consistent path across runtimes
          },
          (progress) => {
            // Show progress for model loading (files are usually cached locally)
            if (
              (progress.stage === 'load' || progress.stage === 'download') &&
              progress.file
            ) {
              console.log(
                `[SearchSystem] Loading: ${progress.file} ${Math.round(progress.progress)}%`,
              );
            }
          },
        );

      this.indexingEmbedder = indexingEmbedder;
      this.searchEmbedder = searchEmbedder;
      this.resolvedEmbedderConfig = resolvedConfig;

      // Store config if this is a fresh database
      if (!storedConfig) {
        const newConfig: StoredEmbedderConfig = {
          version: SEARCH_DB_VERSION,
          model: effectiveModel,
          quantization: resolvedConfig.quantization,
          dimensions: this.config.embeddings.dimensions,
          createdAt: new Date().toISOString(),
        };
        await this.storage.setConfigValue(EMBEDDER_CONFIG_KEY, newConfig);
        console.log(
          `[SearchSystem] Stored embedder config: version=${newConfig.version}, ` +
            `model=${newConfig.model}, quantization=${newConfig.quantization}`,
        );
      } else if (storedConfig.version !== SEARCH_DB_VERSION) {
        // Warn about version mismatch (database was created with different version)
        console.warn(
          `[SearchSystem] Database version mismatch: stored=${storedConfig.version ?? 'unknown'}, ` +
            `current=${SEARCH_DB_VERSION}. Consider rebuilding the index if you experience issues.`,
        );
      }

      // Update metadata file with embeddings config (for human visibility)
      const pgliteStorage = this.storage as PGliteStorage;
      if (pgliteStorage.updateMetadataEmbeddings) {
        pgliteStorage.updateMetadataEmbeddings({
          model: effectiveModel,
          dimensions: this.config.embeddings.dimensions,
          quantization: resolvedConfig.quantization,
        });
      }

      // Log resolved configuration
      const gpuStatus = resolvedConfig.gpuUsedForIndexing
        ? `GPU (${resolvedConfig.device})`
        : resolvedConfig.fallbackReason
          ? `CPU (GPU fallback: ${resolvedConfig.fallbackReason})`
          : 'CPU';

      console.log(
        `[SearchSystem] Embedders ready: indexing=${gpuStatus}, ` +
          `search=CPU, dtype=${resolvedConfig.quantization}`,
      );
    }

    // Initialize search embedder (lazy - initialize on first use for faster startup)
    // Note: Model is already cached from indexing embedder initialization

    // Initialize pipeline
    const parserRegistry = createParserRegistry();
    const chunkerRegistry = createChunkerRegistry();

    this.pipeline = new IndexingPipeline(
      this.storage,
      parserRegistry,
      chunkerRegistry,
      this.indexingEmbedder as Embedder,
      {
        rootPath: this.rootPath,
        autoStart: false,
        prepareWorkers: this.config.indexing.prepareWorkers,
        preparedBufferSize: this.config.indexing.preparedBufferSize,
        embeddingBatchSize: this.config.embeddings.batchSize,
        discoveryOptions: {
          ignorePaths: this.config.indexing.ignorePaths,
          includePatterns:
            this.config.indexing.includePaths.length > 0
              ? this.config.indexing.includePaths
              : undefined,
          fileTypes: this.config.indexing.fileTypes,
          maxFileSize: this.config.indexing.maxFileSize,
          respectGitignore: this.config.indexing.respectGitignore,
        },
        chunkerOptions: {
          maxChunkSize: this.config.chunking.maxChunkSize,
          chunkOverlap: this.config.chunking.chunkOverlap,
        },
      },
    );

    // Initialize search engine (uses CPU embedder for search)
    this.searchEngine = createSearchEngine(this.storage, this.searchEmbedder, {
      defaultLimit: this.config.search.defaultLimit,
      defaultStrategy: this.config.search.defaultStrategy,
      semanticWeight: this.config.search.semanticWeight,
      keywordWeight: this.config.search.keywordWeight,
      rrfK: this.config.search.rrfK,
    });

    // Listen for OCR needed events from pipeline (for PDFs and other documents)
    this.pipeline.on('document:ocr_needed', (event) => {
      if (this.ocrQueueManager && this.config.ocr.enabled) {
        this.ocrQueueManager
          .enqueue(event.documentId, event.filePath, [])
          .catch((err) => {
            console.warn(
              `[SearchSystem] Failed to enqueue OCR job: ${err.message}`,
            );
          });
      }
    });

    // Listen for maintenance completion events to trigger backup at safe points
    this.pipeline.on('maintenance:completed', async () => {
      try {
        const storage = this.storage as PGliteStorage;
        if (typeof storage.createBackup === 'function') {
          const backed = await storage.createBackup();
          if (backed) {
            console.log('[SearchSystem] Backup created during maintenance');
          }
        }
      } catch (error) {
        console.warn(
          `[SearchSystem] Backup during maintenance failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    // Initialize startup sync
    this.startupSync = createStartupSync(this.storage, this.discovery);

    // Initialize OCR (optional - only if tesseract.js is available)
    if (this.config.ocr.enabled) {
      try {
        this.ocrAvailable = await isTesseractAvailable();
        if (this.ocrAvailable) {
          console.log(
            '[SearchSystem] Tesseract.js available, initializing OCR...',
          );
          this.ocrRegistry = await createOcrRegistryAsync();
          this.ocrQueueManager = createOcrQueueManager(
            this.storage,
            this.ocrRegistry,
            {
              enabled: this.config.ocr.enabled,
              concurrency: this.config.ocr.concurrency,
              maxRetries: this.config.ocr.maxRetries,
              retryDelay: this.config.ocr.retryDelay,
              processAfterMainQueue: this.config.ocr.processAfterMainQueue,
              defaultLanguages: this.config.ocr.defaultLanguages,
              rootPath: this.rootPath, // For resolving relative file paths
            },
            this.indexingEmbedder as Embedder,
          );

          // Forward OCR events
          this.ocrQueueManager.on('ocr:started', (event) => {
            void this.emit('ocr:started', event);
          });
          this.ocrQueueManager.on('ocr:completed', (event) => {
            void this.emit('ocr:completed', event);
          });
          this.ocrQueueManager.on('ocr:failed', (event) => {
            void this.emit('ocr:failed', event);
          });

          console.log('[SearchSystem] OCR initialized');
        } else {
          console.log(
            '[SearchSystem] Tesseract.js not available, OCR disabled',
          );
        }
      } catch (error) {
        console.warn('[SearchSystem] Failed to initialize OCR:', error);
        this.ocrAvailable = false;
      }
    }

    this.initialized = true;
  }

  /**
   * Configure the global logger based on logging options.
   */
  private configureLogging(): void {
    if (!this.loggingOptions) return;

    const levelMap: Record<string, LogLevel> = {
      debug: LogLevel.DEBUG,
      info: LogLevel.INFO,
      warn: LogLevel.WARN,
      error: LogLevel.ERROR,
      silent: LogLevel.SILENT,
    };

    // Default log file path if not specified
    const defaultLogPath = join(this.rootPath, '.auditaria', 'search.log');

    globalLogger.configure({
      level: levelMap[this.loggingOptions.level ?? 'debug'] ?? LogLevel.DEBUG,
      console: this.loggingOptions.console ?? false,
      filePath: this.loggingOptions.filePath ?? defaultLogPath,
      includeMemory: this.loggingOptions.includeMemory ?? true,
      json: true, // Human readable in console, JSON in file
      colors: true,
      timestamps: true,
    });

    globalLogger.info('SearchSystem', 'Logging enabled', {
      level: this.loggingOptions.level ?? 'debug',
      filePath: this.loggingOptions.filePath ?? defaultLogPath,
      includeMemory: this.loggingOptions.includeMemory ?? true,
    });
    globalLogger.logMemory('SearchSystem', 'Initial memory state');
  }

  /**
   * Close the search system and release resources.
   * Each cleanup step is wrapped in try-catch with timeout to ensure all resources
   * are cleaned up even if one step fails or hangs.
   */
  async close(): Promise<void> {
    // Signal shutdown immediately so ongoing operations can exit gracefully
    this.closing = true;
    this.initialized = false;

    // Stop child manager FIRST if running (this signals abort and stops the child process)
    // Must happen before waiting for indexingInProgress to avoid deadlock
    if (this.childManager) {
      console.log('[SearchSystem] Stopping child indexing process...');
      try {
        await this.childManager.stop();
      } catch (error) {
        console.warn(
          '[SearchSystem] Error stopping child manager:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // Wait for any ongoing indexing to finish (with timeout)
    // This prevents race conditions where indexAll() is still accessing resources
    if (this.indexingInProgress) {
      console.log(
        '[SearchSystem] Waiting for indexing to finish before close...',
      );
      const waitStart = Date.now();
      const MAX_WAIT_MS = 5000; // 5 second max wait for indexing to exit
      while (this.indexingInProgress && Date.now() - waitStart < MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (this.indexingInProgress) {
        console.warn(
          '[SearchSystem] Indexing did not finish in time, proceeding with close',
        );
      }
    }

    const errors: Array<{ step: string; error: unknown }> = [];
    const STEP_TIMEOUT_MS = 10000; // 10 second timeout per step

    // Helper to safely close a resource with timeout
    const safeClose = async (
      step: string,
      resource: unknown,
      closeFn: () => Promise<void>,
    ): Promise<void> => {
      if (!resource) return;
      try {
        await Promise.race([
          closeFn(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(`${step} timed out after ${STEP_TIMEOUT_MS}ms`),
                ),
              STEP_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (error) {
        // Log and collect errors but continue cleanup
        console.warn(`[SearchSystem] Error during ${step}:`, error);
        errors.push({ step, error });
      }
    };

    // Stop child manager if running
    await safeClose('childManager.stop', this.childManager, async () => {
      await this.childManager!.stop();
      this.childManager = null;
    });

    // Stop pipeline first to prevent race condition with storage
    await safeClose('pipeline.stop', this.pipeline, async () => {
      await this.pipeline!.stop();
      this.pipeline = null;
    });

    // Stop OCR queue manager
    await safeClose('ocrQueueManager.stop', this.ocrQueueManager, async () => {
      await this.ocrQueueManager!.stop();
      this.ocrQueueManager = null;
    });

    // Dispose OCR registry
    await safeClose('ocrRegistry.disposeAll', this.ocrRegistry, async () => {
      await this.ocrRegistry!.disposeAll();
      this.ocrRegistry = null;
    });

    // Close storage
    await safeClose('storage.close', this.storage, async () => {
      await this.storage!.close();
      this.storage = null;
    });

    // Dispose indexing embedder
    await safeClose(
      'indexingEmbedder.dispose',
      this.indexingEmbedder,
      async () => {
        await this.indexingEmbedder!.dispose();
        this.indexingEmbedder = null;
      },
    );

    // Dispose search embedder
    await safeClose('searchEmbedder.dispose', this.searchEmbedder, async () => {
      await this.searchEmbedder!.dispose();
      this.searchEmbedder = null;
    });

    this.resolvedEmbedderConfig = null;
    this.initialized = false;
    this.ocrAvailable = false;

    // If any errors occurred, throw a combined error
    if (errors.length > 0) {
      const errorMessages = errors
        .map(({ step, error }) => {
          // Handle unusual error types (like Infinity)
          const errorStr =
            error instanceof Error
              ? error.message
              : typeof error === 'number' || typeof error === 'string'
                ? `Unexpected value: ${error}`
                : String(error);
          return `${step}: ${errorStr}`;
        })
        .join('; ');
      throw new Error(`Close errors: ${errorMessages}`);
    }
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Discover files to index.
   */
  async discoverFiles(): Promise<DiscoveredFile[]> {
    this.ensureInitialized();
    return this.discovery!.discoverAll();
  }

  /**
   * Index all discovered files.
   * Uses sync to detect changes and queues them for processing.
   *
   * By default, uses child process for indexing to prevent WASM memory accumulation.
   * Set `useChildProcess: false` to use in-process indexing (for testing or debugging).
   */
  async indexAll(
    options: {
      force?: boolean;
      /** Use child process for indexing (default: true from config) */
      useChildProcess?: boolean;
      /** Maximum documents per batch when using child process */
      maxDocuments?: number;
    } = {},
  ): Promise<{ indexed: number; failed: number; duration: number }> {
    this.ensureInitialized();

    // Determine whether to use child process
    // Default to config value, can be overridden by options
    const useChildProcess =
      options.useChildProcess ?? this.config.indexing.useChildProcess;

    // Use child process for indexing (solves WASM memory accumulation issue)
    if (useChildProcess) {
      return this.indexAllWithChildProcess(options);
    }

    // In-process indexing (legacy behavior, for testing/debugging)
    return this.indexAllInProcess(options);
  }

  /**
   * Index all files using child process.
   * Each child processes a batch then exits, releasing all WASM memory.
   */
  private async indexAllWithChildProcess(options: {
    force?: boolean;
    maxDocuments?: number;
  }): Promise<{ indexed: number; failed: number; duration: number }> {
    if (this.indexingInProgress) {
      throw new Error('Indexing already in progress');
    }

    this.indexingInProgress = true;

    try {
      // Set storage to read-only mode (child will write)
      if (this.storage?.setReadOnly) {
        await this.storage.setReadOnly(true);
      }

      // Create child manager
      const databasePath = join(this.rootPath, this.config.database.path);
      this.childManager = new IndexingChildManager(
        this.rootPath,
        databasePath,
        {
          database: this.config.database,
          indexing: this.config.indexing,
          chunking: this.config.chunking,
          embeddings: this.config.embeddings,
          search: this.config.search,
          ocr: this.config.ocr,
        },
        {
          batchSize:
            options.maxDocuments ?? this.config.indexing.childProcessBatchSize,
          memoryThresholdMb: this.config.indexing.childProcessMemoryThresholdMb,
        },
      );

      // Forward progress events
      this.childManager.on('progress', (event) => {
        void this.emit('indexing:progress', {
          current: event.current,
          total: event.total,
        });
      });

      this.childManager.on('batch:complete', (stats) => {
        console.log(
          `[SearchSystem] Child batch complete: ${stats.processed} indexed, ` +
            `${stats.failed} failed, memory=${stats.memoryUsageMb}MB, hasMore=${stats.hasMore}`,
        );
      });

      this.childManager.on('child:spawned', (event) => {
        console.log(
          `[SearchSystem] Child process spawned: pid=${event.pid}, batch=${event.batchNumber}`,
        );
      });

      this.childManager.on('child:exited', (event) => {
        console.log(
          `[SearchSystem] Child process exited: pid=${event.pid}, code=${event.code}, batch=${event.batchNumber}`,
        );
      });

      this.childManager.on('error', (event) => {
        console.error(
          `[SearchSystem] Child process error: ${event.error}, fatal=${event.fatal}`,
        );
      });

      // Run indexing in child process(es)
      const result = await this.childManager.indexAll({ force: options.force });

      // Ensure vector index exists after bulk indexing
      // (handles deferred index creation and edge case where no new docs were indexed)
      const pgliteStorage = this.storage as PGliteStorage;
      if (pgliteStorage.ensureVectorIndex) {
        const indexCreated = await pgliteStorage.ensureVectorIndex();
        if (indexCreated) {
          console.log(
            `[SearchSystem] Vector index created (${this.config.vectorIndex.type})`,
          );
        }
      }

      void this.emit('indexing:completed', result);

      return result;
    } finally {
      this.indexingInProgress = false;
      this.childManager = null;

      // Restore write mode
      if (this.storage?.setReadOnly) {
        await this.storage.setReadOnly(false);
      }
    }
  }

  /**
   * Index all files in-process (legacy behavior).
   * Uses sync to detect changes and queues them for processing.
   */
  private async indexAllInProcess(options: {
    force?: boolean;
    maxDocuments?: number;
  }): Promise<{ indexed: number; failed: number; duration: number }> {
    if (this.indexingInProgress) {
      throw new Error('Indexing already in progress');
    }

    this.indexingInProgress = true;
    const startTime = Date.now();

    try {
      // Discover and sync files
      const changes = await this.pipeline!.syncAndQueue({
        forceReindex: options.force,
      });

      let totalToProcess = changes.added.length + changes.modified.length;

      // Limit to maxDocuments if specified (for child process batching)
      if (options.maxDocuments && totalToProcess > options.maxDocuments) {
        totalToProcess = options.maxDocuments;
      }

      void this.emit('indexing:started', { fileCount: totalToProcess });

      if (totalToProcess === 0) {
        return { indexed: 0, failed: 0, duration: Date.now() - startTime };
      }

      // Start pipeline processing
      this.pipeline!.start();

      // Wait for processing to complete
      let indexed = 0;
      let failed = 0;

      // Subscribe to pipeline events
      const unsubCompleted = this.pipeline!.on(
        'document:completed',
        (event) => {
          indexed++;
          void this.emit('indexing:progress', {
            current: indexed + failed,
            total: totalToProcess,
          });

          // Directly enqueue image files for OCR (bypass parser's requiresOcr flag)
          if (this.ocrQueueManager && this.config.ocr.enabled) {
            const ext = extname(event.filePath).toLowerCase();
            if (IMAGE_EXTENSIONS_FOR_OCR.has(ext)) {
              this.ocrQueueManager
                .enqueue(event.documentId, event.filePath, [])
                .catch((err) => {
                  console.warn(
                    `[SearchSystem] Failed to enqueue image for OCR: ${err.message}`,
                  );
                });
            }
          }

          // Stop early if we've reached maxDocuments
          if (
            options.maxDocuments &&
            indexed + failed >= options.maxDocuments
          ) {
            this.pipeline!.stop().catch(() => {
              // Ignore stop errors
            });
          }
        },
      );

      const unsubFailed = this.pipeline!.on('document:failed', (event) => {
        failed++;
        // Log the failure for debugging
        console.error(
          `[SearchSystem] Failed to index: ${event.filePath}`,
          event.error?.message ?? 'Unknown error',
        );
        void this.emit('indexing:progress', {
          current: indexed + failed,
          total: totalToProcess,
        });

        // Stop early if we've reached maxDocuments
        if (options.maxDocuments && indexed + failed >= options.maxDocuments) {
          this.pipeline!.stop().catch(() => {
            // Ignore stop errors
          });
        }
      });

      // Wait for pipeline to finish, with graceful shutdown handling
      try {
        await this.waitForPipelineIdle();
      } catch (error) {
        // If shutdown was triggered, clean up and return partial results
        if (this.closing) {
          console.log('[SearchSystem] Indexing interrupted by shutdown');
          unsubCompleted();
          unsubFailed();
          const duration = Date.now() - startTime;
          void this.emit('indexing:completed', { indexed, failed, duration });
          return { indexed, failed, duration };
        }
        throw error;
      }

      // Cleanup
      unsubCompleted();
      unsubFailed();

      // Skip OCR and backup if shutdown was triggered
      if (this.closing) {
        console.log('[SearchSystem] Skipping OCR and backup due to shutdown');
        const duration = Date.now() - startTime;
        void this.emit('indexing:completed', { indexed, failed, duration });
        return { indexed, failed, duration };
      }

      // Process OCR queue if enabled
      if (this.isOcrAvailable()) {
        // Also check for existing image documents that need OCR
        // (they might have been indexed before but OCR wasn't completed)
        await this.enqueueExistingImagesForOcr();

        const ocrStatus = this.ocrQueueManager!.getStatus();
        if (ocrStatus.pendingJobs > 0 && !this.closing) {
          console.log(
            `[SearchSystem] Processing ${ocrStatus.pendingJobs} OCR job(s)...`,
          );
          const ocrResult = await this.ocrQueueManager!.processAll();
          console.log(
            `[SearchSystem] OCR completed: ${ocrResult.succeeded} succeeded, ${ocrResult.failed} failed`,
          );
        }
      }

      // Ensure vector index exists after bulk indexing
      // (handles deferred index creation and edge case where no new docs were indexed)
      if (!this.closing) {
        const pgliteStorage = this.storage as PGliteStorage;
        if (pgliteStorage.ensureVectorIndex) {
          const indexCreated = await pgliteStorage.ensureVectorIndex();
          if (indexCreated) {
            console.log(
              `[SearchSystem] Vector index created (${this.config.vectorIndex.type})`,
            );
          }
        }
      }

      const duration = Date.now() - startTime;
      void this.emit('indexing:completed', { indexed, failed, duration });

      // Create backup after successful indexing (skip if closing)
      if (!this.closing) {
        try {
          const storage = this.storage as PGliteStorage;
          if (typeof storage.createBackup === 'function') {
            const backed = await storage.createBackup();
            if (backed) {
              console.log('[SearchSystem] Post-indexing backup created');
            }
          }
        } catch (error) {
          console.warn(
            `[SearchSystem] Post-indexing backup failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return { indexed, failed, duration };
    } finally {
      this.indexingInProgress = false;
    }
  }

  /**
   * Wait for pipeline to become idle.
   */
  private async waitForPipelineIdle(): Promise<void> {
    // Check closing flag and pipeline existence before each iteration
    // to handle graceful shutdown during indexing
    while (
      !this.closing &&
      this.pipeline &&
      this.pipeline.getState() !== 'idle'
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // If we exited due to shutdown, throw a specific error
    if (this.closing) {
      throw new Error('Operation cancelled: system is shutting down');
    }
  }

  /**
   * Index a single file.
   */
  async indexFile(filePath: string): Promise<boolean> {
    this.ensureInitialized();
    const result = await this.pipeline!.processFile(filePath);
    return result.success;
  }

  /**
   * Reindex a file (delete chunks and re-process).
   */
  async reindexFile(filePath: string): Promise<boolean> {
    this.ensureInitialized();

    // Delete existing document if present
    const doc = await this.storage!.getDocumentByPath(filePath);
    if (doc) {
      await this.storage!.deleteDocument(doc.id);
    }

    return this.indexFile(filePath);
  }

  /**
   * Queue files for indexing.
   */
  async queueFiles(
    filePaths: string[],
    priority: QueuePriority = 'markup',
  ): Promise<void> {
    this.ensureInitialized();
    await this.pipeline!.queueFiles(filePaths, priority);
  }

  /**
   * Start processing queued items.
   */
  startProcessing(): void {
    this.ensureInitialized();
    this.pipeline!.start();
  }

  /**
   * Stop processing.
   */
  async stopProcessing(): Promise<void> {
    this.ensureInitialized();
    await this.pipeline!.stop();
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Perform a search with full options.
   */
  async search(options: SearchOptions): Promise<SearchResponse> {
    this.ensureInitialized();
    return this.searchEngine!.search(options);
  }

  /**
   * Quick keyword search.
   */
  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();
    return this.searchEngine!.searchKeyword(query, filters, limit);
  }

  /**
   * Quick semantic search.
   */
  async searchSemantic(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();
    return this.searchEngine!.searchSemantic(query, filters, limit);
  }

  /**
   * Quick hybrid search.
   */
  async searchHybrid(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    this.ensureInitialized();
    return this.searchEngine!.searchHybrid(query, filters, limit);
  }

  // -------------------------------------------------------------------------
  // Document Retrieval
  // -------------------------------------------------------------------------

  /**
   * Get a document by ID.
   */
  async getDocument(
    documentId: string,
  ): Promise<import('../types.js').Document | null> {
    this.ensureInitialized();
    return this.storage!.getDocument(documentId);
  }

  /**
   * Get a document by file path.
   */
  async getDocumentByPath(
    filePath: string,
  ): Promise<import('../types.js').Document | null> {
    this.ensureInitialized();
    return this.storage!.getDocumentByPath(filePath);
  }

  /**
   * Get all chunks for a document.
   */
  async getDocumentChunks(
    documentId: string,
  ): Promise<Array<import('../types.js').DocumentChunk>> {
    this.ensureInitialized();
    return this.storage!.getChunks(documentId);
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  /**
   * Add tags to a file.
   */
  async addTags(filePath: string, tags: string[]): Promise<void> {
    this.ensureInitialized();

    const doc = await this.storage!.getDocumentByPath(filePath);
    if (!doc) {
      throw new Error(`Document not found: ${filePath}`);
    }

    await this.storage!.addTags(doc.id, tags);
  }

  /**
   * Remove tags from a file.
   */
  async removeTags(filePath: string, tags: string[]): Promise<void> {
    this.ensureInitialized();

    const doc = await this.storage!.getDocumentByPath(filePath);
    if (!doc) {
      throw new Error(`Document not found: ${filePath}`);
    }

    await this.storage!.removeTags(doc.id, tags);
  }

  /**
   * Get all tags for a file.
   */
  async getFileTags(filePath: string): Promise<string[]> {
    this.ensureInitialized();

    const doc = await this.storage!.getDocumentByPath(filePath);
    if (!doc) {
      throw new Error(`Document not found: ${filePath}`);
    }

    return this.storage!.getDocumentTags(doc.id);
  }

  /**
   * Get all tags with counts.
   */
  async getAllTags(): Promise<TagCount[]> {
    this.ensureInitialized();
    return this.storage!.getAllTags();
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /**
   * Sync files with database.
   * Detects added, modified, and deleted files.
   */
  async sync(options: FileSyncOptions = {}): Promise<SyncResult> {
    this.ensureInitialized();
    return this.startupSync!.sync(options);
  }

  /**
   * Check if sync is needed.
   */
  async needsSync(): Promise<boolean> {
    this.ensureInitialized();
    return this.startupSync!.needsSync();
  }

  // -------------------------------------------------------------------------
  // Stats & Status
  // -------------------------------------------------------------------------

  /**
   * Get search system statistics.
   */
  async getStats(): Promise<SearchStats> {
    this.ensureInitialized();
    return this.storage!.getStats();
  }

  /**
   * Get queue status.
   */
  async getQueueStatus(): Promise<QueueStatus> {
    this.ensureInitialized();
    return this.storage!.getQueueStatus();
  }

  /**
   * Get current system state.
   */
  getState(): SearchSystemState {
    return {
      initialized: this.initialized,
      rootPath: this.rootPath,
      databasePath: join(this.rootPath, this.config.database.path),
      indexingInProgress: this.indexingInProgress,
      ocrEnabled: this.config.ocr.enabled,
      ocrAvailable: this.ocrAvailable,
    };
  }

  /**
   * Get the configuration.
   */
  getConfig(): SearchSystemConfig {
    return { ...this.config };
  }

  // -------------------------------------------------------------------------
  // OCR
  // -------------------------------------------------------------------------

  /**
   * Check if OCR is available.
   */
  isOcrAvailable(): boolean {
    return this.ocrAvailable && this.ocrQueueManager !== null;
  }

  /**
   * Get OCR queue status.
   */
  getOcrQueueStatus(): OcrQueueStatus | null {
    if (!this.ocrQueueManager) {
      return null;
    }
    return this.ocrQueueManager.getStatus();
  }

  /**
   * Start OCR processing.
   */
  startOcrProcessing(): void {
    this.ensureInitialized();

    if (!this.isOcrAvailable()) {
      throw new Error('OCR is not available');
    }

    this.ocrQueueManager!.start();
  }

  /**
   * Stop OCR processing.
   */
  async stopOcrProcessing(): Promise<void> {
    if (this.ocrQueueManager) {
      await this.ocrQueueManager.stop();
    }
  }

  /**
   * Process all pending OCR jobs.
   */
  async processOcrQueue(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    this.ensureInitialized();

    if (!this.isOcrAvailable()) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    return this.ocrQueueManager!.processAll();
  }

  /**
   * Find existing image documents that need OCR and enqueue them.
   * This handles cases where images were indexed but OCR wasn't completed
   * (e.g., system was closed before OCR finished).
   */
  private async enqueueExistingImagesForOcr(): Promise<number> {
    if (!this.ocrQueueManager || !this.storage) {
      return 0;
    }

    // Get all documents
    const allDocs = await this.storage.listDocuments();

    let enqueuedCount = 0;

    for (const doc of allDocs) {
      // Check if it's an image file
      const ext = doc.fileExtension.toLowerCase();
      if (!IMAGE_EXTENSIONS_FOR_OCR.has(ext)) {
        continue;
      }

      // Check if OCR hasn't been completed
      if (doc.ocrStatus === 'completed') {
        continue;
      }

      // Enqueue for OCR
      try {
        await this.ocrQueueManager.enqueue(doc.id, doc.filePath, []);
        enqueuedCount++;
      } catch (err) {
        console.warn(
          `[SearchSystem] Failed to enqueue existing image for OCR: ${doc.filePath}`,
          err,
        );
      }
    }

    if (enqueuedCount > 0) {
      console.log(
        `[SearchSystem] Enqueued ${enqueuedCount} existing image(s) for OCR`,
      );
    }

    return enqueuedCount;
  }

  /**
   * Perform OCR on an image file directly.
   */
  async ocrFile(filePath: string): Promise<OcrResult> {
    this.ensureInitialized();

    if (!this.isOcrAvailable()) {
      throw new Error('OCR is not available');
    }

    // Initialize OCR provider if needed
    const provider = this.ocrRegistry!.getDefault();
    if (!provider) {
      throw new Error('No OCR provider available');
    }

    if (!provider.isReady()) {
      await provider.initialize();
    }

    return provider.recognizeFile(filePath, {
      languages: this.config.ocr.defaultLanguages,
    });
  }

  /**
   * Perform OCR on an image buffer.
   */
  async ocrBuffer(image: Buffer, languages?: string[]): Promise<OcrResult> {
    this.ensureInitialized();

    if (!this.isOcrAvailable()) {
      throw new Error('OCR is not available');
    }

    return this.ocrRegistry!.recognize(image, {
      languages: languages ?? this.config.ocr.defaultLanguages,
    });
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('SearchSystem not initialized');
    }
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Initialize a new search system.
 */
export async function initializeSearchSystem(
  options?: SearchSystemInitOptions,
): Promise<SearchSystem> {
  return SearchSystem.initialize(options);
}

/**
 * Load an existing search system.
 */
export async function loadSearchSystem(
  rootPath?: string,
  options?: Omit<SearchSystemInitOptions, 'rootPath'>,
): Promise<SearchSystem | null> {
  return SearchSystem.load(rootPath, options);
}

/**
 * Check if a search database exists.
 */
export function searchDatabaseExists(rootPath?: string): boolean {
  return SearchSystem.exists(rootPath);
}
