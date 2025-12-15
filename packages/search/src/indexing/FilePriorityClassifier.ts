/**
 * FilePriorityClassifier - Classifies files for queue prioritization.
 *
 * Assigns priority based on file extension and size (for PDFs).
 * For large PDFs, performs a quick pre-scan to check for existing text.
 *
 * Priority order (fastest processing first):
 * 1. text   - Pure text files (.txt, .md, .json, etc.)
 * 2. markup - MarkitDown-supported files (.docx, .xlsx, etc.)
 * 3. pdf    - Small PDFs (<threshold) or large PDFs with existing text
 * 4. image  - Images (need OCR)
 * 5. ocr    - Large PDFs without text (need OCR)
 */

import { readFile } from 'node:fs/promises';
import type { QueuePriority, DiscoveredFile } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface FilePriorityClassifierConfig {
  /** Size threshold for PDF pre-scan (bytes). Default: 1MB */
  pdfSizeThreshold?: number;
  /** Characters per page threshold for PDF text detection. Default: 50 */
  pdfTextThreshold?: number;
  /** Maximum pages to scan for PDF text detection. Default: 3 */
  pdfMaxScanPages?: number;
}

const DEFAULT_PDF_SIZE_THRESHOLD = 1 * 1024 * 1024; // 1MB
const DEFAULT_PDF_TEXT_THRESHOLD = 50; // chars per page
const DEFAULT_PDF_MAX_SCAN_PAGES = 3;

// ============================================================================
// File Extension Categories
// ============================================================================

/** Pure text files - Fastest to process, highest priority */
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.csv',
  '.log',
  '.ini',
  '.conf',
  '.cfg',
  '.properties',
  '.env',
  '.gitignore',
  '.editorconfig',
]);

/** MarkitDown-supported files (excluding PDF and images) */
const MARKUP_EXTENSIONS = new Set([
  '.docx',
  '.doc',
  '.xlsx',
  '.xls',
  '.pptx',
  '.ppt',
  '.html',
  '.htm',
  '.xhtml',
  '.ipynb',
  '.rtf',
  '.odt',
  '.ods',
  '.odp',
  '.epub',
  '.msg',
  '.eml',
  '.zip', // MarkitDown can extract text from archives
]);

/** Image files - Require OCR */
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
]);

/** PDF extension */
const PDF_EXTENSION = '.pdf';

// ============================================================================
// Classified File Result
// ============================================================================

export type FileCategory =
  | 'text'
  | 'markup'
  | 'pdf'
  | 'pdf-with-text'
  | 'pdf-needs-ocr'
  | 'image'
  | 'unknown';

export interface ClassifiedFile {
  filePath: string;
  fileSize: number;
  priority: QueuePriority;
  category: FileCategory;
}

export interface ClassificationSummary {
  text: number;
  markup: number;
  pdf: number;
  image: number;
  ocr: number;
  total: number;
}

// ============================================================================
// FilePriorityClassifier Class
// ============================================================================

export class FilePriorityClassifier {
  private readonly pdfSizeThreshold: number;
  private readonly pdfTextThreshold: number;
  private readonly pdfMaxScanPages: number;

  constructor(config: FilePriorityClassifierConfig = {}) {
    this.pdfSizeThreshold =
      config.pdfSizeThreshold ?? DEFAULT_PDF_SIZE_THRESHOLD;
    this.pdfTextThreshold =
      config.pdfTextThreshold ?? DEFAULT_PDF_TEXT_THRESHOLD;
    this.pdfMaxScanPages = config.pdfMaxScanPages ?? DEFAULT_PDF_MAX_SCAN_PAGES;
  }

