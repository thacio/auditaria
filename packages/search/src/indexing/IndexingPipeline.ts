/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
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
import { createModuleLogger, globalLogger } from '../core/Logger.js';
import { join, isAbsolute, relative } from 'node:path';

// Module logger for IndexingPipeline
const log = createModuleLogger('IndexingPipeline');

/**
 * Error thrown when a file no longer exists on disk.
 * Used to distinguish file-not-found errors from other transient errors,
 * allowing the pipeline to fail immediately without wasteful retries.
 */
class FileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`File no longer exists: ${filePath}`);
    this.name = 'FileNotFoundError';
  }
}

/**
 * Error thrown when a file is detected as binary/garbage content.
 * Fails immediately without retries.
 */
class GarbageFileError extends Error {
  constructor(filePath: string, phase: 'pre-parse' | 'post-parse') {
    super(`Binary/garbage content detected (${phase}): ${filePath}`);
    this.name = 'GarbageFileError';
  }
}

/**
 * Error thrown when parsed text exceeds the maximum allowed size.
 * Fails immediately without retries — file is too large to index.
 */
class FileTooLargeError extends Error {
  constructor(filePath: string, textSize: number, maxSize: number) {
    super(
      `Parsed text too large to index: ${filePath} ` +
        `(${(textSize / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(1)}MB limit)`,
    );
    this.name = 'FileTooLargeError';
  }
}

/**
 * Error thrown when parsed text is large enough to warrant deferral.
 * NOT a failure — the queue item should be demoted to 'deferred' priority
 * and re-processed after all higher-priority items are done.
 */
class FileDeferredError extends Error {
  constructor(filePath: string, textSize: number) {
    super(
      `Parsed text deferred: ${filePath} ` +
        `(${(textSize / 1024 / 1024).toFixed(1)}MB — will process after smaller files)`,
    );
    this.name = 'FileDeferredError';
  }
}

/**
 * Error thrown when parsing a deferred item exceeds the allowed timeout.
 * This is treated as a terminal failure to avoid infinite deferred retries.
 */
class DeferredRetryParseTimeoutError extends Error {
  constructor(filePath: string, timeoutMs: number) {
    super(
      `Deferred parse retry timed out after ${Math.round(timeoutMs / 60000)} minutes: ${filePath}. ` +
        'Marking as failed and disabling future retries.',
    );
    this.name = 'DeferredRetryParseTimeoutError';
  }
}

/**
 * Normalize path separators to forward slashes for cross-platform DB compatibility.
 * Windows uses backslashes, but we store forward slashes so databases can be shared
 * across Windows, Linux, and Mac without causing duplicate entries.
 */
