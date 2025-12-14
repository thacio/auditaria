/**
 * OcrQueueManager - Manages OCR processing queue.
 * Handles low-priority background OCR processing for documents that need it.
 *
 * Supports both images (via TesseractJsProvider) and PDFs (via ScribeJsProvider).
 * The OcrRegistry automatically selects the best provider based on file type.
 */

import { extname } from 'node:path';
import { EventEmitter } from '../core/EventEmitter.js';
import type { StorageAdapter } from '../storage/types.js';
import type { OcrRegion } from '../parsers/types.js';
import type { Embedder } from '../indexing/types.js';
import type {
  OcrQueueConfig,
  OcrJob,
  OcrResult,
  OcrEvents,
  OcrMergeOptions,
  OcrMergeResult,
} from './types.js';
import type { OcrRegistry } from './OcrRegistry.js';
import { isOcrSupported } from './ocr-utils.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Default OCR queue configuration.
 */
const DEFAULT_CONFIG: OcrQueueConfig = {
  enabled: true,
  concurrency: 2, // Process 2 OCR jobs in parallel (OCR is CPU/memory intensive)
  maxRetries: 3,
  retryDelay: 5000,
  processAfterMainQueue: true,
  autoDetectLanguage: true,
  defaultLanguages: ['en'],
};

/**
 * State of the OCR queue manager.
 */
export type OcrQueueState = 'idle' | 'running' | 'paused' | 'stopping';

/**
 * Status of the OCR queue.
 */
export interface OcrQueueStatus {
  state: OcrQueueState;
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
}

// ============================================================================
// Constants
// ============================================================================

// Note: File type checking is now done via isOcrSupported from ocr-utils.js
// which supports both images (TesseractJsProvider) and PDFs (ScribeJsProvider)

// ============================================================================
// ID Generation
// ============================================================================

