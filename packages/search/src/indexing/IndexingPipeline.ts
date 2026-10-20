/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  StorageAdapter,
  CreateChunkInput,
  UpdateDocumentInput,
} from '../storage/types.js';
import type { ParserRegistry } from '../parsers/ParserRegistry.js';
import type { ChunkerRegistry } from '../chunkers/ChunkerRegistry.js';
import type { DiscoveredFile, QueuePriority, QueueItem } from '../types.js';
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
import { join, isAbsolute, relative, basename, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { AsyncMutex } from '../core/AsyncMutex.js';
import { hashFile } from '../discovery/file-hash.js';
import { detectChanges } from '../sync/changes.js';
import { prepareMediaContent } from './media-content.js';
import { isMediaFile, type MediaSource } from '../embedders/media.js';

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
  mediaSources?: MediaSource[];
  chunks: CreateChunkInput[];
  chunkCount: number;
  wasIndexed: boolean;
  fileHash: string;
  fileSize: number;
  documentUpdates: UpdateDocumentInput;
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
  private stopPromise: Promise<void> | null = null;
  private autoStartRequested = false;
  private readonly processing = new AsyncMutex();
  private runPromise: Promise<void> = Promise.resolve();
  private runError: unknown;
  private wakeUp: (() => void) | undefined;
  private activeDocuments = 0;
  private runLimit = Infinity;
  private lastMaintenanceAt = 0;
  private readonly MAINTENANCE_INTERVAL = 200;

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
    for (const key of [
      'prepareWorkers',
      'preparedBufferSize',
      'embeddingBatchSize',
      'maxRetries',
    ] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) {
        throw new Error(`${key} must be a positive integer`);
      }
    }
    for (const key of [
      'retryDelay',
      'maxParsedTextSize',
      'deferParsedTextSize',
      'deferredRetryParseTimeoutMs',
    ] as const) {
      if (
        !Number.isFinite(this.options[key]) ||
        this.options[key] < (key === 'retryDelay' ? 0 : 1)
      ) {
        throw new Error(
          `${key} must be a finite ${key === 'retryDelay' ? 'non-negative' : 'positive'} number`,
        );
      }
    }
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
      activeDocuments: this.activeDocuments,
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
    const changes = detectChanges(
      discoveredFiles,
      existingHashes,
      options?.forceReindex,
    );
    if (options?.deleteRemoved === false) changes.deleted = [];

    void this.emit('sync:changes_detected', changes);

    return changes;
  }

  /**
   * Sync and queue detected changes for processing.
   * Uses smart priority classification to process lightweight files first.
   */
  async syncAndQueue(options?: SyncOptions): Promise<SyncChanges> {
    return this.processing.run(() => this.syncAndQueueExclusive(options));
  }

  private async syncAndQueueExclusive(
    options?: SyncOptions,
  ): Promise<SyncChanges> {
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
    const changes = detectChanges(
      discoveredFiles,
      existingHashes,
      options?.forceReindex,
    );
    if (options?.deleteRemoved === false) changes.deleted = [];

    void this.emit('sync:changes_detected', changes);

    // Delete removed documents and their obsolete queue entries.
    for (const filePath of changes.deleted) {
      const queued = await this.storage.getQueueItemByPath(filePath);
      if (queued) await this.storage.deleteQueueItem(queued.id);
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

    if (toQueuePaths.length > 0) this.requestAutoStart();

    return changes;
  }

  /**
   * Add a single file to the queue.
   */
  async queueFile(
    filePath: string,
    priority: QueuePriority = 'markup',
  ): Promise<void> {
    await this.processing.run(() =>
      this.storage.enqueueItem({
        filePath: toRelativePath(this.options.rootPath, filePath),
        priority,
      }),
    );

    this.requestAutoStart();
  }

  /**
   * Add multiple files to the queue.
   */
  async queueFiles(
    filePaths: string[],
    priority: QueuePriority = 'markup',
  ): Promise<void> {
    if (filePaths.length === 0) return;

    await this.processing.run(() =>
      this.storage.enqueueItems(
        filePaths.map((filePath) => ({
          filePath: toRelativePath(this.options.rootPath, filePath),
          priority,
        })),
      ),
    );

    this.requestAutoStart();
  }

  /**
   * Start processing the queue.
   * Owns one run with bounded parallel preparation and serialized publication.
   */
  start(maxDocuments?: number): void {
    if (this.stopPromise) return;
    if (this.state === 'paused') {
      this.resume();
      return;
    }
    if (this.state !== 'idle') return;
    if (
      maxDocuments !== undefined &&
      (!Number.isSafeInteger(maxDocuments) || maxDocuments <= 0)
    )
      throw new Error('maxDocuments must be a positive integer');
    this.runLimit = maxDocuments ?? Infinity;
    this.state = 'running';
    this.autoStartRequested = false;
    this.runError = undefined;
    this.processedCount = 0;
    this.failedCount = 0;
    this.lastMaintenanceAt = 0;
    this.processingStartTime = Date.now();
    // Defer execution so the completion promise exists before any event handlers run.
    this.runPromise = Promise.resolve()
      .then(() => this.run())
      .catch((error: unknown) => {
        this.runError = error;
        void this.emit('pipeline:error', {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      })
      .finally(() => {
        this.state = 'idle';
        this.activeDocuments = 0;
        void this.emit('pipeline:stopped', undefined);
        if (this.autoStartRequested && !this.stopPromise && !this.runError)
          this.start();
      });
    void this.emit('pipeline:started', undefined);
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.state = 'paused';
    void this.emit('pipeline:paused', undefined);
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
    this.wakeUp?.();
    void this.emit('pipeline:resumed', undefined);
  }

  /** Stop claiming work, finish the active operation, and release pending claims. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.autoStartRequested = false;
    this.state = 'stopping';
    this.wakeUp?.();
    this.stopPromise = this.runPromise
      .then(() => this.processing.idle())
      .finally(() => {
        this.state = 'idle';
        this.stopPromise = null;
      });
    return this.stopPromise;
  }

  private requestAutoStart(): void {
    if (!this.options.autoStart || this.stopPromise) return;
    this.autoStartRequested = true;
    if (this.state === 'idle') this.start();
  }

  /** Await completion, including persistence, and surface infrastructure failures. */
  async waitForIdle(): Promise<void> {
    let run: Promise<void>;
    do {
      run = this.runPromise;
      await run;
    } while (run !== this.runPromise);
    if (this.runError) throw this.runError;
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.state === 'paused') {
      await new Promise<void>((resolve) => {
        this.wakeUp = resolve;
      });
      this.wakeUp = undefined;
    }
  }

  /** A bounded batch has one owner for queue claims, embedding, and maintenance. */
  private async run(): Promise<void> {
    while (
      this.state !== 'stopping' &&
      this.processedCount + this.failedCount < this.runLimit
    ) {
      await this.waitWhilePaused();
      if (this.getState() === 'stopping') break;
      const hasWork = await this.processing.run(() =>
        this.processQueuedBatch(),
      );
      if (!hasWork) break;
      if (
        this.processedCount - this.lastMaintenanceAt >=
        this.MAINTENANCE_INTERVAL
      ) {
        await this.processing.run(() => this.persist());
      }
    }
    if (this.processedCount > this.lastMaintenanceAt) {
      await this.processing.run(() => this.persist());
    }
  }

  private async persist(): Promise<void> {
    // No preparation or embedding task can outlive this batch boundary.
    if (this.storage.checkpoint) await this.storage.checkpoint();
    this.lastMaintenanceAt = this.processedCount;
    await this.emit('maintenance:completed', {
      processedCount: this.processedCount,
    });
  }

  private async processQueuedBatch(): Promise<boolean> {
    const claimed = new Map<string, QueueItem>();
    const prepared: PreparedFile[] = [];
    // This bounds both parsing concurrency and retained prepared documents.
    const capacity = Math.min(
      this.options.prepareWorkers,
      this.options.preparedBufferSize,
      this.runLimit - this.processedCount - this.failedCount,
    );
    try {
      for (let i = 0; i < capacity && this.state === 'running'; i++) {
        const item = await this.storage.dequeueItem();
        if (!item) break;
        claimed.set(item.id, item);
      }
      if (claimed.size === 0) return false;
      this.activeDocuments = claimed.size;
      const preparations = await Promise.allSettled(
        [...claimed.values()].map(async (item) => {
          void this.emit('document:started', {
            documentId: '',
            filePath: item.filePath,
            queueItemId: item.id,
          });
          try {
            prepared.push(
              await this.prepareFile(
                item.id,
                item.attempts,
                item.filePath,
                item.priority,
              ),
            );
          } catch (error) {
            await this.handlePrepareError(
              item.id,
              item.filePath,
              item.attempts,
              error,
            );
            claimed.delete(item.id);
          }
        }),
      );
      const failure = preparations.find(
        (result) => result.status === 'rejected',
      );
      if (failure?.status === 'rejected') throw failure.reason;
      for (const file of prepared) {
        await this.waitWhilePaused();
        if (this.state === 'stopping') break;
        try {
          await this.embedFile(file);
          await this.storage.updateQueueItem(file.queueItemId, {
            status: 'completed',
            completedAt: new Date(),
            lastError: null,
          });
          this.processedCount++;
          await this.emit('document:completed', {
            documentId: file.documentId,
            filePath: file.filePath,
            chunksCreated: file.chunkCount,
            duration: Date.now() - file.startTime,
          });
        } catch (error) {
          await this.handlePrepareError(
            file.queueItemId,
            file.filePath,
            file.queueItemAttempts,
            error,
          );
        }
        claimed.delete(file.queueItemId);
        file.chunkTexts.length = 0;
        file.chunks.length = 0;
        file.mediaSources = undefined;
      }
      return true;
    } finally {
      await this.releaseClaims(claimed);
    }
  }

  private async releaseClaims(claimed: Map<string, QueueItem>): Promise<void> {
    // Attempt every release even if one write fails, then surface the failure.
    const releases = await Promise.allSettled(
      [...claimed.values()].map((item) =>
        this.storage.updateQueueItem(item.id, {
          status: 'pending',
          startedAt: null,
        }),
      ),
    );
    this.activeDocuments = 0;
    const errors = releases
      .filter((result) => result.status === 'rejected')
      .map((result): unknown => result.reason);
    if (errors.length)
      throw new AggregateError(
        errors,
        'Failed to release indexing queue claims',
      );
  }

  /**
   * Process a single document by file path.
   * Accepts both absolute and relative paths for backward compatibility.
   * @param filePath - Path to the file (absolute or relative to rootPath)
   */
  async processFile(filePath: string): Promise<ProcessingResult> {
    if (this.state === 'stopping')
      throw new Error('Indexing pipeline is stopping');
    return this.processing.run(async () => {
      const startTime = Date.now();
      const normalized = toRelativePath(this.options.rootPath, filePath);
      try {
        // Explicit requests use the same parser, limits, chunker, and embedder as queued work.
        const prepared = await this.prepareFile('', 1, normalized, 'deferred');
        await this.embedFile(prepared);
        const duration = Date.now() - startTime;
        await this.emit('document:completed', {
          documentId: prepared.documentId,
          filePath: normalized,
          chunksCreated: prepared.chunkCount,
          duration,
        });
        return {
          documentId: prepared.documentId,
          filePath: normalized,
          success: true,
          chunksCreated: prepared.chunkCount,
          duration,
          status: 'indexed',
          ocrStatus: prepared.parsedMetadata.requiresOcr
            ? 'pending'
            : 'not_needed',
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const doc = await this.storage.getDocumentByPath(normalized);
        if (doc)
          await this.storage.updateDocument(doc.id, {
            status: doc.indexedAt ? 'indexed' : 'failed',
            metadata: { ...doc.metadata, lastError: err.message },
          });
        return {
          documentId: doc?.id ?? '',
          filePath: normalized,
          success: false,
          chunksCreated: 0,
          duration: Date.now() - startTime,
          error: err,
          status: 'failed',
          ocrStatus: 'not_needed',
        };
      }
    });
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

    // Normalize paths: relative for DB storage, absolute for file I/O
    const relativePath = toRelativePath(this.options.rootPath, filePath);
    const absolutePath = toAbsolutePath(this.options.rootPath, filePath);

    log.debug('prepareFile:start', { filePath: relativePath });

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
    if (
      this.options.enableGarbageDetection &&
      queuePriority === 'text' &&
      !(this.embedder.prepareMedia && isMediaFile(absolutePath))
    ) {
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
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Get or create document (using relative path for DB)
    let doc = await this.storage.getDocumentByPath(relativePath);
    const isNew = !doc;

    const fileStats = await stat(absolutePath);
    const hash = await hashFile(absolutePath);

    if (isNew) {
      doc = await this.storage.createDocument({
        filePath: relativePath, // Store relative path in DB
        fileName: basename(relativePath),
        fileExtension: extname(relativePath).toLowerCase(),
        fileSize: fileStats.size,
        fileHash: '', // Set only after content has been published successfully.
        fileModifiedAt: fileStats.mtime,
        status: 'pending',
        ocrStatus: 'not_needed',
      });
    }

    const documentId = doc!.id;

    // Update status to parsing
    await this.storage.updateDocument(documentId, {
      status: doc!.indexedAt ? 'indexed' : 'parsing',
    });
    void this.emit('document:parsing', { documentId, filePath: relativePath });

    // Parse the document (using absolute path for file I/O).
    // Deferred items get a hard timeout to avoid infinite reprocessing loops.
    let parsed: Awaited<ReturnType<ParserRegistry['parse']>>;
    const media = await prepareMediaContent(this.embedder, absolutePath);
    try {
      parsed =
        media?.parsed ??
        (queuePriority === 'deferred'
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
            ));
    } catch (error) {
      if (error instanceof DeferredRetryParseTimeoutError) {
        await this.storage.updateDocument(documentId, {
          status: doc!.indexedAt ? 'indexed' : 'failed',
          metadata: { ...doc!.metadata, lastError: error.message },
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
    const textLength = Buffer.byteLength(parsed.text, 'utf8');

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
      await this.storage.updateDocument(documentId, {
        status: doc!.indexedAt ? 'indexed' : 'pending',
      });
      throw new FileDeferredError(relativePath, textLength);
    }

    await this.storage.updateDocument(documentId, {
      status: doc!.indexedAt ? 'indexed' : 'chunking',
    });

    void this.emit('document:chunking', {
      documentId,
      filePath: relativePath,
      textLength: parsed.text.length,
    });

    // Chunk the text
    const chunks =
      media?.chunks ??
      (await this.chunkerRegistry.chunk(
        parsed.text,
        this.options.chunkerOptions,
      ));

    log.debug('prepareFile:chunked', {
      filePath: relativePath,
      chunkCount: chunks.length,
    });

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

    log.debug('prepareFile:complete', {
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
      mediaSources: media?.sources,
      chunks: chunkInputs,
      chunkCount,
      wasIndexed: doc!.indexedAt !== null,
      fileHash: hash,
      fileSize: fileStats.size,
      documentUpdates: {
        title: parsed.title,
        author: parsed.metadata.author,
        language: parsed.metadata.language,
        pageCount: parsed.metadata.pageCount,
        ocrStatus: parsed.requiresOcr ? 'pending' : 'not_needed',
      },
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
    const { documentId, filePath, chunkTexts, chunks, chunkCount } = prepared;
    const vectors: number[][] = [];

    // Update status to embedding
    await this.storage.updateDocument(documentId, {
      status: prepared.wasIndexed ? 'indexed' : 'embedding',
    });
    void this.emit('document:embedding', {
      documentId,
      filePath,
      chunkCount,
    });

    // Generate embeddings in batches
    if (chunkCount > 0) {
      if (!this.embedder.isReady()) await this.embedder.initialize();
      const embTimerKey = `embeddings-${documentId}`;
      log.startTimer(embTimerKey, true);
      try {
        // Pass prepared to enable progressive clearing of chunkTexts for memory efficiency
        if (prepared.mediaSources) {
          await this.generateMediaEmbeddings(vectors, prepared.mediaSources);
          prepared.mediaSources = undefined;
        } else {
          await this.generateEmbeddingsFromTexts(vectors, chunkTexts);
        }
      } finally {
        log.endTimer(embTimerKey, 'embedFile:embeddingsGenerated', {
          filePath,
          chunkCount,
        });
      }
    }

    this.validateEmbeddings(vectors, chunkCount);
    if (
      (await hashFile(toAbsolutePath(this.options.rootPath, filePath))) !==
      prepared.fileHash
    ) {
      throw new Error(`File changed during indexing: ${filePath}`);
    }

    // Publish only after parsing and inference succeed. SQL adapters replace the
    // document's chunks in a transaction; existing passages survive a failed write.
    if (this.storage.replaceChunks) {
      await this.storage.replaceChunks(documentId, chunks, vectors);
    } else {
      await this.storage.deleteChunks(documentId);
      const stored = await this.storage.createChunks(documentId, chunks);
      await this.storage.updateChunkEmbeddings(
        stored.map((chunk, i) => ({
          id: chunk.id,
          embedding: vectors[i],
        })),
      );
    }

    // Update status to indexed
    await this.storage.updateDocument(documentId, {
      ...prepared.documentUpdates,
      status: 'indexed',
      indexedAt: new Date(),
      fileHash: prepared.fileHash,
      fileSize: prepared.fileSize,
    });

    // Emit OCR needed if required
    if (prepared.parsedMetadata.requiresOcr) {
      await this.emit('document:ocr_needed', {
        documentId,
        filePath,
        regions: prepared.parsedMetadata.ocrRegions ?? 0,
      });
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
    const newAttempts = attempts; // dequeueItem already increments the attempt count.

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

    const terminal =
      err instanceof FileNotFoundError ||
      err instanceof GarbageFileError ||
      err instanceof FileTooLargeError ||
      err instanceof DeferredRetryParseTimeoutError ||
      newAttempts >= this.options.maxRetries;
    const doc = await this.storage.getDocumentByPath(
      toRelativePath(this.options.rootPath, filePath),
    );
    if (doc)
      await this.storage.updateDocument(doc.id, {
        status: doc.indexedAt ? 'indexed' : terminal ? 'failed' : 'pending',
        metadata: { ...doc.metadata, lastError: err.message },
      });
    if (!terminal) {
      // Keep the claim while backing off so another worker cannot retry immediately.
      if (this.state !== 'stopping')
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.retryDelay * newAttempts),
        );
    }
    await this.storage.updateQueueItem(queueItemId, {
      status: terminal ? 'failed' : 'pending',
      attempts: newAttempts,
      lastError: err.message,
      startedAt: null,
      completedAt: terminal ? new Date() : null,
    });
    if (terminal) {
      this.failedCount++;
      void this.emit('document:failed', {
        documentId: doc?.id ?? '',
        filePath,
        error: err,
        attempts: newAttempts,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private Helper Methods
  // -------------------------------------------------------------------------

  /** Decode one media source at a time; retain only the vectors until publication. */
  private async generateMediaEmbeddings(
    vectors: number[][],
    sources: MediaSource[],
  ): Promise<void> {
    if (!this.embedder.embedMedia)
      throw new Error('Media embedding is not supported');
    for (const source of sources) {
      const embeddings = await this.embedder.embedMedia([source]);
      this.validateEmbeddings(embeddings, 1);
      vectors.push(...embeddings);
      await yieldToEventLoop();
    }
  }

  private async generateEmbeddingsFromTexts(
    vectors: number[][],
    texts: string[],
  ): Promise<void> {
    const batchSize = this.options.embeddingBatchSize;
    if (this.embedder.embedBatchDocumentsStreaming) {
      for await (const {
        startIndex,
        embeddings,
      } of this.embedder.embedBatchDocumentsStreaming(texts, batchSize)) {
        if (
          startIndex !== vectors.length ||
          embeddings.length === 0 ||
          startIndex + embeddings.length > texts.length
        ) {
          throw new Error('Embedder returned an invalid streaming batch');
        }
        this.validateEmbeddings(embeddings, embeddings.length);
        vectors.push(...embeddings);
        await yieldToEventLoop();
      }
      if (vectors.length !== texts.length)
        throw new Error('Embedder returned incomplete vectors');
      return;
    }
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = this.embedder.embedBatchDocuments
        ? await this.embedder.embedBatchDocuments(batch)
        : await this.embedder.embedBatch(batch);
      this.validateEmbeddings(embeddings, batch.length);
      vectors.push(...embeddings);
      await yieldToEventLoop();
    }
  }

  private validateEmbeddings(embeddings: number[][], count: number): void {
    if (
      embeddings.length !== count ||
      embeddings.some(
        (vector) =>
          vector.length !== this.embedder.dimensions ||
          !vector.every(Number.isFinite),
      )
    )
      throw new Error('Embedder returned invalid vectors');
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
