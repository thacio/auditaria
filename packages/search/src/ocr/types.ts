/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OcrRegion } from '../parsers/types.js';

// ============================================================================
// OCR Result Types
// ============================================================================

/**
 * Result from OCR processing of a single region/image.
 */
export interface OcrResult {
  /** Extracted text content */
  text: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detected language (ISO 639-1 code) */
  language?: string;
  /** Individual text regions with positions */
  regions: OcrTextRegion[];
}

/**
 * A single text region detected by OCR.
 */
export interface OcrTextRegion {
  /** The recognized text */
  text: string;
  /** Bounding box of the region */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** Confidence score for this region (0-1) */
  confidence: number;
  /** Word-level breakdown (if available) */
  words?: OcrWord[];
}

/**
 * A single word detected by OCR.
 */
export interface OcrWord {
  /** The word text */
  text: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Bounding box */
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

// ============================================================================
// OCR Provider Interface
// ============================================================================

/**
 * Options for OCR recognition.
 */
export interface OcrOptions {
  /** Languages to detect (ISO 639-1 codes) */
  languages?: string[];
  /** Page segmentation mode */
  pageSegmentationMode?: number;
  /** Whether to preserve whitespace */
  preserveWhitespace?: boolean;
  /** Custom configuration options (provider-specific) */
  [key: string]: unknown;
}

/**
 * Interface for OCR providers.
 * Implementations can use different OCR engines (Tesseract.js, cloud APIs, etc.)
 */
export interface OcrProvider {
  /** Unique name for this provider */
  readonly name: string;
  /** Supported languages (ISO 639-1 codes) */
  readonly supportedLanguages: string[];
  /** Priority for provider selection (higher = preferred) */
  readonly priority: number;
  /** Whether the provider is ready */
  isReady(): boolean;

  /**
   * Initialize the OCR provider (load models, etc.)
   * @param progressCallback - Optional callback for progress reporting
   */
  initialize(progressCallback?: OcrProgressCallback): Promise<void>;

  /**
   * Recognize text from an image buffer.
   * @param image - Image data (Buffer or base64 string)
   * @param options - OCR options
   */
  recognize(image: Buffer | string, options?: OcrOptions): Promise<OcrResult>;

  /**
   * Recognize text from multiple regions.
   * @param regions - Array of regions with image data
   * @param options - OCR options
   */
  recognizeRegions(
    regions: OcrRegion[],
    options?: OcrOptions,
  ): Promise<OcrResult[]>;

  /**
   * Recognize text from a file path.
   * @param filePath - Path to the image file
   * @param options - OCR options
   */
  recognizeFile(filePath: string, options?: OcrOptions): Promise<OcrResult>;

  /**
   * Release resources.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// OCR Registry Types
// ============================================================================

/**
 * Options for creating an OCR registry.
 */
export interface OcrRegistryOptions {
  /** Default OCR options */
  defaultOptions?: OcrOptions;
}

// ============================================================================
// OCR Queue Types
// ============================================================================

/**
 * Status of an OCR job.
 */
export type OcrJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * An OCR job in the queue.
 */
export interface OcrJob {
  /** Job ID */
  id: string;
  /** Document ID */
  documentId: string;
  /** File path of the document */
  filePath: string;
  /** OCR regions to process */
  regions: OcrRegion[];
  /** Current status */
  status: OcrJobStatus;
  /** Number of processing attempts */
  attempts: number;
  /** Last error message */
  lastError?: string;
  /** When the job was created */
  createdAt: Date;
  /** When processing started */
  startedAt?: Date;
  /** When processing completed */
  completedAt?: Date;
}

/**
 * Configuration for the OCR queue manager.
 */
export interface OcrQueueConfig {
  /** Whether OCR processing is enabled */
  enabled: boolean;
  /** Maximum concurrent OCR jobs */
  concurrency: number;
  /** Maximum retry attempts for failed jobs */
  maxRetries: number;
  /** Delay between retries (ms) */
  retryDelay: number;
  /** Process OCR only after main indexing queue is empty */
  processAfterMainQueue: boolean;
  /**
   * Automatically detect script/language before OCR.
   * When enabled, uses Tesseract OSD to detect the writing system.
   * Downloads required language data automatically on first use.
   */
  autoDetectLanguage: boolean;
  /** Default languages to use (fallback when auto-detect is disabled) */
  defaultLanguages: string[];
  /** Root path for resolving relative file paths to absolute paths for I/O */
  rootPath?: string;
}

// ============================================================================
// OCR Events
// ============================================================================

/**
 * Progress callback for OCR operations.
 */
export type OcrProgressCallback = (progress: OcrProgressInfo) => void;

/**
 * Progress information for OCR operations.
 */
export interface OcrProgressInfo {
  /** Current stage */
  stage: 'loading' | 'recognizing' | 'processing';
  /** Progress percentage (0-100) */
  progress: number;
  /** Status message */
  message?: string;
  /** File being processed */
  file?: string;
}

/**
 * Events emitted by the OCR system.
 */
export interface OcrEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;
  /** OCR job started */
  'ocr:started': { documentId: string; filePath: string; regions: number };
  /** OCR job progress */
  'ocr:progress': {
    documentId: string;
    filePath: string;
    completed: number;
    total: number;
  };
  /** OCR job completed */
  'ocr:completed': {
    documentId: string;
    filePath: string;
    text: string;
    confidence: number;
  };
  /** OCR job failed */
  'ocr:failed': { documentId: string; filePath: string; error: Error };
}

// ============================================================================
// OCR Result Merging
// ============================================================================

/**
 * Options for merging OCR text with document text.
 */
export interface OcrMergeOptions {
  /** Where to insert OCR text */
  insertPosition: 'append' | 'prepend' | 'byPage';
  /** Separator between original and OCR text */
  separator?: string;
  /** Minimum confidence threshold to include text */
  minConfidence?: number;
}

/**
 * Result of merging OCR text with document text.
 */
export interface OcrMergeResult {
  /** Combined text */
  text: string;
  /** Whether OCR text was added */
  hasOcrContent: boolean;
  /** Number of OCR regions merged */
  regionsProcessed: number;
  /** Average confidence of OCR results */
  averageConfidence: number;
}
