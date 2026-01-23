/**
 * Indexing Pipeline.
 * Orchestrates the flow: Discovery → Queue → Parser → Chunker → Embedder → Storage
 */

import type { StorageAdapter, CreateChunkInput } from '../storage/types.js';
import type { ParserRegistry } from '../parsers/ParserRegistry.js';
import type { ChunkerRegistry } from '../chunkers/ChunkerRegistry.js';
import type { Chunk } from '../chunkers/types.js';
import type { DiscoveredFile, QueuePriority } from '../types.js';
import {
  FileDiscovery,
  type DiscoveryOptions,
} from '../discovery/FileDiscovery.js';
import { EventEmitter } from '../core/EventEmitter.js';
import type {
  IndexingPipelineOptions,
  Embedder,
  PipelineEvents,
  PipelineState,
  PipelineStatus,
  ProcessingResult,
  BatchProcessingResult,
  SyncOptions,
  SyncChanges,
} from './types.js';
import type { FilePriorityClassifier } from './FilePriorityClassifier.js';
import { createFilePriorityClassifier } from './FilePriorityClassifier.js';
import { createModuleLogger } from '../core/Logger.js';

// Module logger for IndexingPipeline
const log = createModuleLogger('IndexingPipeline');

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PREPARE_WORKERS = 1;
const DEFAULT_PREPARED_BUFFER_SIZE = 1;
const DEFAULT_EMBEDDING_BATCH_SIZE = 8;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

// ============================================================================
// Utility: Event Loop Yielding
// ============================================================================

/** Yield to the event loop to prevent blocking */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

// ============================================================================
// Types
// ============================================================================

/**
 * Prepared file data ready for embedding.
 * Contains only the minimal data needed for embedding to reduce memory usage.
 * IMPORTANT: We store chunkTexts (strings) instead of full Chunk objects
 * to avoid holding metadata and other fields in memory while waiting for embedding.
 */
interface PreparedFile {
  queueItemId: string;
  queueItemAttempts: number;
  documentId: string;
  filePath: string;
  /** Chunk texts extracted for embedding - NOT full Chunk objects to save memory */
  chunkTexts: string[];
  chunkIds: string[];
  chunkCount: number;
  isNew: boolean;
  startTime: number;
  parsedMetadata: {
    requiresOcr: boolean;
    ocrRegions?: number;
  };
}

// ============================================================================
// IndexingPipeline Class
// ============================================================================

/**
 * Orchestrates document indexing from discovery to storage.
 */
export class IndexingPipeline extends EventEmitter<PipelineEvents> {
  private readonly storage: StorageAdapter;
  private readonly parserRegistry: ParserRegistry;
  private readonly chunkerRegistry: ChunkerRegistry;
  private readonly embedder: Embedder;
  private readonly classifier: FilePriorityClassifier;
  private readonly options: Required<
    Omit<
      IndexingPipelineOptions,
      | 'discoveryOptions'
      | 'parserOptions'
      | 'chunkerOptions'
      | 'pdfSizeThreshold'
    >
  > &
    Pick<
      IndexingPipelineOptions,
      | 'discoveryOptions'
      | 'parserOptions'
      | 'chunkerOptions'
      | 'pdfSizeThreshold'
    >;

  private state: PipelineState = 'idle';
  private processedCount = 0;
  private failedCount = 0;
  private processingStartTime: number | null = null;
  private abortController: AbortController | null = null;
  private timerCounter = 0; // Counter for unique timer keys in concurrent processing

  // Producer-consumer pipeline state
  private preparedBuffer: PreparedFile[] = [];
  private prepareWorkersRunning = 0;
  private embedLoopRunning = false;

  // Maintenance coordination - ensures workers pause at safe points during reconnect
  private maintenanceRequested = false;
  private maintenancePromise: Promise<void> | null = null;
  private maintenanceResolve: (() => void) | null = null;
  private lastMaintenanceAt = 0; // processedCount at last maintenance
  private readonly MAINTENANCE_INTERVAL = 200; // Reconnect every N files (lower = more frequent memory release, reduced from 500 for better WASM memory management)