function generateId(): string {
  return `ocr_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// ============================================================================
// OcrQueueManager Implementation
// ============================================================================

/**
 * Manages OCR processing queue with low priority.
 * OCR items are processed after the main indexing queue is empty.
 */
export class OcrQueueManager extends EventEmitter<OcrEvents> {
  private config: OcrQueueConfig;
  private storage: StorageAdapter;
  private ocrRegistry: OcrRegistry;
  private embedder: Embedder | null;
  private jobs: Map<string, OcrJob> = new Map();
  private state: OcrQueueState = 'idle';
  private processing: Set<string> = new Set();
  private processInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    storage: StorageAdapter,
    ocrRegistry: OcrRegistry,
    config: Partial<OcrQueueConfig> = {},
    embedder?: Embedder,
  ) {
    super();
    this.storage = storage;
    this.ocrRegistry = ocrRegistry;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.embedder = embedder ?? null;
  }

  /**
   * Set the embedder (for lazy initialization).
   */
  setEmbedder(embedder: Embedder): void {
    this.embedder = embedder;
  }

  // -------------------------------------------------------------------------
  // State & Status
  // -------------------------------------------------------------------------

  /**
   * Get current state.
   */
  getState(): OcrQueueState {
    return this.state;
  }

  /**
   * Get queue status.
   */
  getStatus(): OcrQueueStatus {
    const jobs = Array.from(this.jobs.values());
    return {
      state: this.state,
      totalJobs: jobs.length,
      pendingJobs: jobs.filter((j) => j.status === 'pending').length,
      processingJobs: jobs.filter((j) => j.status === 'processing').length,
      completedJobs: jobs.filter((j) => j.status === 'completed').length,
      failedJobs: jobs.filter((j) => j.status === 'failed').length,
    };
  }

  /**
   * Check if OCR is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled && this.ocrRegistry.hasProviders();
  }

  // -------------------------------------------------------------------------
  // Queue Operations
  // -------------------------------------------------------------------------

  /**
   * Enqueue a document for OCR processing.
   */
  async enqueue(
    documentId: string,
    filePath: string,
    regions: OcrRegion[],
  ): Promise<OcrJob> {
    if (!this.config.enabled) {
      throw new Error('OCR processing is disabled');
    }

    // Check if job already exists for this document
    const existingJob = this.findJobByDocument(documentId);
    if (existingJob) {
      // Update regions if pending
      if (existingJob.status === 'pending') {
        existingJob.regions = regions;
        return existingJob;
      }
      // If completed or failed, create new job
    }

    const job: OcrJob = {
      id: generateId(),
      documentId,
      filePath,
      regions,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    };

    this.jobs.set(job.id, job);

    // Update document OCR status
    await this.storage.updateDocument(documentId, { ocrStatus: 'pending' });

    return job;
  }

  /**
   * Find job by document ID.
   */
  findJobByDocument(documentId: string): OcrJob | undefined {
    return Array.from(this.jobs.values()).find(
      (j) => j.documentId === documentId,
    );
  }

  /**
   * Get all pending jobs.
   */
  getPendingJobs(): OcrJob[] {
    return Array.from(this.jobs.values())
      .filter((j) => j.status === 'pending')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /**
   * Cancel a job.
   */
  cancelJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'processing') {
      return false;
    }

    this.jobs.delete(jobId);
    return true;
  }

  /**
   * Clear completed jobs.
   */
  clearCompleted(): number {
    let cleared = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === 'completed') {
        this.jobs.delete(id);
        cleared++;
      }
    }
    return cleared;
  }

  /**
   * Clear all jobs.
   */
  clearAll(): void {
    this.jobs.clear();
  }

  // -------------------------------------------------------------------------
  // Processing Control
  // -------------------------------------------------------------------------

  /**
   * Start processing OCR jobs.
   */
  start(): void {
    if (this.state === 'running') {
      return;
    }

    this.state = 'running';

    // Start processing loop
    this.processInterval = setInterval(() => {
      this.processNext().catch((error) => {
        console.error('[OcrQueueManager] Processing error:', error);
      });
    }, 1000);
  }

  /**
   * Pause processing.
   */
  pause(): void {
    if (this.state !== 'running') {
      return;
    }

    this.state = 'paused';
    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }
  }

  /**
   * Resume processing.
   */
  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    this.start();
  }

  /**
   * Stop processing and wait for current jobs to complete.
   */
  async stop(): Promise<void> {
    if (this.state === 'idle') {
      return;
    }

    this.state = 'stopping';

    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    // Wait for processing jobs to complete
    while (this.processing.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.state = 'idle';
  }

  // -------------------------------------------------------------------------
  // Processing Logic
  // -------------------------------------------------------------------------

  /**
   * Process pending jobs up to concurrency limit (parallel processing).
   */
  private async processNext(): Promise<void> {
    if (this.state !== 'running') {
      return;
    }

    // Check if we should wait for main queue
    if (this.config.processAfterMainQueue) {
      const queueStatus = await this.storage.getQueueStatus();
      if (queueStatus.pending > 0 || queueStatus.processing > 0) {
        return; // Main queue still processing
      }
    }

    // Get pending jobs
    const pendingJobs = this.getPendingJobs();
    if (pendingJobs.length === 0) {
      return;
    }

    // Calculate how many jobs we can start (up to concurrency limit)
    const availableSlots = this.config.concurrency - this.processing.size;
    if (availableSlots <= 0) {
      return;
    }

    // Start multiple jobs in parallel (up to available slots)
    const jobsToStart = pendingJobs.slice(0, availableSlots);
    const promises = jobsToStart.map((job) => this.processJob(job));

    // Don't await - let them run in background
    // Errors are handled inside processJob
    Promise.all(promises).catch(() => {
      // Errors already handled in processJob
    });
  }

  /**
   * Process a single OCR job.
   */
  private async processJob(job: OcrJob): Promise<void> {
    if (this.processing.has(job.id)) {
      return;
    }

    this.processing.add(job.id);
    job.status = 'processing';
    job.startedAt = new Date();
    job.attempts++;

    // Update document status
    await this.storage.updateDocument(job.documentId, {
      ocrStatus: 'processing',
    });

    void this.emit('ocr:started', {
      documentId: job.documentId,
      filePath: job.filePath,
      regions: job.regions.length,
    });

    try {
      let ocrResults: OcrResult[];

      if (job.regions.length > 0 && job.regions.some((r) => r.imageData)) {
        // Process specific regions (from embedded images in documents)
        // Note: Auto-detect not supported for regions yet, use default languages
        ocrResults = await this.ocrRegistry.recognizeRegions(job.regions, {
          languages: this.config.defaultLanguages,
        });
      } else if (isOcrSupported(job.filePath)) {
        // Process image or PDF file
        // OcrRegistry automatically selects the best provider:
        // - TesseractJsProvider for images (faster)
        // - ScribeJsProvider for PDFs (native PDF support)
        if (this.config.autoDetectLanguage) {
          const result = await this.ocrRegistry.recognizeFileWithAutoDetect(
            job.filePath,
          );
          ocrResults = [result];
        } else {
          const result = await this.ocrRegistry.recognizeFile(job.filePath, {
            languages: this.config.defaultLanguages,
          });
          ocrResults = [result];
        }
      } else {
        // File type not supported for OCR
        const ext = extname(job.filePath).toLowerCase();
        console.warn(
          `[OcrQueueManager] Skipping ${job.filePath}: File type '${ext}' not supported for OCR.`,
        );
        job.status = 'completed';
        job.completedAt = new Date();
        await this.storage.updateDocument(job.documentId, {
          ocrStatus: 'skipped',
        });
        void this.emit('ocr:completed', {
          documentId: job.documentId,
          filePath: job.filePath,
          text: '',
          confidence: 0,
        });
        this.processing.delete(job.id);
        return;
      }

      // Merge OCR text with document
      const mergedText = this.mergeOcrResults(ocrResults);

      // Update document with OCR text
      const doc = await this.storage.getDocument(job.documentId);
      if (doc && mergedText.text) {
        // Get existing chunks
        const chunks = await this.storage.getChunks(job.documentId);

        // Calculate offset for new chunk
        const lastChunk = chunks.length > 0 ? chunks[chunks.length - 1] : null;
        const startOffset = lastChunk ? lastChunk.endOffset : 0;
        const ocrChunkText = `[OCR Extracted Text]\n${mergedText.text}`;

        // Create a new chunk for OCR content
        const createdChunks = await this.storage.createChunks(job.documentId, [
          {
            chunkIndex: chunks.length,
            text: ocrChunkText,
            startOffset,
            endOffset: startOffset + ocrChunkText.length,
            section: 'OCR Content',
          },
        ]);

        // Generate embedding for the OCR chunk if embedder is available
        if (this.embedder && createdChunks.length > 0) {
          try {
            const embedding = await this.embedder.embed(ocrChunkText);
            await this.storage.updateChunkEmbeddings([
              {
                id: createdChunks[0].id,
                embedding,
              },
            ]);
          } catch (embedError) {
            console.warn(
              `[OcrQueueManager] Failed to generate embedding for OCR chunk: ${
                embedError instanceof Error
                  ? embedError.message
                  : String(embedError)
              }`,
            );
          }
        }

        // Update document status
        await this.storage.updateDocument(job.documentId, {
          ocrStatus: 'completed',
        });
      } else if (doc) {
        // No OCR text extracted, mark as completed anyway
        await this.storage.updateDocument(job.documentId, {
          ocrStatus: 'completed',
        });
      }

      // Mark job complete
      job.status = 'completed';
      job.completedAt = new Date();

      void this.emit('ocr:completed', {
        documentId: job.documentId,
        filePath: job.filePath,
        text: mergedText.text,
        confidence: mergedText.averageConfidence,
      });
    } catch (error) {
      job.lastError = error instanceof Error ? error.message : String(error);

      // Log the error for debugging
      console.error(
        `[OcrQueueManager] Error processing OCR job for ${job.filePath}:`,
        job.lastError,
      );

      if (job.attempts < this.config.maxRetries) {
        // Schedule retry
        console.log(
          `[OcrQueueManager] Will retry (attempt ${job.attempts}/${this.config.maxRetries})`,
        );
        job.status = 'pending';
        job.startedAt = undefined;

        // Delay before retry
        await new Promise((resolve) =>
          setTimeout(resolve, this.config.retryDelay),
        );
      } else {
        // Mark as failed
        job.status = 'failed';

        await this.storage.updateDocument(job.documentId, {
          ocrStatus: 'failed',
        });

        void this.emit('ocr:failed', {
          documentId: job.documentId,
          filePath: job.filePath,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    } finally {
      this.processing.delete(job.id);
    }
  }

  /**
   * Process all pending OCR jobs with parallel processing.
   * Respects the concurrency limit for efficient resource usage.
   */
  async processAll(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    if (!this.isEnabled()) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const startState = this.state;
    this.state = 'running';

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const pendingJobs = this.getPendingJobs();

      // Process jobs in batches respecting concurrency limit
      for (let i = 0; i < pendingJobs.length; i += this.config.concurrency) {
        if (this.state !== 'running') {
          break;
        }

        // Get batch of jobs up to concurrency limit
        const batch = pendingJobs.slice(i, i + this.config.concurrency);

        // Process batch in parallel
        await Promise.all(batch.map((job) => this.processJob(job)));

        // Count results
        for (const job of batch) {
          processed++;
          if (job.status === 'completed') {
            succeeded++;
          } else if (job.status === 'failed') {
            failed++;
          }
        }
      }
    } finally {
      this.state = startState === 'running' ? 'running' : 'idle';
    }

    return { processed, succeeded, failed };
  }

  // -------------------------------------------------------------------------
  // Result Merging
  // -------------------------------------------------------------------------

  /**
   * Merge multiple OCR results into a single result.
   */
  private mergeOcrResults(
    results: OcrResult[],
    options?: OcrMergeOptions,
  ): OcrMergeResult {
    const minConfidence = options?.minConfidence ?? 0.5;
    const separator = options?.separator ?? '\n\n';

    const validResults = results.filter(
      (r) => r.text && r.confidence >= minConfidence,
    );

    if (validResults.length === 0) {
      return {
        text: '',
        hasOcrContent: false,
        regionsProcessed: 0,
        averageConfidence: 0,
      };
    }

    const text = validResults.map((r) => r.text.trim()).join(separator);
    const totalConfidence = validResults.reduce(
      (sum, r) => sum + r.confidence,
      0,
    );

    return {
      text,
      hasOcrContent: true,
      regionsProcessed: validResults.length,
      averageConfidence: totalConfidence / validResults.length,
    };
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new OcrQueueManager.
 */
export function createOcrQueueManager(
  storage: StorageAdapter,
  ocrRegistry: OcrRegistry,
  config?: Partial<OcrQueueConfig>,
  embedder?: Embedder,
): OcrQueueManager {
  return new OcrQueueManager(storage, ocrRegistry, config, embedder);
}
