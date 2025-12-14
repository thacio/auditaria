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
import { MockEmbedder, TransformersJsEmbedder } from '../embedders/index.js';
import type { TextEmbedder } from '../embedders/types.js';
import { IndexingPipeline } from '../indexing/index.js';
import type { Embedder } from '../indexing/types.js';
import { createSearchEngine, type SearchEngine } from '../search/index.js';
import { createStartupSync, type StartupSync } from '../sync/StartupSync.js';
import { createFileWatcher, type FileWatcher } from '../sync/FileWatcher.js';
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

// ============================================================================
// Types
// ============================================================================

export interface SearchSystemInitOptions {
  /** Root path to index. Defaults to current working directory */
  rootPath?: string;
  /** Configuration overrides */
  config?: DeepPartial<SearchSystemConfig>;
  /** Use mock embedder (for testing) */
  useMockEmbedder?: boolean;
  /** Enable real-time file watching */
  enableFileWatcher?: boolean;
}

export interface SearchSystemState {
  initialized: boolean;
  rootPath: string;
  databasePath: string;
  indexingInProgress: boolean;
  fileWatcherEnabled: boolean;
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
  private fileWatcher: FileWatcher | null = null;
  private embedder: TextEmbedder | null = null;
  private ocrRegistry: OcrRegistry | null = null;
  private ocrQueueManager: OcrQueueManager | null = null;
  private initialized: boolean = false;
  private indexingInProgress: boolean = false;
  private useMockEmbedder: boolean = false;
  private fileWatcherEnabled: boolean = false;
  private ocrAvailable: boolean = false;

  private constructor(
    rootPath: string,
    config: SearchSystemConfig,
    useMockEmbedder: boolean = false,
    enableFileWatcher: boolean = false,
  ) {
    super();
    this.rootPath = resolve(rootPath);
    this.config = config;
    this.useMockEmbedder = useMockEmbedder;
    this.fileWatcherEnabled = enableFileWatcher;
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
      options.enableFileWatcher ?? false,
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
      options.enableFileWatcher ?? false,
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

    // Initialize embedder
    if (this.useMockEmbedder) {
      this.embedder = new MockEmbedder(this.config.embeddings.dimensions);
      console.log('[SearchSystem] Using MockEmbedder');
    } else {
      // Use TransformersJsEmbedder directly for real embedding
      this.embedder = new TransformersJsEmbedder({
        modelId: this.config.embeddings.model,
      });
      console.log(
        `[SearchSystem] Using TransformersJsEmbedder with model: ${this.config.embeddings.model}`,
      );
    }

    // Initialize the embedder (downloads model if needed)
    console.log('[SearchSystem] Initializing embedder...');
    await this.embedder.initialize((progress) => {
      if (progress.stage === 'download' && progress.file) {
        console.log(
          `[SearchSystem] Downloading: ${progress.file} ${Math.round(progress.progress)}%`,
        );
      }
    });
    console.log('[SearchSystem] Embedder ready');

    // Initialize pipeline
    const parserRegistry = createParserRegistry();
    const chunkerRegistry = createChunkerRegistry();

    this.pipeline = new IndexingPipeline(
      this.storage,
      parserRegistry,
      chunkerRegistry,
      this.embedder as Embedder,
      {
        rootPath: this.rootPath,
        autoStart: false,
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

    // Initialize search engine
    this.searchEngine = createSearchEngine(this.storage, this.embedder, {
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

    // Initialize file watcher (optional)
    if (this.fileWatcherEnabled) {
      this.fileWatcher = createFileWatcher(
        this.rootPath,
        this.storage,
        {
          enabled: true,
          debounceMs: 300,
          ignorePaths: this.config.indexing.ignorePaths,
          maxFileSize: this.config.indexing.maxFileSize,
        },
        this.config.indexing.fileTypes,
      );
    }

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
            this.embedder as Embedder,
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
   * Close the search system and release resources.
   */
  async close(): Promise<void> {
    // Stop pipeline first to prevent race condition with storage
    if (this.pipeline) {
      await this.pipeline.stop();
      this.pipeline = null;
    }

    if (this.fileWatcher) {
      await this.fileWatcher.stop();
      this.fileWatcher = null;
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

    if (this.embedder) {
      await this.embedder.dispose();
      this.embedder = null;
    }

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
    priority: 'high' | 'normal' | 'low' = 'normal',
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

  /**
   * Start real-time file watching.
   */
  async startFileWatcher(): Promise<void> {
    this.ensureInitialized();

    if (!this.fileWatcher) {
      this.fileWatcher = createFileWatcher(
        this.rootPath,
        this.storage!,
        {
          enabled: true,
          debounceMs: 300,
          ignorePaths: this.config.indexing.ignorePaths,
          maxFileSize: this.config.indexing.maxFileSize,
        },
        this.config.indexing.fileTypes,
      );
    }

    await this.fileWatcher.start();
  }

  /**
   * Stop real-time file watching.
   */
  async stopFileWatcher(): Promise<void> {
    if (this.fileWatcher) {
      await this.fileWatcher.stop();
    }
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
      fileWatcherEnabled: this.fileWatcher?.isWatching() ?? false,
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