  constructor(
    storage: StorageAdapter,
    parserRegistry: ParserRegistry,
    chunkerRegistry: ChunkerRegistry,
    embedder: Embedder,
    options: IndexingPipelineOptions,
  ) {
    super();
    this.storage = storage;
    this.parserRegistry = parserRegistry;
    this.chunkerRegistry = chunkerRegistry;
    this.embedder = embedder;
    this.options = {
      rootPath: options.rootPath,
      prepareWorkers: options.prepareWorkers ?? DEFAULT_PREPARE_WORKERS,
      preparedBufferSize:
        options.preparedBufferSize ?? DEFAULT_PREPARED_BUFFER_SIZE,
      embeddingBatchSize:
        options.embeddingBatchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE,
      autoStart: options.autoStart ?? true,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryDelay: options.retryDelay ?? DEFAULT_RETRY_DELAY,
      parserOptions: options.parserOptions,
      chunkerOptions: options.chunkerOptions,
      discoveryOptions: options.discoveryOptions,
      pdfSizeThreshold: options.pdfSizeThreshold,
    };
    this.classifier = createFilePriorityClassifier({
      pdfSizeThreshold: options.pdfSizeThreshold,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get the current pipeline state.
   */
  getState(): PipelineState {
    return this.state;
  }

  /**
   * Get the current pipeline status.
   */
  async getStatus(): Promise<PipelineStatus> {
    const queueStatus = await this.storage.getQueueStatus();
    const elapsed = this.processingStartTime
      ? (Date.now() - this.processingStartTime) / 1000
      : 0;

    const speed = elapsed > 0 ? (this.processedCount / elapsed) * 60 : 0;

    const remaining = queueStatus.pending + queueStatus.processing;
    const eta = speed > 0 ? (remaining / speed) * 60 : null;

    return {
      state: this.state,
      activeDocuments: this.preparedBuffer.length,
      queuedDocuments: queueStatus.pending,
      processedDocuments: this.processedCount,
      failedDocuments: this.failedCount,
      processingSpeed: speed,
      estimatedTimeRemaining: eta,
    };
  }

  /**
   * Discover files and sync with the index.
   * Returns changes detected without processing them.
   */
  async sync(options?: SyncOptions): Promise<SyncChanges> {
    const discoveryOpts: DiscoveryOptions = {
      rootPath: this.options.rootPath,
      ...this.options.discoveryOptions,
    };

    const discovery = new FileDiscovery(discoveryOpts);
    const discoveredFiles = await discovery.discoverAll();

    // Get existing file hashes from storage
    const existingHashes = await this.storage.getFileHashes();
    const existingPaths = new Set(existingHashes.keys());

    const changes: SyncChanges = {
      added: [],
      modified: [],
      deleted: [],
    };

    // Check each discovered file
    for (const file of discoveredFiles) {
      const existingHash = existingHashes.get(file.absolutePath);

      if (!existingHash) {
        // New file
        changes.added.push(file.absolutePath);
      } else if (options?.forceReindex || existingHash !== file.hash) {
        // Modified file
        changes.modified.push(file.absolutePath);
      }

      existingPaths.delete(file.absolutePath);
    }

    // Remaining paths are deleted files
    if (options?.deleteRemoved !== false) {
      changes.deleted = Array.from(existingPaths);
    }

    void this.emit('sync:changes_detected', changes);

    return changes;
  }

  /**
   * Sync and queue detected changes for processing.
   * Uses smart priority classification to process lightweight files first.
   */
  async syncAndQueue(options?: SyncOptions): Promise<SyncChanges> {
    const startTime = Date.now();

    // Discover files with full metadata (needed for classification)
    const discoveryOpts: DiscoveryOptions = {
      rootPath: this.options.rootPath,
      ...this.options.discoveryOptions,
    };
    const discovery = new FileDiscovery(discoveryOpts);
    const discoveredFiles = await discovery.discoverAll();

    // Build lookup map for discovered files (path -> DiscoveredFile)
    const discoveredMap = new Map<string, DiscoveredFile>();
    for (const file of discoveredFiles) {
      discoveredMap.set(file.absolutePath, file);
    }

    // Get existing file hashes from storage
    const existingHashes = await this.storage.getFileHashes();
    const existingPaths = new Set(existingHashes.keys());

    const changes: SyncChanges = {
      added: [],
      modified: [],
      deleted: [],
    };

    // Check each discovered file for changes
    for (const file of discoveredFiles) {
      const existingHash = existingHashes.get(file.absolutePath);

      if (!existingHash) {
        changes.added.push(file.absolutePath);
      } else if (options?.forceReindex || existingHash !== file.hash) {
        changes.modified.push(file.absolutePath);
      }

      existingPaths.delete(file.absolutePath);
    }

    // Remaining paths are deleted files
    if (options?.deleteRemoved !== false) {
      changes.deleted = Array.from(existingPaths);
    }

    void this.emit('sync:changes_detected', changes);

    // Delete removed documents
    for (const filePath of changes.deleted) {
      const doc = await this.storage.getDocumentByPath(filePath);
      if (doc) {
        await this.storage.deleteDocument(doc.id);
      }
    }

    // Queue new and modified files WITH SMART PRIORITY CLASSIFICATION
    const toQueuePaths = [...changes.added, ...changes.modified];
    if (toQueuePaths.length > 0) {
      // Get discovered file metadata for files to queue
      const toQueueFiles: DiscoveredFile[] = [];
      for (const filePath of toQueuePaths) {
        const file = discoveredMap.get(filePath);
        if (file) {
          toQueueFiles.push(file);
        }
      }

      // Classify files to determine priority
      const classified = await this.classifier.classifyAll(toQueueFiles);
      const summary = this.classifier.getSummary(classified);

      // Log classification summary
      console.log(
        `[IndexingPipeline] Queuing ${toQueuePaths.length} files with smart priority:`,
        `text=${summary.text}, markup=${summary.markup}, pdf=${summary.pdf},`,
        `image=${summary.image}, ocr=${summary.ocr}`,
      );

      // Enqueue with classified priorities (or override if specified)
      await this.storage.enqueueItems(
        classified.map((c) => ({
          filePath: c.filePath,
          fileSize: c.fileSize,
          priority: options?.priority ?? c.priority,
        })),
      );
    }

    const duration = Date.now() - startTime;
    void this.emit('sync:completed', {
      added: changes.added.length,
      modified: changes.modified.length,
      deleted: changes.deleted.length,
      duration,
    });

    // Auto-start if enabled
    if (
      this.options.autoStart &&
      toQueuePaths.length > 0 &&
      this.state === 'idle'
    ) {
      this.start();
    }

    return changes;
  }

  /**
   * Add a single file to the queue.
   */
  async queueFile(
    filePath: string,
    priority: QueuePriority = 'markup',
  ): Promise<void> {
    await this.storage.enqueueItem({ filePath, priority });

    if (this.options.autoStart && this.state === 'idle') {
      this.start();
    }
  }

  /**
   * Add multiple files to the queue.
   */
  async queueFiles(
    filePaths: string[],
    priority: QueuePriority = 'markup',
  ): Promise<void> {
    if (filePaths.length === 0) return;

    await this.storage.enqueueItems(
      filePaths.map((filePath) => ({ filePath, priority })),
    );

    if (this.options.autoStart && this.state === 'idle') {
      this.start();
    }
  }

  /**
   * Start processing the queue.
   * Launches N prepare workers (producers) and 1 embed loop (consumer).
   */
  start(): void {
    if (this.state === 'running') return;

    this.state = 'running';
    this.abortController = new AbortController();
    this.processingStartTime = Date.now();
    this.preparedBuffer = []; // Clear buffer

    void this.emit('pipeline:started', undefined);

    // Start prepare workers (producers)
    for (let i = 0; i < this.options.prepareWorkers; i++) {
      void this.prepareLoop();
    }

    // Start embed loop (consumer)
    void this.embedLoop();
  }

  /**
   * Pause processing (current items will complete).
   */
  pause(): void {
    if (this.state !== 'running') return;

    this.state = 'paused';
    void this.emit('pipeline:paused', undefined);
  }

  /**
   * Resume processing.
   */
  resume(): void {
    if (this.state !== 'paused') return;

    this.state = 'running';
    void this.emit('pipeline:resumed', undefined);

    // Restart workers
    for (let i = 0; i < this.options.prepareWorkers; i++) {
      void this.prepareLoop();
    }
    void this.embedLoop();
  }

  /**
   * Stop processing (waits for current items to complete).
   */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') return;

    this.state = 'stopping';
    this.abortController?.abort();

    // Wait for all loops to finish
    while (this.prepareWorkersRunning > 0 || this.embedLoopRunning) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // Clear any remaining buffer
    this.preparedBuffer = [];

    this.state = 'idle';
    this.abortController = null;
    void this.emit('pipeline:stopped', undefined);
  }

  // -------------------------------------------------------------------------
  // Maintenance Coordination
  // -------------------------------------------------------------------------

  /**
   * Check if maintenance (reconnect) is needed based on processed count.
   * Called by workers to determine if they should trigger maintenance.
   */
  private shouldPerformMaintenance(): boolean {
    if (!this.storage.reconnect) return false;
    if (this.maintenanceRequested) return false; // Already in progress
    if (this.processedCount === 0) return false;

    // Check if we've processed MAINTENANCE_INTERVAL files since last maintenance
    return (
      this.processedCount - this.lastMaintenanceAt >= this.MAINTENANCE_INTERVAL
    );
  }

  /**
   * Request and perform maintenance (reconnect) with proper worker coordination.
   *
   * This method orchestrates the maintenance process:
   * 1. Sets maintenanceRequested flag - workers will pause at their next safe point
   * 2. Waits for buffer to drain (embedLoop processes remaining items)
   * 3. Performs the maintenance operation (storage.reconnect)
   * 4. Releases workers to continue processing
   *
   * Safe to call from any worker - only one maintenance will run at a time.
   */
  private async performMaintenance(): Promise<void> {
    // Only one maintenance at a time
    if (this.maintenanceRequested) {
      // Already in progress, wait for it
      if (this.maintenancePromise) {
        await this.maintenancePromise;
      }
      return;
    }

    log.info('maintenance:starting', {
      processedCount: this.processedCount,
      bufferSize: this.preparedBuffer.length,
    });
    log.logMemory('maintenance:memoryBefore');

    // Signal workers to pause at their next safe point
    this.maintenanceRequested = true;
    this.maintenancePromise = new Promise<void>((resolve) => {
      this.maintenanceResolve = resolve;
    });

    // Wait for buffer to drain (embedLoop finishes current work)
    const waitStart = Date.now();
    while (this.preparedBuffer.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Safety timeout - if buffer doesn't drain within 60 seconds, something is wrong
      if (Date.now() - waitStart > 60000) {
        log.error('maintenance:timeout', {
          bufferSize: this.preparedBuffer.length,
          waitedMs: Date.now() - waitStart,
        });
        // Release and skip maintenance this round
        this.maintenanceRequested = false;
        this.maintenanceResolve?.();
        this.maintenancePromise = null;
        return;
      }
    }

    log.info('maintenance:bufferDrained', {
      waitedMs: Date.now() - waitStart,
    });

    // All workers are paused - safe to reconnect
    try {
      await this.storage.reconnect!();
      this.lastMaintenanceAt = this.processedCount;
      log.info('maintenance:complete', {
        processedCount: this.processedCount,
      });
      log.logMemory('maintenance:memoryAfter');
    } catch (error) {
      log.error('maintenance:error', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue anyway - storage should have auto-recovered
    }

    // Release workers
    this.maintenanceRequested = false;
    this.maintenanceResolve?.();
    this.maintenancePromise = null;
  }

  /**
   * Wait for any ongoing maintenance to complete.
   * Called by workers at safe points (before processing next item).
   */
  private async waitForMaintenance(): Promise<void> {
    if (this.maintenanceRequested && this.maintenancePromise) {
      log.debug('worker:waitingForMaintenance', {});
      await this.maintenancePromise;
    }
  }

  /**
   * Process a single document by file path.
   */
  async processFile(filePath: string): Promise<ProcessingResult> {
    const startTime = Date.now();
    // Use unique timer key to avoid collisions with concurrent processing
    const timerId = ++this.timerCounter;
    const processTimerKey = `processFile-${timerId}`;
    log.startTimer(processTimerKey, true); // true = track memory
    log.debug('processFile:start', {
      timerId,
      filePath,
      processedCount: this.processedCount,
    });

    // Get or create document
    let doc = await this.storage.getDocumentByPath(filePath);
    const isNew = !doc;

    if (isNew) {
      // Create new document record
      const { stat } = await import('node:fs/promises');
      const { basename, extname } = await import('node:path');

      const fileStats = await stat(filePath);
      const hash = await this.calculateFileHash(filePath);

      doc = await this.storage.createDocument({
        filePath,
        fileName: basename(filePath),
        fileExtension: extname(filePath).toLowerCase(),
        fileSize: fileStats.size,
        fileHash: hash,
        fileModifiedAt: fileStats.mtime,
        status: 'pending',
        ocrStatus: 'not_needed',
      });
    }

    // At this point doc is guaranteed to exist (either fetched or created above)
    const documentId = doc!.id;

    try {
      // Update status to parsing
      await this.storage.updateDocument(documentId, { status: 'parsing' });
      void this.emit('document:parsing', { documentId, filePath });

      // Parse the document
      const parsed = await this.parserRegistry.parse(
        filePath,
        this.options.parserOptions,
      );

      log.debug('processFile:parsed', {
        filePath,
        textLength: parsed.text.length,
        requiresOcr: parsed.requiresOcr,
      });

      // Update document with parsed metadata
      await this.storage.updateDocument(documentId, {
        title: parsed.title,
        author: parsed.metadata.author,
        language: parsed.metadata.language,
        pageCount: parsed.metadata.pageCount,
        status: 'chunking',
        ocrStatus: parsed.requiresOcr ? 'pending' : 'not_needed',
      });

      // Check if OCR is needed
      if (parsed.requiresOcr) {
        void this.emit('document:ocr_needed', {
          documentId,
          filePath,
          regions: parsed.ocrRegions?.length ?? 0,
        });
      }

      void this.emit('document:chunking', {
        documentId,
        filePath,
        textLength: parsed.text.length,
      });

      // Chunk the text
      const chunks = await this.chunkerRegistry.chunk(
        parsed.text,
        this.options.chunkerOptions,
      );

      log.debug('processFile:chunked', {
        filePath,
        chunkCount: chunks.length,
        avgChunkSize:
          chunks.length > 0
            ? Math.round(parsed.text.length / chunks.length)
            : 0,
      });

      // Delete existing chunks if re-indexing
      if (!isNew) {
        await this.storage.deleteChunks(documentId);
      }

      // Create chunk records
      const chunkInputs: CreateChunkInput[] = chunks.map((chunk) => ({
        chunkIndex: chunk.index,
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        page: chunk.metadata.page,
        section: chunk.metadata.section,
        tokenCount: chunk.metadata.tokenCount,
      }));

      const createdChunks = await this.storage.createChunks(
        documentId,
        chunkInputs,
      );

      log.debug('processFile:chunksStored', {
        filePath,
        chunkCount: createdChunks.length,
      });

      // Update status to embedding
      await this.storage.updateDocument(documentId, { status: 'embedding' });
      void this.emit('document:embedding', {
        documentId,
        filePath,
        chunkCount: chunks.length,
      });

      // Generate embeddings in batches
      if (this.embedder.isReady()) {
        const embTimerKey = `embeddings-${documentId}`;
        log.startTimer(embTimerKey, true);
        await this.generateEmbeddings(
          createdChunks.map((c) => c.id),
          chunks,
        );
        log.endTimer(embTimerKey, 'processFile:embeddingsGenerated', {
          filePath,
          chunkCount: chunks.length,
        });
      }

      // Update status to indexed
      const duration = Date.now() - startTime;
      await this.storage.updateDocument(documentId, {
        status: 'indexed',
        indexedAt: new Date(),
      });

      void this.emit('document:completed', {
        documentId,
        filePath,
        chunksCreated: chunks.length,
        duration,
      });

      log.endTimer(processTimerKey, 'processFile:complete', {
        timerId,
        filePath,
        chunksCreated: chunks.length,
        durationMs: duration,
        processedCount: this.processedCount,
      });
      log.logMemory('processFile:memoryAfter');

      return {
        documentId,
        filePath,
        success: true,
        chunksCreated: chunks.length,
        duration,
        status: 'indexed',
        ocrStatus: parsed.requiresOcr ? 'pending' : 'not_needed',
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const err = error instanceof Error ? error : new Error(String(error));

      log.endTimer(processTimerKey, 'processFile:error', {
        timerId,
        filePath,
        durationMs: duration,
        error: err.message,
      });

      await this.storage.updateDocument(documentId, {
        status: 'failed',
        metadata: { lastError: err.message },
      });

      return {
        documentId,
        filePath,
        success: false,
        chunksCreated: 0,
        duration,
        error: err,
        status: 'failed',
        ocrStatus: 'not_needed',
      };
    }
  }

  /**
   * Process multiple files in batch.
   */
  async processBatch(filePaths: string[]): Promise<BatchProcessingResult> {
    const startTime = Date.now();
    const results: ProcessingResult[] = [];

    let succeeded = 0;
    let failed = 0;

    for (const filePath of filePaths) {
      const result = await this.processFile(filePath);
      results.push(result);

      if (result.success) {
        succeeded++;
      } else {
        failed++;
      }

      void this.emit('progress', {
        stage: 'storing',
        current: results.length,
        total: filePaths.length,
        percentage: (results.length / filePaths.length) * 100,
      });
    }

    return {
      processed: results.length,
      succeeded,
      failed,
      duration: Date.now() - startTime,
      results,
    };
  }

  // -------------------------------------------------------------------------
  // Producer-Consumer Pipeline Methods
  // -------------------------------------------------------------------------

  /**
   * Prepare a file for embedding (parse, chunk, create DB records).
   * This is the "producer" work - prepares data for the embedder.
   */
  private async prepareFile(
    queueItemId: string,
    queueItemAttempts: number,
    filePath: string,
  ): Promise<PreparedFile> {
    const startTime = Date.now();
    const timerId = ++this.timerCounter;
    log.startTimer(`prepareFile-${timerId}`, true);
    log.debug('prepareFile:start', { timerId, filePath });

    // Get or create document
    let doc = await this.storage.getDocumentByPath(filePath);
    const isNew = !doc;

    if (isNew) {
      const { stat } = await import('node:fs/promises');
      const { basename, extname } = await import('node:path');

      const fileStats = await stat(filePath);
      const hash = await this.calculateFileHash(filePath);

      doc = await this.storage.createDocument({
        filePath,
        fileName: basename(filePath),
        fileExtension: extname(filePath).toLowerCase(),
        fileSize: fileStats.size,
        fileHash: hash,
        fileModifiedAt: fileStats.mtime,
        status: 'pending',
        ocrStatus: 'not_needed',
      });
    }

    const documentId = doc!.id;

    // Update status to parsing
    await this.storage.updateDocument(documentId, { status: 'parsing' });
    void this.emit('document:parsing', { documentId, filePath });

    // Parse the document
    const parsed = await this.parserRegistry.parse(
      filePath,
      this.options.parserOptions,
    );

    log.debug('prepareFile:parsed', {
      filePath,
      textLength: parsed.text.length,
      requiresOcr: parsed.requiresOcr,
    });

    // Update document with parsed metadata
    await this.storage.updateDocument(documentId, {
      title: parsed.title,
      author: parsed.metadata.author,
      language: parsed.metadata.language,
      pageCount: parsed.metadata.pageCount,
      status: 'chunking',
      ocrStatus: parsed.requiresOcr ? 'pending' : 'not_needed',
    });

    void this.emit('document:chunking', {
      documentId,
      filePath,
      textLength: parsed.text.length,
    });

    // Chunk the text
    const chunks = await this.chunkerRegistry.chunk(
      parsed.text,
      this.options.chunkerOptions,
    );

    log.debug('prepareFile:chunked', {
      filePath,
      chunkCount: chunks.length,
    });

    // Delete existing chunks if re-indexing
    if (!isNew) {
      await this.storage.deleteChunks(documentId);
    }

    // Create chunk records (without embeddings yet)
    const chunkInputs: CreateChunkInput[] = chunks.map((chunk) => ({
      chunkIndex: chunk.index,
      text: chunk.text,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      page: chunk.metadata.page,
      section: chunk.metadata.section,
      tokenCount: chunk.metadata.tokenCount,
    }));

    const createdChunks = await this.storage.createChunks(
      documentId,
      chunkInputs,
    );

    log.endTimer(`prepareFile-${timerId}`, 'prepareFile:complete', {
      timerId,
      filePath,
      chunkCount: chunks.length,
    });

    // Extract only chunk texts for embedding - don't hold full Chunk objects in memory
    const chunkTexts = chunks.map((c) => c.text);
    const chunkCount = chunks.length;

    return {
      queueItemId,
      queueItemAttempts,
      documentId,
      filePath,
      chunkTexts,
      chunkIds: createdChunks.map((c) => c.id),
      chunkCount,
      isNew,
      startTime,
      parsedMetadata: {
        requiresOcr: parsed.requiresOcr,
        ocrRegions: parsed.ocrRegions?.length,
      },
    };
  }

  /**
   * Embed a prepared file and complete indexing.
   * This is the "consumer" work - generates embeddings and stores them.
   */
  private async embedFile(prepared: PreparedFile): Promise<void> {
    const { documentId, filePath, chunkTexts, chunkIds, chunkCount } = prepared;

    // Update status to embedding
    await this.storage.updateDocument(documentId, { status: 'embedding' });
    void this.emit('document:embedding', {
      documentId,
      filePath,
      chunkCount,
    });

    // Generate embeddings in batches
    if (this.embedder.isReady() && chunkCount > 0) {
      const embTimerKey = `embeddings-${documentId}`;
      log.startTimer(embTimerKey, true);
      await this.generateEmbeddingsFromTexts(chunkIds, chunkTexts);
      log.endTimer(embTimerKey, 'embedFile:embeddingsGenerated', {
        filePath,
        chunkCount,
      });
    }

    // Update status to indexed
    await this.storage.updateDocument(documentId, {
      status: 'indexed',
      indexedAt: new Date(),
    });

    // Emit OCR needed if required
    if (prepared.parsedMetadata.requiresOcr) {
      void this.emit('document:ocr_needed', {
        documentId,
        filePath,
        regions: prepared.parsedMetadata.ocrRegions ?? 0,
      });
    }
  }

  /**
   * Producer loop: Prepares files (parse, chunk, create records).
   * Multiple instances run in parallel to keep the buffer fed.
   */
  private async prepareLoop(): Promise<void> {
    this.prepareWorkersRunning++;

    try {
      while (this.state === 'running') {
        // Backpressure: wait if buffer is full
        if (this.preparedBuffer.length >= this.options.preparedBufferSize) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }

        // Check abort
        if (this.abortController?.signal.aborted) break;

        // Maintenance coordination
        if (this.shouldPerformMaintenance()) {
          await this.performMaintenance();
        }
        await this.waitForMaintenance();

        if (this.state !== 'running') break;

        // Dequeue next item
        const item = await this.storage.dequeueItem();

        if (!item) {
          // Queue empty - check if we should exit
          const status = await this.storage.getQueueStatus();
          if (status.pending === 0 && status.processing === 0) {
            // No more items in queue, prepareLoop can exit
            // embedLoop will drain the buffer and complete
            break;
          }

          // Still items being processed, wait and retry
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        try {
          // Update queue status
          await this.storage.updateQueueItem(item.id, {
            status: 'processing',
            startedAt: new Date(),
          });

          void this.emit('document:started', {
            documentId: '',
            filePath: item.filePath,
            queueItemId: item.id,
          });

          // Prepare the file
          const prepared = await this.prepareFile(
            item.id,
            item.attempts,
            item.filePath,
          );

          // Push to buffer for embedding
          this.preparedBuffer.push(prepared);
        } catch (error) {
          // Handle preparation error
          await this.handlePrepareError(
            item.id,
            item.filePath,
            item.attempts,
            error,
          );
        }
      }
    } finally {
      this.prepareWorkersRunning--;

      // If all prepare workers done and buffer empty, signal completion
      if (
        this.prepareWorkersRunning === 0 &&
        this.preparedBuffer.length === 0
      ) {
        // embedLoop will detect this and stop
      }
    }
  }

  /**
   * Consumer loop: Embeds prepared files.
   * Single instance that pulls from the prepared buffer.
   */
  private async embedLoop(): Promise<void> {
    this.embedLoopRunning = true;

    try {
      while (this.state === 'running' || this.preparedBuffer.length > 0) {
        // Wait if buffer is empty but prepare workers still running
        if (this.preparedBuffer.length === 0) {
          if (this.prepareWorkersRunning === 0) {
            // All prepare workers done and buffer empty = we're done
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }

        // Check abort
        if (this.abortController?.signal.aborted) break;

        // Pull next prepared file
        const prepared = this.preparedBuffer.shift()!;

        try {
          // Embed the file
          await this.embedFile(prepared);

          // Mark queue item complete
          await this.storage.updateQueueItem(prepared.queueItemId, {
            status: 'completed',
            completedAt: new Date(),
          });

          this.processedCount++;

          const duration = Date.now() - prepared.startTime;
          void this.emit('document:completed', {
            documentId: prepared.documentId,
            filePath: prepared.filePath,
            chunksCreated: prepared.chunkCount,
            duration,
          });

          log.debug('embedLoop:fileComplete', {
            filePath: prepared.filePath,
            chunkCount: prepared.chunkCount,
            durationMs: duration,
            processedCount: this.processedCount,
          });

          // Progress logging
          if (this.processedCount % 100 === 0) {
            log.info('embedLoop:progress', {
              processedCount: this.processedCount,
            });
            log.logMemory('embedLoop:memoryAt100');
          }

          // Checkpoint every 20 files (more frequent = better memory management)
          if (this.processedCount % 50 === 0 && this.storage.checkpoint) {
            log.info('embedLoop:checkpoint', {
              processedCount: this.processedCount,
            });
            await this.storage.checkpoint();
          }
        } catch (error) {
          // Handle embedding error
          await this.handleEmbedError(prepared, error);
        } finally {
          // Help GC by clearing large arrays (texts can be significant)
          prepared.chunkTexts.length = 0;
          prepared.chunkIds.length = 0;
        }
      }
    } finally {
      this.embedLoopRunning = false;

      // Signal completion if everything is done
      if (
        this.prepareWorkersRunning === 0 &&
        this.preparedBuffer.length === 0
      ) {
        this.state = 'idle';
        void this.emit('pipeline:stopped', undefined);
      }
    }
  }

  /**
   * Handle error during file preparation.
   */
  private async handlePrepareError(
    queueItemId: string,
    filePath: string,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    const err = error instanceof Error ? error : new Error(String(error));
    const newAttempts = attempts + 1;

    log.error('prepareLoop:error', {
      filePath,
      attempts: newAttempts,
      error: err.message,
    });

    if (newAttempts < this.options.maxRetries) {
      // Retry later
      await this.storage.updateQueueItem(queueItemId, {
        status: 'pending',
        attempts: newAttempts,
        lastError: err.message,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, this.options.retryDelay * newAttempts),
      );
    } else {
      // Max retries reached
      await this.storage.updateQueueItem(queueItemId, {
        status: 'failed',
        attempts: newAttempts,
        lastError: err.message,
        completedAt: new Date(),
      });
      this.failedCount++;
      void this.emit('document:failed', {
        documentId: '',
        filePath,
        error: err,
        attempts: newAttempts,
      });
    }
  }

  /**
   * Handle error during file embedding.
   */
  private async handleEmbedError(
    prepared: PreparedFile,
    error: unknown,
  ): Promise<void> {
    const err = error instanceof Error ? error : new Error(String(error));

    log.error('embedLoop:error', {
      filePath: prepared.filePath,
      documentId: prepared.documentId,
      error: err.message,
    });

    // Update document status
    await this.storage.updateDocument(prepared.documentId, {
      status: 'failed',
      metadata: { lastError: err.message },
    });

    // Update queue item
    await this.storage.updateQueueItem(prepared.queueItemId, {
      status: 'failed',
      lastError: err.message,
      completedAt: new Date(),
    });

    this.failedCount++;
    void this.emit('document:failed', {
      documentId: prepared.documentId,
      filePath: prepared.filePath,
      error: err,
      attempts: prepared.queueItemAttempts + 1,
    });
  }

  // -------------------------------------------------------------------------
  // Private Helper Methods
  // -------------------------------------------------------------------------

  /**
   * Generate embeddings for chunks in batches.
   * Uses embedBatchDocuments if available (for proper E5 prefix handling),
   * otherwise falls back to embedBatch.
   *
   * The embedder handles batch size fallback internally - if a batch fails,
   * it halves the batch size and retries until success or minimum batch size.
   */
  private async generateEmbeddings(
    chunkIds: string[],
    chunks: Chunk[],
  ): Promise<void> {
    const texts = chunks.map((c) => c.text);
    await this.generateEmbeddingsFromTexts(chunkIds, texts);
  }

  /**
   * Generate embeddings from text strings in batches.
   * Memory-optimized version that works with pre-extracted texts.
   */
  private async generateEmbeddingsFromTexts(
    chunkIds: string[],
    texts: string[],
  ): Promise<void> {
    const batchSize = this.options.embeddingBatchSize;

    log.debug('generateEmbeddings:start', {
      totalChunks: texts.length,
      batchSize: this.options.embeddingBatchSize,
    });

    for (let i = 0; i < texts.length; i += batchSize) {
      // Yield to event loop between batches to prevent blocking
      if (i > 0) {
        await yieldToEventLoop();
      }

      const batchTexts = texts.slice(i, i + batchSize);
      const batchIds = chunkIds.slice(i, i + batchSize);

      // Use embedBatchDocuments if available (handles E5 prefix),
      // otherwise fall back to embedBatch
      const embeddings = this.embedder.embedBatchDocuments
        ? await this.embedder.embedBatchDocuments(batchTexts)
        : await this.embedder.embedBatch(batchTexts);

      const updates = batchIds.map((id, index) => ({
        id,
        embedding: embeddings[index],
      }));

      await this.storage.updateChunkEmbeddings(updates);

      log.debug('generateEmbeddings:batch', {
        batchIndex: Math.floor(i / batchSize),
        batchStart: i,
        batchEnd: Math.min(i + batchSize, texts.length),
        totalBatches: Math.ceil(texts.length / batchSize),
      });
    }
  }

  /**
   * Calculate file hash for change detection.
   */
  private async calculateFileHash(filePath: string): Promise<string> {
    try {
      const { readFile } = await import('node:fs/promises');
      const xxhashModule = (await import('xxhash-wasm')) as unknown as {
        default?: {
          xxhash64: () => Promise<{
            update(data: Buffer): { digest(enc: string): string };
          }>;
        };
        xxhash64?: () => Promise<{
          update(data: Buffer): { digest(enc: string): string };
        }>;
      };
      const xxhash64 = xxhashModule.default?.xxhash64 || xxhashModule.xxhash64;
      if (!xxhash64) throw new Error('xxhash64 not available');
      const content = await readFile(filePath);
      const hasher = await xxhash64();
      return hasher.update(content).digest('hex');
    } catch {
      // Fallback
      const { stat } = await import('node:fs/promises');
      const stats = await stat(filePath);
      return `${stats.size}-${stats.mtimeMs}`;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new IndexingPipeline instance.
 */
export function createIndexingPipeline(
  storage: StorageAdapter,
  parserRegistry: ParserRegistry,
  chunkerRegistry: ChunkerRegistry,
  embedder: Embedder,
  options: IndexingPipelineOptions,
): IndexingPipeline {
  return new IndexingPipeline(
    storage,
    parserRegistry,
    chunkerRegistry,
    embedder,
    options,
  );
}
