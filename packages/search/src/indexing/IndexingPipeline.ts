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
import type {
  FilePriorityClassifier} from './FilePriorityClassifier.js';
import {
  createFilePriorityClassifier,
} from './FilePriorityClassifier.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1000;

// ============================================================================
// Utility: Event Loop Yielding
// ============================================================================

/** Yield to the event loop to prevent blocking */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

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
  private activeCount = 0;
  private processedCount = 0;
  private failedCount = 0;
  private processingStartTime: number | null = null;
  private abortController: AbortController | null = null;

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
      concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
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
      activeDocuments: this.activeCount,
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
   */
  start(): void {
    if (this.state === 'running') return;

    this.state = 'running';
    this.abortController = new AbortController();
    this.processingStartTime = Date.now();
    void this.emit('pipeline:started', undefined);

    // Start worker(s)
    for (let i = 0; i < this.options.concurrency; i++) {
      void this.processLoop();
    }
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
    for (let i = 0; i < this.options.concurrency; i++) {
      void this.processLoop();
    }
  }

  /**
   * Stop processing (waits for current items to complete).
   */
  async stop(): Promise<void> {
    if (this.state === 'idle' || this.state === 'stopping') return;

    this.state = 'stopping';
    this.abortController?.abort();

    // Wait for active processing to complete
    while (this.activeCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.state = 'idle';
    this.abortController = null;
    void this.emit('pipeline:stopped', undefined);
  }

  /**
   * Process a single document by file path.
   */
  async processFile(filePath: string): Promise<ProcessingResult> {
    const startTime = Date.now();

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

      // Update status to embedding
      await this.storage.updateDocument(documentId, { status: 'embedding' });
      void this.emit('document:embedding', {
        documentId,
        filePath,
        chunkCount: chunks.length,
      });

      // Generate embeddings in batches
      if (this.embedder.isReady()) {
        await this.generateEmbeddings(
          createdChunks.map((c) => c.id),
          chunks,
        );
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
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Main processing loop (runs in background).
   */
  private async processLoop(): Promise<void> {
    while (this.state === 'running') {
      // Check if we should stop
      if (this.abortController?.signal.aborted) {
        break;
      }

      // Get next item from queue
      const item = await this.storage.dequeueItem();

      if (!item) {
        // Queue is empty, check again after a delay
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check if still empty and no active processing
        const status = await this.storage.getQueueStatus();
        if (status.pending === 0 && this.activeCount === 0) {
          this.state = 'idle';
          void this.emit('pipeline:stopped', undefined);
          break;
        }
        continue;
      }

      this.activeCount++;

      try {
        // Update queue item status
        await this.storage.updateQueueItem(item.id, {
          status: 'processing',
          startedAt: new Date(),
        });

        void this.emit('document:started', {
          documentId: '', // Will be assigned during processing
          filePath: item.filePath,
          queueItemId: item.id,
        });

        // Process the file
        const result = await this.processFile(item.filePath);

        if (result.success) {
          await this.storage.updateQueueItem(item.id, {
            status: 'completed',
            completedAt: new Date(),
          });
          this.processedCount++;
        } else {
          const attempts = item.attempts + 1;

          if (attempts < this.options.maxRetries) {
            // Retry later
            await this.storage.updateQueueItem(item.id, {
              status: 'pending',
              attempts,
              lastError: result.error?.message ?? 'Unknown error',
            });

            // Wait before retry
            await new Promise((resolve) =>
              setTimeout(resolve, this.options.retryDelay * attempts),
            );
          } else {
            // Max retries reached
            await this.storage.updateQueueItem(item.id, {
              status: 'failed',
              attempts,
              lastError: result.error?.message ?? 'Unknown error',
              completedAt: new Date(),
            });
            this.failedCount++;

            void this.emit('document:failed', {
              documentId: result.documentId,
              filePath: item.filePath,
              error: result.error ?? new Error('Unknown error'),
              attempts,
            });
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));

        // Unexpected error
        await this.storage.updateQueueItem(item.id, {
          status: 'failed',
          lastError: err.message,
          completedAt: new Date(),
        });
        this.failedCount++;

        void this.emit('document:failed', {
          documentId: '',
          filePath: item.filePath,
          error: err,
          attempts: item.attempts + 1,
        });
      } finally {
        this.activeCount--;
      }
    }
  }

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
    const batchSize = this.options.embeddingBatchSize;

    for (let i = 0; i < chunks.length; i += batchSize) {
      // Yield to event loop between batches to prevent blocking
      if (i > 0) {
        await yieldToEventLoop();
      }

      const batchChunks = chunks.slice(i, i + batchSize);
      const batchIds = chunkIds.slice(i, i + batchSize);
      const texts = batchChunks.map((c) => c.text);

      // Use embedBatchDocuments if available (handles E5 prefix),
      // otherwise fall back to embedBatch
      const embeddings = this.embedder.embedBatchDocuments
        ? await this.embedder.embedBatchDocuments(texts)
        : await this.embedder.embedBatch(texts);

      const updates = batchIds.map((id, index) => ({
        id,
        embedding: embeddings[index],
      }));

      await this.storage.updateChunkEmbeddings(updates);
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