function normalizeSeparators(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * Resolve a file path to an absolute path.
 * If the path is already absolute, returns it as-is.
 * If the path is relative, joins it with rootPath.
 */
function toAbsolutePath(rootPath: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return join(rootPath, filePath);
}

/**
 * Ensure a file path is relative to rootPath with normalized separators.
 * If the path is absolute, extracts the relative part.
 * If the path is already relative, normalizes separators.
 * Always returns forward slashes for cross-platform DB compatibility.
 */
function toRelativePath(rootPath: string, filePath: string): string {
  if (isAbsolute(filePath)) {
    // Convert absolute path to relative and normalize
    return normalizeSeparators(relative(rootPath, filePath));
  }
  // Already relative, just normalize separators
  return normalizeSeparators(filePath);
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PREPARE_WORKERS = 1;
const DEFAULT_PREPARED_BUFFER_SIZE = 1;
const DEFAULT_EMBEDDING_BATCH_SIZE = 8;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;
const DEFAULT_DEFERRED_RETRY_PARSE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MAX_PARSED_TEXT_SIZE = 5 * 1024 * 1024; // 5MB — skip entirely
const DEFAULT_DEFER_PARSED_TEXT_SIZE = 2 * 1024 * 1024; // 2MB — deprioritize

// ============================================================================
// Utility: Event Loop Yielding
// ============================================================================

/** Yield to the event loop to prevent blocking */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Wrap a promise with a timeout.
 * The underlying operation is not cancelled; we only stop waiting for it.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutErrorFactory: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(timeoutErrorFactory());
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

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
      | 'maxRawTextFileSize'
      | 'maxRawMarkupFileSize'
    >
  > &
    Pick<
      IndexingPipelineOptions,
      | 'discoveryOptions'
      | 'parserOptions'
      | 'chunkerOptions'
      | 'pdfSizeThreshold'
      | 'maxRawTextFileSize'
      | 'maxRawMarkupFileSize'
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
      maxParsedTextSize:
        options.maxParsedTextSize ?? DEFAULT_MAX_PARSED_TEXT_SIZE,
      deferParsedTextSize:
        options.deferParsedTextSize ?? DEFAULT_DEFER_PARSED_TEXT_SIZE,
      deferredRetryParseTimeoutMs:
        options.deferredRetryParseTimeoutMs ??
        DEFAULT_DEFERRED_RETRY_PARSE_TIMEOUT_MS,
      enableGarbageDetection: options.enableGarbageDetection ?? true,
      parserOptions: options.parserOptions,
      chunkerOptions: options.chunkerOptions,
      discoveryOptions: options.discoveryOptions,
      pdfSizeThreshold: options.pdfSizeThreshold,
      maxRawTextFileSize: options.maxRawTextFileSize,
      maxRawMarkupFileSize: options.maxRawMarkupFileSize,
    };
    this.classifier = createFilePriorityClassifier({
      pdfSizeThreshold: options.pdfSizeThreshold,
      maxRawTextFileSize: options.maxRawTextFileSize,
      maxRawMarkupFileSize: options.maxRawMarkupFileSize,
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

    // Check each discovered file (use relativePath for DB storage/comparison)
    for (const file of discoveredFiles) {
      const existingHash = existingHashes.get(file.relativePath);

      if (!existingHash) {
        // New file
        changes.added.push(file.relativePath);
      } else if (options?.forceReindex || existingHash !== file.hash) {
        // Modified file
        changes.modified.push(file.relativePath);
      }

      existingPaths.delete(file.relativePath);
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

    // Build lookup map for discovered files (relativePath -> DiscoveredFile)
    const discoveredMap = new Map<string, DiscoveredFile>();
    for (const file of discoveredFiles) {
      discoveredMap.set(file.relativePath, file);
    }

    // Get existing file hashes from storage (keyed by relativePath)
    const existingHashes = await this.storage.getFileHashes();
    const existingPaths = new Set(existingHashes.keys());

    const changes: SyncChanges = {
      added: [],
      modified: [],
      deleted: [],
    };

    // Check each discovered file for changes (use relativePath for DB storage/comparison)
    for (const file of discoveredFiles) {
      const existingHash = existingHashes.get(file.relativePath);

      if (!existingHash) {
        changes.added.push(file.relativePath);
      } else if (options?.forceReindex || existingHash !== file.hash) {
        changes.modified.push(file.relativePath);
      }

      existingPaths.delete(file.relativePath);
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
      // eslint-disable-next-line no-console
      console.log(
        `[IndexingPipeline] Queuing ${toQueuePaths.length} files with smart priority:`,
        `text=${summary.text}, markup=${summary.markup}, pdf=${summary.pdf},`,
        `image=${summary.image}, ocr=${summary.ocr}, deferred=${summary.deferred}`,
      );

      // Enqueue with classified priorities (or override if specified)
      await this.storage.enqueueItems(
        classified.map((c) => ({
          filePath: c.filePath,
          fileSize: c.fileSize,
          priority: options?.priority ?? c.priority,
          deferReason: options?.priority ? null : (c.deferReason ?? null),
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

      // Clear accumulated logger state (timers, benchmarks) to prevent memory leaks
      globalLogger.clearAll();

      log.info('maintenance:complete', {
        processedCount: this.processedCount,
      });
      log.logMemory('maintenance:memoryAfter');

      // Emit event so SearchSystem can trigger backup at this safe point
      void this.emit('maintenance:completed', {
        processedCount: this.processedCount,
      });
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
   * Accepts both absolute and relative paths for backward compatibility.
   * @param filePath - Path to the file (absolute or relative to rootPath)
   */
  async processFile(filePath: string): Promise<ProcessingResult> {
    const startTime = Date.now();
    // Use unique timer key to avoid collisions with concurrent processing
    const timerId = ++this.timerCounter;
    const processTimerKey = `processFile-${timerId}`;
    log.startTimer(processTimerKey, true); // true = track memory

    // Normalize paths: relative for DB storage, absolute for file I/O
    const relativePath = toRelativePath(this.options.rootPath, filePath);
    const absolutePath = toAbsolutePath(this.options.rootPath, filePath);

    log.debug('processFile:start', {
      timerId,
      filePath: relativePath,
      processedCount: this.processedCount,
    });

    // Get or create document (using relative path for DB)
    let doc = await this.storage.getDocumentByPath(relativePath);
    const isNew = !doc;

    if (isNew) {
      // Create new document record
      const { stat } = await import('node:fs/promises');
      const { basename, extname } = await import('node:path');

      const fileStats = await stat(absolutePath);
      const hash = await this.calculateFileHash(absolutePath);

      doc = await this.storage.createDocument({
        filePath: relativePath, // Store relative path in DB
        fileName: basename(relativePath),
        fileExtension: extname(relativePath).toLowerCase(),
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
      void this.emit('document:parsing', {
        documentId,
        filePath: relativePath,
      });

      // Parse the document (using absolute path for file I/O)
      const parsed = await this.parserRegistry.parse(
        absolutePath,
        this.options.parserOptions,
      );

      log.debug('processFile:parsed', {
        filePath: relativePath,
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
          filePath: relativePath,
          regions: parsed.ocrRegions?.length ?? 0,
        });
      }

      void this.emit('document:chunking', {
        documentId,
        filePath: relativePath,
        textLength: parsed.text.length,
      });

      // Chunk the text
      const chunks = await this.chunkerRegistry.chunk(
        parsed.text,
        this.options.chunkerOptions,
      );

      log.debug('processFile:chunked', {
        filePath: relativePath,
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
        filePath: relativePath,
        chunkCount: createdChunks.length,
      });

      // Update status to embedding
      await this.storage.updateDocument(documentId, { status: 'embedding' });
      void this.emit('document:embedding', {
        documentId,
        filePath: relativePath,
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
          filePath: relativePath,
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
        filePath: relativePath,
        chunksCreated: chunks.length,
        duration,
      });

      log.endTimer(processTimerKey, 'processFile:complete', {
        timerId,
        filePath: relativePath,
        chunksCreated: chunks.length,
        durationMs: duration,
        processedCount: this.processedCount,
      });
      log.logMemory('processFile:memoryAfter');

      return {
        documentId,
        filePath: relativePath,
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
        filePath: relativePath,
        durationMs: duration,
        error: err.message,
      });

      await this.storage.updateDocument(documentId, {
        status: 'failed',
        metadata: { lastError: err.message },
      });

      return {
        documentId,
        filePath: relativePath,
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
   * Accepts both absolute and relative paths for backward compatibility.
   * @param filePath - Path to the file (absolute or relative to rootPath)
   */
  private async prepareFile(
    queueItemId: string,
    queueItemAttempts: number,
    filePath: string,
    queuePriority: QueuePriority,
  ): Promise<PreparedFile> {
    const startTime = Date.now();
    const timerId = ++this.timerCounter;
    log.startTimer(`prepareFile-${timerId}`, true);

    // Normalize paths: relative for DB storage, absolute for file I/O
    const relativePath = toRelativePath(this.options.rootPath, filePath);
    const absolutePath = toAbsolutePath(this.options.rootPath, filePath);

    log.debug('prepareFile:start', { timerId, filePath: relativePath });

    // AUDITARIA: Check if file exists before processing to avoid wasteful retries
    // Files can be deleted between being queued and being processed
    const { access } = await import('node:fs/promises');
    try {
      await access(absolutePath);
    } catch {
      throw new FileNotFoundError(relativePath);
    }

    // AUDITARIA: Pre-parse garbage detection — only for text-priority files
    // Markup (.docx, .xlsx), PDFs, and images are binary by design — their parsers extract text.
    // Only plain text files (.txt, .md, .json, .csv) should be checked for binary content.
    if (this.options.enableGarbageDetection && queuePriority === 'text') {
      try {
        const { isBinaryFile } = await import('isbinaryfile');
        const isBinary = await isBinaryFile(absolutePath);
        if (isBinary) {
          throw new GarbageFileError(relativePath, 'pre-parse');
        }
      } catch (error) {
        if (error instanceof GarbageFileError) throw error;
        // isBinaryFile failed (e.g., permission error) — continue with parsing
        log.warn('prepareFile:binaryCheckFailed', {
          filePath: relativePath,
          error:
            error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Get or create document (using relative path for DB)
    let doc = await this.storage.getDocumentByPath(relativePath);
    const isNew = !doc;

    if (isNew) {
      const { stat } = await import('node:fs/promises');
      const { basename, extname } = await import('node:path');

      const fileStats = await stat(absolutePath);
      const hash = await this.calculateFileHash(absolutePath);

      doc = await this.storage.createDocument({
        filePath: relativePath, // Store relative path in DB
        fileName: basename(relativePath),
        fileExtension: extname(relativePath).toLowerCase(),
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
    void this.emit('document:parsing', { documentId, filePath: relativePath });

    // Parse the document (using absolute path for file I/O).
    // Deferred items get a hard timeout to avoid infinite reprocessing loops.
    let parsed: Awaited<ReturnType<ParserRegistry['parse']>>;
    try {
      parsed =
        queuePriority === 'deferred'
          ? await withTimeout(
              this.parserRegistry.parse(
                absolutePath,
                this.options.parserOptions,
              ),
              this.options.deferredRetryParseTimeoutMs,
              () =>
                new DeferredRetryParseTimeoutError(
                  relativePath,
                  this.options.deferredRetryParseTimeoutMs,
                ),
            )
          : await this.parserRegistry.parse(
              absolutePath,
              this.options.parserOptions,
            );
    } catch (error) {
      if (error instanceof DeferredRetryParseTimeoutError) {
        await this.storage.updateDocument(documentId, {
          status: 'failed',
          metadata: { lastError: error.message },
        });
      }
      throw error;
    }

    log.debug('prepareFile:parsed', {
      filePath: relativePath,
      textLength: parsed.text.length,
      requiresOcr: parsed.requiresOcr,
    });

    // AUDITARIA: Post-parse content quality and size gates
    const textLength = parsed.text.length;

    // Post-parse garbage detection: check if extracted text is binary/garbage
    if (this.options.enableGarbageDetection && textLength > 0) {
      try {
        const { isBinaryFile } = await import('isbinaryfile');
        const textSample = Buffer.from(parsed.text.slice(0, 8192));
        const isGarbage = await isBinaryFile(textSample);
        if (isGarbage) {
          throw new GarbageFileError(relativePath, 'post-parse');
        }
      } catch (error) {
        if (error instanceof GarbageFileError) throw error;
        // Check failed — continue (non-fatal)
      }
    }

    // Post-parse size gate: skip files with text > maxParsedTextSize
    if (textLength > this.options.maxParsedTextSize) {
      throw new FileTooLargeError(
        relativePath,
        textLength,
        this.options.maxParsedTextSize,
      );
    }

    // Post-parse size gate: defer files with text > deferParsedTextSize
    // Only defer if not already in 'deferred' priority (avoid infinite demotion loop)
    if (
      textLength > this.options.deferParsedTextSize &&
      queuePriority !== 'deferred'
    ) {
      // Reset document status back to pending before deferring
      await this.storage.updateDocument(documentId, { status: 'pending' });
      throw new FileDeferredError(relativePath, textLength);
    }

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
      filePath: relativePath,
      textLength: parsed.text.length,
    });

    // Chunk the text
    const chunks = await this.chunkerRegistry.chunk(
      parsed.text,
      this.options.chunkerOptions,
    );

    log.debug('prepareFile:chunked', {
      filePath: relativePath,
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
      filePath: relativePath,
      chunkCount: chunks.length,
    });

    // Extract only chunk texts for embedding - don't hold full Chunk objects in memory
    const chunkTexts = chunks.map((c) => c.text);
    const chunkCount = chunks.length;

    return {
      queueItemId,
      queueItemAttempts,
      documentId,
      filePath: relativePath,
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
      // Pass prepared to enable progressive clearing of chunkTexts for memory efficiency
      await this.generateEmbeddingsFromTexts(chunkIds, chunkTexts, prepared);
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
            item.priority,
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

        // Wait for any maintenance to complete before accessing storage
        await this.waitForMaintenance();

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
        // IMPORTANT: Final reconnect to persist any remaining vectors
        // Without this, the last batch (up to MAINTENANCE_INTERVAL files) would be lost
        if (this.storage.reconnect && this.processedCount > this.lastMaintenanceAt) {
          log.info('embedLoop:finalReconnect', {
            processedCount: this.processedCount,
            lastMaintenanceAt: this.lastMaintenanceAt,
            unsavedFiles: this.processedCount - this.lastMaintenanceAt,
          });
          try {
            await this.storage.reconnect();
            log.info('embedLoop:finalReconnect:complete');
          } catch (error) {
            log.error('embedLoop:finalReconnect:failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

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

    // AUDITARIA: Handle file-not-found errors specially - fail immediately without retries
    // Retrying a deleted file is wasteful since it will never succeed
    // AUDITARIA: Handle garbage/too-large — skip quietly, no user-facing error
    if (err instanceof GarbageFileError || err instanceof FileTooLargeError) {
      log.debug('prepareLoop:skipped', {
        filePath,
        reason: err.name,
        message: err.message,
      });
      await this.storage.updateQueueItem(queueItemId, {
        status: 'failed',
        attempts: newAttempts,
        lastError: err.message,
        completedAt: new Date(),
      });
      this.failedCount++;
      return;
    }

    // AUDITARIA: Handle file-not-found — fail immediately without retries
    if (err instanceof FileNotFoundError) {
      log.warn('prepareLoop:fileNotFound', {
        filePath,
        message: 'File was deleted before processing, skipping',
      });
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
      return;
    }

    // AUDITARIA: Handle deferred files — demote to 'deferred' priority, NOT a failure
    if (err instanceof FileDeferredError) {
      log.debug('prepareLoop:fileDeferred', {
        filePath,
        message: err.message,
      });
      await this.storage.updateQueueItem(queueItemId, {
        status: 'pending',
        priority: 'deferred',
        deferReason: 'parsed_text_oversize',
        attempts: 0,
        startedAt: null,
      });
      return;
    }

    // Deferred retry parse timeout is terminal: do not retry.
    if (err instanceof DeferredRetryParseTimeoutError) {
      log.warn('prepareLoop:deferredParseTimeout', {
        filePath,
        attempts: newAttempts,
        message: err.message,
      });
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
      return;
    }

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

    // Try to update storage, but don't fail if storage is unavailable
    // (can happen during maintenance/reconnect)
    try {
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
    } catch (storageError) {
      log.warn('handleEmbedError:storageUnavailable', {
        filePath: prepared.filePath,
        storageError: storageError instanceof Error ? storageError.message : String(storageError),
      });
    }

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
   * Generate embeddings from text strings using streaming for memory efficiency.
   * Progressively clears processed chunk texts to minimize memory footprint.
   *
   * @param chunkIds - Array of chunk IDs to update with embeddings
   * @param texts - Array of text strings to embed
   * @param prepared - Optional PreparedFile to enable progressive clearing of chunkTexts
   */
  private async generateEmbeddingsFromTexts(
    chunkIds: string[],
    texts: string[],
    prepared?: PreparedFile,
  ): Promise<void> {
    const batchSize = this.options.embeddingBatchSize;

    log.debug('generateEmbeddings:start', {
      totalChunks: texts.length,
      batchSize,
      streaming: !!this.embedder.embedBatchDocumentsStreaming,
      progressiveClearing: !!prepared,
    });

    // Use streaming if available (memory-efficient)
    if (this.embedder.embedBatchDocumentsStreaming) {
      for await (const {
        startIndex,
        embeddings,
      } of this.embedder.embedBatchDocumentsStreaming(texts, batchSize)) {
        // Yield to event loop between batches to prevent blocking
        if (startIndex > 0) {
          await yieldToEventLoop();
        }

        // Prepare updates for this batch
        const updates = embeddings.map((embedding, i) => ({
          id: chunkIds[startIndex + i],
          embedding,
        }));

        // Store immediately
        await this.storage.updateChunkEmbeddings(updates);

        // Progressive clearing (Option B): release processed texts to free memory
        if (prepared) {
          for (let i = startIndex; i < startIndex + embeddings.length; i++) {
            prepared.chunkTexts[i] = ''; // Release string reference
          }
        }

        log.debug('generateEmbeddings:batch', {
          batchIndex: Math.floor(startIndex / batchSize),
          batchStart: startIndex,
          batchEnd: startIndex + embeddings.length,
          totalBatches: Math.ceil(texts.length / batchSize),
        });
      }
      return;
    }

    // Fallback: non-streaming path (existing logic with progressive clearing)
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

      // Progressive clearing (Option B): release processed texts to free memory
      if (prepared) {
        for (let j = i; j < Math.min(i + batchSize, texts.length); j++) {
          prepared.chunkTexts[j] = ''; // Release string reference
        }
      }

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
