/**
 * Document parser using pdf-parse.
 * Specialized for PDF documents.
 * Higher priority than MarkitdownParser for PDF files.
 */

import { readFile } from 'node:fs/promises';
import type {
  DocumentParser,
  ParsedDocument,
  ParserOptions,
  DocumentMetadata,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

interface PdfParseResult {
  numpages: number;
  numrender: number;
  info: {
    Title?: string;
    Author?: string;
    Creator?: string;
    Producer?: string;
    CreationDate?: string;
    ModDate?: string;
    [key: string]: unknown;
  };
  metadata: unknown;
  text: string;
  version: string;
}

// ============================================================================
// Supported Extensions
// ============================================================================

/** File extensions supported by pdf-parse */
const SUPPORTED_EXTENSIONS = ['.pdf'];

/** MIME types supported by pdf-parse */
const SUPPORTED_MIME_TYPES = ['application/pdf'];

// ============================================================================
// PdfParseAdapter Implementation
// ============================================================================

/**
 * Parser that uses pdf-parse for PDF document conversion.
 * This parser has higher priority than MarkitdownParser for PDF files.
 */
export class PdfParseAdapter implements DocumentParser {
  readonly name = 'pdf-parse';
  readonly supportedExtensions = SUPPORTED_EXTENSIONS;
  readonly supportedMimeTypes = SUPPORTED_MIME_TYPES;
  readonly priority = 200; // Higher priority than MarkitdownParser (100)

  private pdfParse: ((buffer: Buffer) => Promise<PdfParseResult>) | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Lazily initialize pdf-parse.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.pdfParse) return;

    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    try {
      // pdf-parse exports the function directly
      const pdfParseModule = (await import('pdf-parse')) as unknown as {
        default?: (buffer: Buffer) => Promise<PdfParseResult>;
      };
      // Handle both default and named exports
      this.pdfParse =
        pdfParseModule.default ||
        (pdfParseModule as unknown as (
          buffer: Buffer,
        ) => Promise<PdfParseResult>);
    } catch (error) {
      throw new Error(
        `Failed to initialize pdf-parse: ${error instanceof Error ? error.message : String(error)}`,
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

    try {
      // Read file as buffer
      const buffer = await readFile(filePath);

      // Parse PDF
      const result = await this.pdfParse!(buffer);

      const text = result.text || '';

      // Extract metadata from PDF info
      const metadata = this.extractMetadata(result, text, options);

      // Get title from PDF metadata or first line
      const title = result.info?.Title || this.extractTitleFromText(text);

      // Determine if OCR might be needed (scanned PDF with little text)
      const requiresOcr = this.mightRequireOcr(text, result.numpages);

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
    fileName: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    await this.ensureInitialized();

    try {
      const result = await this.pdfParse!(buffer);

      const text = result.text || '';
      const metadata = this.extractMetadata(result, text, options);
      const title = result.info?.Title || this.extractTitleFromText(text);
      const requiresOcr = this.mightRequireOcr(text, result.numpages);

      return {
        text: this.truncateText(text, options?.maxTextLength),
        title,
        metadata,
        requiresOcr,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse buffer (${fileName}): ${error instanceof Error ? error.message : String(error)}`,
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
   * Scanned PDFs typically have very little extractable text per page.
   */
  private mightRequireOcr(text: string, pageCount: number): boolean {
    if (pageCount === 0) return false;

    // Heuristic: less than 50 characters per page suggests scanned content
    const charsPerPage = text.length / pageCount;
    return charsPerPage < 50;
  }

  /**
   * Extract title from text content.
   */
  private extractTitleFromText(text: string): string | null {
    if (!text || text.trim().length === 0) return null;

    // Split by lines and find first meaningful line
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length <= 200) {
        return trimmed;
      }
    }

    return null;
  }

  /**
   * Extract metadata from PDF result.
   */
  private extractMetadata(
    result: PdfParseResult,
    text: string,
    options?: ParserOptions,
  ): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    if (options?.extractMetadata !== false) {
      // Page count from PDF
      if (result.numpages) {
        metadata.pageCount = result.numpages;
      }

      // Author from PDF info
      if (result.info?.Author) {
        metadata.author = result.info.Author;
      }

      // Creation date
      if (result.info?.CreationDate) {
        const date = this.parsePdfDate(result.info.CreationDate);
        if (date) {
          metadata.createdAt = date;
        }
      }

      // Modified date
      if (result.info?.ModDate) {
        const date = this.parsePdfDate(result.info.ModDate);
        if (date) {
          metadata.modifiedAt = date;
        }
      }

      // Word count
      const words = text.split(/\s+/).filter((w) => w.length > 0);
      metadata.wordCount = words.length;

      // Character count
      metadata.charCount = text.length;
    }

    return metadata;
  }

  /**
   * Parse PDF date format (D:YYYYMMDDHHmmSS) to Date.
   */
  private parsePdfDate(pdfDate: string): Date | undefined {
    if (!pdfDate) return undefined;

    // PDF date format: D:YYYYMMDDHHmmSSOHH'mm'
    const match = pdfDate.match(
      /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/,
    );
    if (!match) return undefined;

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // 0-indexed
    const day = parseInt(match[3], 10);
    const hour = match[4] ? parseInt(match[4], 10) : 0;
    const minute = match[5] ? parseInt(match[5], 10) : 0;
    const second = match[6] ? parseInt(match[6], 10) : 0;

    return new Date(year, month, day, hour, minute, second);
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
 * Create a new PdfParseAdapter instance.
 */
export function createPdfParser(): PdfParseAdapter {
  return new PdfParseAdapter();
}
