/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
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
import {
  type SearchSystemConfig,
  type DeepPartial,
  type DatabaseConfig,
  createConfig,
  loadUserConfig,
  loadMergedConfig,
  deepMerge,
  type BackendOptionsMap,
} from '../config.js';
import type {
  SearchStats,
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchFilters,
  TagCount,
  QueueStatus,
  QueueDetailedStatus,
  QueuePriority,
  DiscoveredFile,
} from '../types.js';
import type { PGliteStorage } from '../storage/PGliteStorage.js';
import type { SQLiteVectorliteStorage } from '../storage/SQLiteVectorliteStorage.js';
import { createStorage } from '../storage/StorageFactory.js';
import type { StorageAdapter } from '../storage/types.js';
import {
  createFileDiscovery,
  type FileDiscovery,
} from '../discovery/FileDiscovery.js';
import { createParserRegistry } from '../parsers/index.js';
import { createChunkerRegistry } from '../chunkers/index.js';
import {
  MockEmbedder,
  createEmbedders,
  getModelDimensions,
} from '../embedders/index.js';
import type { TextEmbedder, EmbedderQuantization } from '../embedders/types.js';
import type { ResolvedEmbedderConfig } from '../embedders/gpu-detection.js';
import { IndexingPipeline } from '../indexing/index.js';
import { IndexingChildManager } from '../indexing/IndexingChildManager.js';
import type { Embedder } from '../indexing/types.js';
import { createSearchEngine, type SearchEngine } from '../search/index.js';
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
  private storageTransferred = false;
  private closePromise: Promise<void> | null = null;
  private indexingTask: Promise<unknown> | null = null;
  private indexingAbortRequested = false;
  private readonly operations = new Set<Promise<unknown>>();
  /** Child process manager for memory-safe indexing */
  private childManager: IndexingChildManager | null = null;
  /** User backend options from knowledge-base.config.json (passed to createStorage) */
  private userBackendOptions: BackendOptionsMap | null = null;

  private constructor(
    rootPath: string,
    config: SearchSystemConfig,
    useMockEmbedder: boolean = false,
    loggingOptions?: LoggingOptions,
    userBackendOptions?: BackendOptionsMap,
  ) {
    super();
    this.rootPath = resolve(rootPath);
    this.config = config;
    this.useMockEmbedder = useMockEmbedder;
    this.loggingOptions = loggingOptions;
    this.userBackendOptions = userBackendOptions ?? null;
  }

  // -------------------------------------------------------------------------
  // Static Factory Methods
  // -------------------------------------------------------------------------

  /**
   * Initialize a new search system.
   * Creates database and sets up all components.
   *
   * Configuration is loaded from multiple sources with priority:
   * 1. Database metadata (db-config.json) - for schema-defining fields (existing databases)
   * 2. options.config (programmatic overrides) - for runtime preferences
   * 3. .auditaria/knowledge-base.config.json (user preferences)
   * 4. Code defaults
   *
   * Schema-defining fields (backend, embeddings model/dimensions, vectorIndex) from an
   * existing database's metadata ALWAYS take precedence to ensure data consistency.
   */
  static async initialize(
    options: SearchSystemInitOptions = {},
  ): Promise<SearchSystem> {
    const rootPath = resolve(options.rootPath ?? process.cwd());
    const auditariaDir = join(rootPath, '.auditaria');

    // Compute the database path to check for existing database
    // First load user config to determine the configured path
    const userConfig = loadUserConfig(auditariaDir);
    const prelimConfig = createConfig(
      deepMerge<DeepPartial<SearchSystemConfig>>(
        userConfig?.config ?? {},
        options.config ?? {},
      ),
    );
    const dbPath = join(rootPath, prelimConfig.database.path);

    // Load merged config with proper priority:
    // database metadata (schema fields) > user config (knowledge-base.config.json) > code defaults
    const merged = loadMergedConfig(auditariaDir, dbPath, options.config);

    // Apply programmatic overrides on top (for non-schema runtime preferences)
    // Note: For existing databases, schema fields are already locked by db metadata
    const config = merged.config;

    // Get the user backend options for new databases
    // For existing databases, createStorage() will use stored options from metadata
    const backendOptions = merged.existingDatabase
      ? undefined // createStorage() will read from metadata
      : userConfig?.backendOptions;

    const system = new SearchSystem(
      rootPath,
      config,
      options.useMockEmbedder ?? false,
      options.logging,
      backendOptions,
    );

    try {
      await system.setup();
    } catch (error) {
      await system.close().catch(() => undefined);
      throw error;
    }
    return system;
  }

  /**
   * Load an existing search system from database.
   * Returns null if database doesn't exist.
   *
   * Configuration priority:
   * 1. Database metadata (db-config.json) - for schema-defining fields (ALWAYS wins)
   * 2. options.config (programmatic overrides) - for runtime preferences
   * 3. .auditaria/knowledge-base.config.json (user preferences)
   * 4. Code defaults
   */
  static async load(
    rootPath?: string,
    options: Omit<SearchSystemInitOptions, 'rootPath'> = {},
  ): Promise<SearchSystem | null> {
    const resolvedRoot = resolve(rootPath ?? process.cwd());
    const auditariaDir = join(resolvedRoot, '.auditaria');

    // First load user config to determine the configured database path
    const userConfig = loadUserConfig(auditariaDir);
    const prelimConfig = createConfig(
      deepMerge<DeepPartial<SearchSystemConfig>>(
        userConfig?.config ?? {},
        options.config ?? {},
      ),
    );
    const dbPath = join(resolvedRoot, prelimConfig.database.path);

    // Check if database exists
    if (!existsSync(dbPath) && !prelimConfig.database.inMemory) {
      return null;
    }

    // Load merged config with proper priority:
    // database metadata (schema fields) > user config (knowledge-base.config.json) > code defaults
    const merged = loadMergedConfig(auditariaDir, dbPath, options.config);

    // Apply programmatic overrides on top (for non-schema runtime preferences)
    // Note: Schema fields are already locked by database metadata
    const config = merged.config;

    // For existing databases, createStorage() will read backend options from metadata
    const system = new SearchSystem(
      resolvedRoot,
      config,
      options.useMockEmbedder ?? false,
      options.logging,
      undefined, // createStorage() will use stored options from metadata
    );

    try {
      await system.setup();
    } catch (error) {
      await system.close().catch(() => undefined);
      throw error;
    }
    return system;
  }

  /**
   * Check if a search database exists.
   */
  static exists(rootPath?: string, dbPath?: string): boolean {
    const resolvedRoot = resolve(rootPath ?? process.cwd());
    const path = dbPath ?? join(resolvedRoot, '.auditaria/knowledge-base.db');
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
      backend: this.config.database.backend,
      path: dbPath,
      inMemory: this.config.database.inMemory,
      backupEnabled: this.config.database.backupEnabled,
    };

    // Initialize storage using factory - it handles backend selection and metadata
    // createStorage is async to support dynamic imports of optional backends
    // Priority for backend options: existing db-config.json > user knowledge-base.config.json > defaults
    // Derive dimensions from model name (prevents config mismatch bugs)
    const storageDimensions =
      getModelDimensions(this.config.embeddings.model) ??
      this.config.embeddings.dimensions;
    this.storage = await createStorage(
      dbConfig,
      this.config.vectorIndex,
      storageDimensions,
      'application',
      this.userBackendOptions ?? undefined,
    );
    await this.storage.initialize();
    await this.storage.resetProcessingQueueItems?.();

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
            pythonCommand: this.config.embeddings.pythonCommand,
            multimodal: this.config.embeddings.multimodal,
          },
          (progress) => {
            // Show progress for model loading (files are usually cached locally)
            if (
              (progress.stage === 'load' || progress.stage === 'download') &&
              progress.file
            ) {
              if (Math.round(progress.progress) % 100 === 0) {
                console.log(
                  `[SearchSystem] Loading: ${progress.file} ${Math.round(progress.progress)}%`,
                );
              }
            }
          },
        );

      this.indexingEmbedder = indexingEmbedder;
      this.searchEmbedder = searchEmbedder;
      this.resolvedEmbedderConfig = resolvedConfig;

      // Use the actual embedder dimensions (authoritative source of truth)
      const actualDimensions = indexingEmbedder.dimensions;

      // Store config if this is a fresh database
      if (!storedConfig) {
        const newConfig: StoredEmbedderConfig = {
          version: SEARCH_DB_VERSION,
          model: effectiveModel,
          quantization: resolvedConfig.quantization,
          dimensions: actualDimensions,
          createdAt: new Date().toISOString(),
        };
        await this.storage.setConfigValue(EMBEDDER_CONFIG_KEY, newConfig);
        console.log(
          `[SearchSystem] Stored embedder config: version=${newConfig.version}, ` +
            `model=${newConfig.model}, quantization=${newConfig.quantization}, ` +
            `dimensions=${actualDimensions}`,
        );
      } else if (storedConfig.version !== SEARCH_DB_VERSION) {
        // Warn about version mismatch (database was created with different version)
        console.warn(
          `[SearchSystem] Database version mismatch: stored=${storedConfig.version ?? 'unknown'}, ` +
            `current=${SEARCH_DB_VERSION}. Consider rebuilding the index if you experience issues.`,
        );
      }

      // Validate: storage dimensions must match actual embedder dimensions
      if (storageDimensions !== actualDimensions) {
        console.error(
          `[SearchSystem] DIMENSION MISMATCH: storage column has ${storageDimensions} dimensions ` +
            `but embedder "${effectiveModel}" produces ${actualDimensions}. ` +
            `Embeddings will fail. Please recreate the database.`,
        );
      }

      // Update metadata file with embeddings config (for human visibility)
      const pgliteStorage = this.storage as PGliteStorage;
      if (pgliteStorage.updateMetadataEmbeddings) {
        pgliteStorage.updateMetadataEmbeddings({
          model: effectiveModel,
          dimensions: actualDimensions,
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
          `search=${indexingEmbedder === searchEmbedder ? gpuStatus : 'CPU'}, dtype=${resolvedConfig.quantization}`,
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
    this.pipeline.on('document:ocr_needed', async (event) => {
      if (this.ocrQueueManager && this.config.ocr.enabled) {
        await this.ocrQueueManager.enqueue(
          event.documentId,
          event.filePath,
          [],
        );
      }
    });

    this.pipeline.on('document:completed', async (event) => {
      if (
        this.ocrQueueManager &&
        this.config.ocr.enabled &&
        IMAGE_EXTENSIONS_FOR_OCR.has(extname(event.filePath).toLowerCase()) &&
        !this.indexingEmbedder?.canEmbedMedia?.(event.filePath)
      ) {
        await this.ocrQueueManager.enqueue(
          event.documentId,
          event.filePath,
          [],
        );
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

    // Initialize OCR (optional - only if tesseract.js is available)
    if (this.config.ocr.enabled) {
      try {
        this.ocrAvailable = await isTesseractAvailable();
        if (this.ocrAvailable) {
          console.log(
            '[SearchSystem] Tesseract.js available, initializing OCR...',
          );
          this.ocrRegistry = await createOcrRegistryAsync({
            defaultOptions: { languages: this.config.ocr.defaultLanguages },
          });
          this.ocrQueueManager = createOcrQueueManager(
            this.storage,
            this.ocrRegistry,
            {
              enabled: this.config.ocr.enabled,
              concurrency: this.config.ocr.concurrency,
              maxRetries: this.config.ocr.maxRetries,
              retryDelay: this.config.ocr.retryDelay,
              processAfterMainQueue: this.config.ocr.processAfterMainQueue,
              autoDetectLanguage: this.config.ocr.autoDetectLanguage,
              defaultLanguages: this.config.ocr.defaultLanguages,
              minConfidence: this.config.ocr.minConfidence,
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
   * Waits for owned operations before releasing storage and shared models.
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.initialized = false;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const errors: unknown[] = [];
    const cleanup = async (operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };
    // Stop producers before releasing their database or model. A timeout cannot
    // cancel an in-process parser and must never permit use-after-close.
    await cleanup(async () => {
      await this.childManager?.stop();
    });
    await cleanup(async () => {
      await this.pipeline?.stop();
    });
    if (this.indexingTask)
      await cleanup(async () => {
        await this.indexingTask;
      });
    await cleanup(async () => {
      await this.ocrQueueManager?.stop();
    });
    await Promise.allSettled([...this.operations]);
    await cleanup(async () => {
      await this.ocrRegistry?.disposeAll();
    });
    await cleanup(async () => {
      await this.storage?.close();
    });
    const embedders = new Set([this.indexingEmbedder, this.searchEmbedder]);
    for (const embedder of embedders)
      await cleanup(async () => {
        await embedder?.dispose();
      });
    this.childManager = null;
    this.pipeline = null;
    this.ocrQueueManager = null;
    this.ocrRegistry = null;
    this.storage = null;
    this.searchEngine = null;
    this.indexingEmbedder = null;
    this.searchEmbedder = null;
    this.resolvedEmbedderConfig = null;
    this.ocrAvailable = false;
    this.removeAllListeners();
    if (errors.length)
      throw new AggregateError(
        errors,
        'Failed to close knowledge base resources',
      );
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  /**
   * Discover files to index.
   */
  async discoverFiles(): Promise<DiscoveredFile[]> {
    this.ensureInitialized();
    return this.trackOperation(this.discovery!.discoverAll());
  }

  /**
   * Index all discovered files.
   * Uses sync to detect changes and queues them for processing.
   *
   * Runs in this process by default. Optional child workers use the same pipeline.
   */
  async indexAll(
    options: {
      force?: boolean;
      /** Use child process for indexing (default: false from config) */
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
      return this.runIndexing(() => this.indexAllWithChildProcess(options));
    }

    // In-process indexing (bounded processing in the current process)
    return this.runIndexing(() => this.indexAllInProcess(options));
  }

  /**
   * Index all files using child process.
   * Each child processes a batch then exits, releasing all WASM memory.
   */
  private async indexAllWithChildProcess(options: {
    force?: boolean;
    maxDocuments?: number;
  }): Promise<{ indexed: number; failed: number; duration: number }> {
    if (this.config.database.inMemory)
      throw new Error('Child indexing requires a persistent database');
    const storage = this.storage!;
    const exclusive =
      this.config.database.backend === 'pglite' ||
      this.config.database.backend === 'lancedb';
    try {
      this.storageTransferred = exclusive;
      await this.pipeline!.stop();
      await this.ocrQueueManager?.stop();
      if (exclusive) {
        await Promise.allSettled([...this.operations]);
        // PGlite owns its data directory exclusively; read-only flags don't
        // make a second process safe. Close before transferring ownership.
        await storage.close();
      } else {
        await storage.setReadOnly?.(true);
      }
      if (this.closing) return { indexed: 0, failed: 0, duration: 0 };

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

      this.childManager.on('child:exited', async (event) => {
        console.log(
          `[SearchSystem] Child process exited: pid=${event.pid}, code=${event.code}, batch=${event.batchNumber}`,
        );

        // Refresh main storage to see child's writes (lightweight, no reconnect)
        const storageWithRefresh = this.storage as
          | PGliteStorage
          | SQLiteVectorliteStorage;
        if (!exclusive && storageWithRefresh?.refresh && event.code === 0) {
          try {
            await storageWithRefresh.refresh();
            console.log(
              '[SearchSystem] Storage refreshed - now sees child writes',
            );
          } catch (error) {
            console.warn(
              '[SearchSystem] Failed to refresh:',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      });

      this.childManager.on('error', (event) => {
        console.error(
          `[SearchSystem] Child process error: ${event.error}, fatal=${event.fatal}`,
        );
      });

      // Run indexing in child process(es)
      const result = await this.childManager.indexAll({ force: options.force });

      void this.emit('indexing:completed', result);

      return result;
    } finally {
      this.childManager = null;

      if (exclusive && !this.closing) await storage.initialize();
      if (!exclusive) await storage.setReadOnly?.(false);
      this.storageTransferred = false;
    }
  }

  /**
   * Index all files in the current process.
   * Uses sync to detect changes and queues them for processing.
   */
  private async indexAllInProcess(options: {
    force?: boolean;
    maxDocuments?: number;
  }): Promise<{ indexed: number; failed: number; duration: number }> {
    const startTime = Date.now();

    // Sync only enqueues work; one tracked run drains both new and persisted items.
    await this.pipeline!.syncAndQueue({ forceReindex: options.force });
    if (this.closing)
      return { indexed: 0, failed: 0, duration: Date.now() - startTime };
    const { indexed, failed } = await this.drainQueue(
      options.maxDocuments,
      false,
    );

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
  }

  /**
   * Wait for pipeline to become idle.
   */
  private async waitForPipelineIdle(): Promise<void> {
    await this.pipeline?.waitForIdle();
  }

  /**
   * Index a single file.
   */
  async indexFile(filePath: string): Promise<boolean> {
    this.ensureInitialized();
    return this.runIndexing(async () => {
      if (this.closing || this.indexingAbortRequested) return false;
      return (await this.pipeline!.processFile(filePath)).success;
    });
  }

  /**
   * Replace a file after parsing and embedding succeed.
   */
  async reindexFile(filePath: string): Promise<boolean> {
    this.ensureInitialized();

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
    return this.trackOperation(
      (async () => {
        await this.pipeline!.queueFiles(filePaths, priority);
      })(),
    );
  }

  /**
   * Start processing queued items.
   */
  startProcessing(): void {
    this.ensureInitialized();
    if (this.indexingTask) return;
    void this.processQueue().catch((error: unknown) => {
      void this.emit('indexing:error', {
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });
  }

  /**
   * Stop processing.
   */
  async stopProcessing(): Promise<void> {
    this.ensureInitialized();
    this.indexingAbortRequested = true;
    await this.pipeline!.stop();
    await this.indexingTask;
  }

  /**
   * Check if the indexing pipeline is idle (not processing).
   * Used by SearchService/Supervisor to wait for processing to complete.
   */
  isProcessingIdle(): boolean {
    if (!this.pipeline) return true;
    return !this.indexingTask && this.pipeline.getState() === 'idle';
  }

  /**
   * Process items already in the queue with proper event emission.
   * Emits progress events, handles graceful shutdown, and returns when complete.
   *
   * Use this when you need to resume processing after a restart.
   */
  async processQueue(options: { maxDocuments?: number } = {}): Promise<{
    indexed: number;
    failed: number;
    duration: number;
  }> {
    this.ensureInitialized();

    return this.runIndexing(() => this.drainQueue(options.maxDocuments));
  }

  private runIndexing<T>(operation: () => Promise<T>): Promise<T> {
    if (this.indexingTask) throw new Error('Indexing already in progress');
    this.indexingInProgress = true;
    this.indexingAbortRequested = false;
    const task = Promise.resolve()
      .then(operation)
      .finally(() => {
        this.indexingInProgress = false;
        this.indexingTask = null;
      });
    this.indexingTask = task;
    return task;
  }

  private async drainQueue(
    maxDocuments?: number,
    emitCompleted = true,
  ): Promise<{ indexed: number; failed: number; duration: number }> {
    if (
      maxDocuments !== undefined &&
      (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0)
    ) {
      throw new Error('maxDocuments must be a positive integer');
    }
    const pipeline = this.pipeline!;
    const start = Date.now();
    const status = await this.storage!.getQueueStatus();
    const total = Math.min(
      status.pending + status.processing,
      maxDocuments ?? Infinity,
    );
    let indexed = 0;
    let failed = 0;
    const progress = () => {
      void this.emit('indexing:progress', { current: indexed + failed, total });
    };
    const unsubCompleted = pipeline.on('document:completed', () => {
      indexed++;
      progress();
    });
    const unsubFailed = pipeline.on('document:failed', () => {
      failed++;
      progress();
    });
    try {
      void this.emit('indexing:started', { fileCount: total });
      if (!this.closing && !this.indexingAbortRequested)
        pipeline.start(maxDocuments);
      await this.waitForPipelineIdle();
      const result = { indexed, failed, duration: Date.now() - start };
      if (emitCompleted) void this.emit('indexing:completed', result);
      return result;
    } finally {
      unsubCompleted();
      unsubFailed();
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    return operation.finally(() => {
      this.operations.delete(operation);
    });
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  /**
   * Perform a search with full options.
   */
  async search(options: SearchOptions): Promise<SearchResponse> {
    this.ensureInitialized();
    return this.trackOperation(this.searchEngine!.search(options));
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
    return this.trackOperation(
      this.searchEngine!.searchKeyword(query, filters, limit),
    );
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
    return this.trackOperation(
      this.searchEngine!.searchSemantic(query, filters, limit),
    );
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
    return this.trackOperation(
      this.searchEngine!.searchHybrid(query, filters, limit),
    );
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
    return this.trackOperation(this.storage!.getDocument(documentId));
  }

  /**
   * Get a document by file path.
   */
  async getDocumentByPath(
    filePath: string,
  ): Promise<import('../types.js').Document | null> {
    this.ensureInitialized();
    return this.trackOperation(this.storage!.getDocumentByPath(filePath));
  }

  /**
   * Get all chunks for a document.
   */
  async getDocumentChunks(
    documentId: string,
  ): Promise<Array<import('../types.js').DocumentChunk>> {
    this.ensureInitialized();
    return this.trackOperation(this.storage!.getChunks(documentId));
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  /**
   * Add tags to a file.
   */
  async addTags(filePath: string, tags: string[]): Promise<void> {
    this.ensureInitialized();
    return this.trackOperation(
      (async () => {
        const doc = await this.storage!.getDocumentByPath(filePath);
        if (!doc) {
          throw new Error(`Document not found: ${filePath}`);
        }

        await this.storage!.addTags(doc.id, tags);
      })(),
    );
  }

  /**
   * Remove tags from a file.
   */
  async removeTags(filePath: string, tags: string[]): Promise<void> {
    this.ensureInitialized();
    return this.trackOperation(
      (async () => {
        const doc = await this.storage!.getDocumentByPath(filePath);
        if (!doc) {
          throw new Error(`Document not found: ${filePath}`);
        }

        await this.storage!.removeTags(doc.id, tags);
      })(),
    );
  }

  /**
   * Get all tags for a file.
   */
  async getFileTags(filePath: string): Promise<string[]> {
    this.ensureInitialized();
    return this.trackOperation(
      (async () => {
        const doc = await this.storage!.getDocumentByPath(filePath);
        if (!doc) {
          throw new Error(`Document not found: ${filePath}`);
        }

        return this.storage!.getDocumentTags(doc.id);
      })(),
    );
  }

  /**
   * Get all tags with counts.
   */
  async getAllTags(): Promise<TagCount[]> {
    this.ensureInitialized();
    return this.trackOperation(this.storage!.getAllTags());
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
    return this.trackOperation(
      (async () => {
        const start = Date.now();
        const changes = options.dryRun
          ? await this.pipeline!.sync()
          : await this.pipeline!.syncAndQueue({ priority: options.priority });
        const remaining = await this.storage!.countDocuments();
        return {
          ...changes,
          unchanged: Math.max(
            0,
            remaining -
              changes.modified.length -
              (options.dryRun ? changes.deleted.length : 0),
          ),
          duration: Date.now() - start,
        };
      })(),
    );
  }

  /**
   * Check if sync is needed.
   */
  async needsSync(): Promise<boolean> {
    this.ensureInitialized();
    return this.trackOperation(
      (async () => {
        const changes = await this.pipeline!.sync();
        return (
          changes.added.length +
            changes.modified.length +
            changes.deleted.length >
          0
        );
      })(),
    );
  }

  // -------------------------------------------------------------------------
  // Stats & Status
  // -------------------------------------------------------------------------

  /**
   * Get search system statistics.
   */
  async getStats(): Promise<SearchStats> {
    this.ensureInitialized();
    return this.trackOperation(this.storage!.getStats());
  }

  /**
   * Get queue status.
   */
  async getQueueStatus(): Promise<QueueStatus> {
    this.ensureInitialized();
    return this.trackOperation(this.storage!.getQueueStatus());
  }

  /**
   * Get queue status with precision metadata and deferred reason breakdown.
   */
  async getQueueDetailedStatus(): Promise<QueueDetailedStatus> {
    this.ensureInitialized();
    return this.trackOperation(
      (async () => {
        if (this.storage!.getQueueDetailedStatus) {
          return this.storage!.getQueueDetailedStatus();
        }

        const base = await this.storage!.getQueueStatus();
        return {
          ...base,
          precision: 'approximate',
          deferredByReason: {
            raw_text_oversize: 0,
            raw_markup_oversize: 0,
            parsed_text_oversize: 0,
            unknown: base.byPriority.deferred,
          },
        };
      })(),
    );
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
  async getConfigValue<T>(key: string): Promise<T | null> {
    this.ensureInitialized();
    return this.trackOperation(this.storage!.getConfigValue<T>(key));
  }

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
      if (
        !IMAGE_EXTENSIONS_FOR_OCR.has(ext) ||
        this.indexingEmbedder?.canEmbedMedia?.(doc.filePath)
      ) {
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
    if (this.storageTransferred)
      throw new Error(
        'Knowledge base is indexing in a separate process; retry after indexing completes',
      );
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