  /**
   * Classify a single file and determine its queue priority.
   * For PDFs larger than the threshold, performs a quick pre-scan.
   */
  async classify(file: DiscoveredFile): Promise<ClassifiedFile> {
    const ext = file.extension.toLowerCase();

    // Pure text files - highest priority
    if (TEXT_EXTENSIONS.has(ext)) {
      return {
        filePath: file.absolutePath,
        fileSize: file.size,
        priority: 'text',
        category: 'text',
      };
    }

    // MarkitDown-supported files
    if (MARKUP_EXTENSIONS.has(ext)) {
      return {
        filePath: file.absolutePath,
        fileSize: file.size,
        priority: 'markup',
        category: 'markup',
      };
    }

    // PDF files - use size heuristic + quick pre-scan for large PDFs
    if (ext === PDF_EXTENSION) {
      return this.classifyPdf(file);
    }

    // Image files - need OCR
    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        filePath: file.absolutePath,
        fileSize: file.size,
        priority: 'image',
        category: 'image',
      };
    }

    // Unknown/unsupported - treat as markup (medium priority)
    return {
      filePath: file.absolutePath,
      fileSize: file.size,
      priority: 'markup',
      category: 'unknown',
    };
  }

  /**
   * Classify a PDF file.
   * Small PDFs are assumed to be text-native.
   * Large PDFs get a quick pre-scan to check for existing text.
   */
  private async classifyPdf(file: DiscoveredFile): Promise<ClassifiedFile> {
    // Small PDFs - assume text-native
    if (file.size < this.pdfSizeThreshold) {
      return {
        filePath: file.absolutePath,
        fileSize: file.size,
        priority: 'pdf',
        category: 'pdf',
      };
    }

    // Large PDFs - quick pre-scan to check for existing text
    try {
      const hasText = await this.quickPdfTextCheck(file.absolutePath);
      return {
        filePath: file.absolutePath,
        fileSize: file.size,
        priority: hasText ? 'pdf' : 'ocr',
        category: hasText ? 'pdf-with-text' : 'pdf-needs-ocr',
      };
    } catch {
      // If pre-scan fails, assume OCR is needed (pessimistic)
      return {
        filePath: file.absolutePath,
        fileSize: file.size,
        priority: 'ocr',
        category: 'pdf-needs-ocr',
      };
    }
  }

  /**
   * Quick pre-scan to check if a PDF has meaningful text content.
   * Only reads the first few pages to minimize I/O.
   */
  private async quickPdfTextCheck(filePath: string): Promise<boolean> {
    try {
      // Dynamic import with proper ESM/CJS handling
      const pdfParseModule = (await import('pdf-parse')) as unknown as {
        default?: (
          buffer: Buffer,
          options?: { max?: number },
        ) => Promise<{ text: string; numpages: number }>;
      };
      const pdfParse = pdfParseModule.default;
      if (!pdfParse) {
        // Module doesn't have default export, can't parse
        return false;
      }
      const buffer = await readFile(filePath);
      const pdf = await pdfParse(buffer, { max: this.pdfMaxScanPages });
      const pageCount = pdf.numpages || 1;
      const charsPerPage = pdf.text.length / pageCount;
      return charsPerPage > this.pdfTextThreshold;
    } catch {
      // If parsing fails, assume no text (needs OCR)
      return false;
    }
  }

  /**
   * Classify multiple files at once.
   * Processes files in parallel for efficiency.
   */
  async classifyAll(files: DiscoveredFile[]): Promise<ClassifiedFile[]> {
    return Promise.all(files.map((file) => this.classify(file)));
  }

  /**
   * Get classification summary for a batch of files.
   */
  getSummary(classified: ClassifiedFile[]): ClassificationSummary {
    const summary: ClassificationSummary = {
      text: 0,
      markup: 0,
      pdf: 0,
      image: 0,
      ocr: 0,
      total: classified.length,
    };

    for (const file of classified) {
      summary[file.priority]++;
    }

    return summary;
  }

  /**
   * Get the PDF size threshold.
   */
  getPdfSizeThreshold(): number {
    return this.pdfSizeThreshold;
  }

  /**
   * Check if an extension is recognized.
   */
  isExtensionRecognized(ext: string): boolean {
    const normalized = ext.toLowerCase();
    return (
      TEXT_EXTENSIONS.has(normalized) ||
      MARKUP_EXTENSIONS.has(normalized) ||
      IMAGE_EXTENSIONS.has(normalized) ||
      normalized === PDF_EXTENSION
    );
  }

  /**
   * Get the priority level name for display.
   */
  static getPriorityDisplayName(priority: QueuePriority): string {
    const names: Record<QueuePriority, string> = {
      text: 'Text (fastest)',
      markup: 'Markup',
      pdf: 'PDF',
      image: 'Image (OCR)',
      ocr: 'OCR (slowest)',
    };
    return names[priority] || priority;
  }

  /**
   * Get the priority order number (1 = highest priority).
   */
  static getPriorityOrder(priority: QueuePriority): number {
    const order: Record<QueuePriority, number> = {
      text: 1,
      markup: 2,
      pdf: 3,
      image: 4,
      ocr: 5,
    };
    return order[priority] || 99;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createFilePriorityClassifier(
  config?: FilePriorityClassifierConfig,
): FilePriorityClassifier {
  return new FilePriorityClassifier(config);
}
