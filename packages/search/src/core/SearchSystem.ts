/**
 * SearchSystem - Main orchestrator for the Auditaria Search system.
 * Provides a high-level API for initializing, indexing, and searching documents.
 */

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
import { globalLogger, LogLevel, type LoggerConfig } from './Logger.js';

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

    // Initialize storage
    const dbConfig: DatabaseConfig = {
      path: join(this.rootPath, this.config.database.path),
      inMemory: this.config.database.inMemory,
    };

    this.storage = new PGliteStorage(dbConfig);
    await this.storage.initialize();

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
          },
          (progress) => {
            if (progress.stage === 'download' && progress.file) {
              console.log(
                `[SearchSystem] Downloading: ${progress.file} ${Math.round(progress.progress)}%`,
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
      json:true, // Human readable in console, JSON in file
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
   */
  async close(): Promise<void> {
    // Stop pipeline first to prevent race condition with storage
    if (this.pipeline) {
      await this.pipeline.stop();
      this.pipeline = null;
    }

    // Stop OCR queue manager
    if (this.ocrQueueManager) {
      await this.ocrQueueManager.stop();
      this.ocrQueueManager = null;
    }

    // Dispose OCR registry
    if (this.ocrRegistry) {
      await this.ocrRegistry.disposeAll();
      this.ocrRegistry = null;
    }

    if (this.storage) {
      await this.storage.close();
      this.storage = null;
    }

    if (this.indexingEmbedder) {
      await this.indexingEmbedder.dispose();
      this.indexingEmbedder = null;
    }

    if (this.searchEmbedder) {
      await this.searchEmbedder.dispose();
      this.searchEmbedder = null;
    }

    this.resolvedEmbedderConfig = null;
    this.initialized = false;
    this.ocrAvailable = false;
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
   */
  async indexAll(
    options: { force?: boolean } = {},
  ): Promise<{ indexed: number; failed: number; duration: number }> {
    this.ensureInitialized();

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

      const totalToProcess = changes.added.length + changes.modified.length;

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
      });

      // Wait for pipeline to finish
      await this.waitForPipelineIdle();

      // Cleanup
      unsubCompleted();
      unsubFailed();

      // Process OCR queue if enabled
      if (this.isOcrAvailable()) {
        // Also check for existing image documents that need OCR
        // (they might have been indexed before but OCR wasn't completed)
        await this.enqueueExistingImagesForOcr();

        const ocrStatus = this.ocrQueueManager!.getStatus();
        if (ocrStatus.pendingJobs > 0) {
          console.log(
            `[SearchSystem] Processing ${ocrStatus.pendingJobs} OCR job(s)...`,
          );
          const ocrResult = await this.ocrQueueManager!.processAll();
          console.log(
            `[SearchSystem] OCR completed: ${ocrResult.succeeded} succeeded, ${ocrResult.failed} failed`,
          );
        }
      }

      const duration = Date.now() - startTime;
      void this.emit('indexing:completed', { indexed, failed, duration });

      return { indexed, failed, duration };
    } finally {
      this.indexingInProgress = false;
    }
  }

  /**
   * Wait for pipeline to become idle.
   */
  private async waitForPipelineIdle(): Promise<void> {
    while (this.pipeline!.getState() !== 'idle') {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
