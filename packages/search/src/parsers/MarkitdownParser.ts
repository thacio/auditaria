/**
 * Document parser using markitdown-js.
 * Supports many formats: PDF, DOCX, PPTX, XLSX, HTML, images, audio, video, etc.
 */

import type {
  DocumentParser,
  ParsedDocument,
  ParserOptions,
  DocumentMetadata,
} from './types.js';

// ============================================================================
// Supported Extensions
// ============================================================================

/** All file extensions supported by markitdown-ts */
const SUPPORTED_EXTENSIONS = [
  // Documents
  '.pdf',
  '.docx',
  '.xlsx',
  // Plain text and structured data
  '.csv',
  '.xml',
  '.rss',
  '.atom',
  // Web - disabled due to bundling issues with xhr-sync-worker.js
  // '.html', '.htm', '.xhtml' - use PlainTextParser fallback instead
  // Jupyter
  '.ipynb',
  // Archives (markitdown can extract text from zip contents)
  '.zip',
  // Images (with EXIF metadata extraction)
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.webp',
  // Audio (metadata extraction)
  '.mp3',
  '.wav',
  '.flac',
  '.ogg',
  '.m4a',
];

/** MIME types supported by markitdown-ts */
const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/html',
  'text/csv',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'application/zip',
  'application/vnd.jupyter',
];

// ============================================================================
// MarkitdownParser Implementation
// ============================================================================

/**
 * Parser that uses markitdown-ts for document conversion.
 * This is the primary parser for most document types.
 */
export class MarkitdownParser implements DocumentParser {
  readonly name = 'markitdown';
  readonly supportedExtensions = SUPPORTED_EXTENSIONS;
  readonly supportedMimeTypes = SUPPORTED_MIME_TYPES;
  readonly priority = 100; // High priority - preferred parser

  private markitdown: import('markitdown-ts').MarkItDown | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Lazily initialize markitdown-ts.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.markitdown) return;

    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    try {
      // Dynamic import for markitdown-ts
      const { MarkItDown } = await import('markitdown-ts');
      this.markitdown = new MarkItDown();
    } catch (error) {
      throw new Error(
        `Failed to initialize markitdown-ts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Check if this parser supports the given file.
   */
  supports(filePath: string, mimeType?: string): boolean {
    const ext = this.getExtension(filePath);

    if (this.supportedExtensions.includes(ext)) {
      return true;
    }

    if (mimeType && this.supportedMimeTypes.includes(mimeType)) {
      return true;
    }

    return false;
  }

  /**
   * Parse a file from disk.
   */
  async parse(
    filePath: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    await this.ensureInitialized();

    const ext = this.getExtension(filePath);

    try {
      // Call markitdown-ts convert method (async)
      const result = await this.markitdown!.convert(filePath);

      if (!result) {
        throw new Error('Conversion returned null');
      }

      const text = result.markdown || result.text_content || '';
      const title = result.title || null;

      // Determine if OCR might be needed (images without much text)
      const requiresOcr = this.mightRequireOcr(ext, text);

      // Extract basic metadata
      const metadata = this.extractMetadata(text, options);

      return {
        text: this.truncateText(text, options?.maxTextLength),
        title,
        metadata,
        requiresOcr,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Parse content from a buffer.
   */
  async parseBuffer(
    buffer: Buffer,
    extension: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    await this.ensureInitialized();

    try {
      // markitdown-ts supports buffer input via convertBuffer
      const result = await this.markitdown!.convertBuffer(buffer, {
        file_extension: extension.startsWith('.') ? extension : `.${extension}`,
      });

      if (!result) {
        throw new Error('Conversion returned null');
      }

      const text = result.markdown || result.text_content || '';
      const title = result.title || null;

      const requiresOcr = this.mightRequireOcr(extension, text);
      const metadata = this.extractMetadata(text, options);

      return {
        text: this.truncateText(text, options?.maxTextLength),
        title,
        metadata,
        requiresOcr,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse buffer (${extension}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get file extension in lowercase with leading dot.
   */
  private getExtension(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filePath.slice(lastDot).toLowerCase();
  }

  /**
   * Determine if the document might need OCR processing.
   */
  private mightRequireOcr(extension: string, text: string): boolean {
    // Image files with little/no extracted text likely need OCR
    const imageExtensions = [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.webp',
      '.tiff',
      '.tif',
    ];

    if (imageExtensions.includes(extension)) {
      // If image has very little text, it probably needs OCR
      return text.trim().length < 50;
    }

    // PDFs with very little text might be scanned documents
    if (extension === '.pdf') {
      // Heuristic: scanned PDFs often have image-like patterns or very sparse text
      const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
      // If PDF has suspiciously little text, flag for OCR
      return wordCount < 20;
    }

    return false;
  }

  /**
   * Extract metadata from parsed text.
   */
  private extractMetadata(
    text: string,
    options?: ParserOptions,
  ): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    if (options?.extractMetadata !== false) {
      // Count words
      const words = text.split(/\s+/).filter((w) => w.length > 0);
      metadata.wordCount = words.length;
    }

    return metadata;
  }

  /**
   * Truncate text if maxTextLength is specified.
   */
  private truncateText(text: string, maxLength?: number): string {
    if (!maxLength || maxLength <= 0) return text;
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new MarkitdownParser instance.
 */
export function createMarkitdownParser(): MarkitdownParser {
  return new MarkitdownParser();
}
