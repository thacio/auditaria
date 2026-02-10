/**
 * Document parser using officeparser.
 * Specialized for Office documents (DOCX, PPTX, XLSX, ODT, ODP, ODS).
 * Higher priority than MarkitdownParser for these file types.
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

/** File extensions supported by officeparser */
const SUPPORTED_EXTENSIONS = [
  // Microsoft Office
  '.docx',
  '.pptx',
  '.xlsx',
  // OpenDocument Format
  '.odt',
  '.odp',
  '.ods',
];

/** MIME types supported by officeparser */
const SUPPORTED_MIME_TYPES = [
  // Microsoft Office
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // OpenDocument Format
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.presentation',
  'application/vnd.oasis.opendocument.spreadsheet',
];

// ============================================================================
// OfficeParserAdapter Implementation
// ============================================================================

/**
 * Parser that uses officeparser for Office document conversion.
 * This parser has higher priority than MarkitdownParser for Office files.
 */
export class OfficeParserAdapter implements DocumentParser {
  readonly name = 'officeparser';
  readonly supportedExtensions = SUPPORTED_EXTENSIONS;
  readonly supportedMimeTypes = SUPPORTED_MIME_TYPES;
  readonly priority = 200; // Higher priority than MarkitdownParser (100)

  private parseOfficeAsync:
    | ((filePath: string | Buffer) => Promise<string>)
    | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Lazily initialize officeparser.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.parseOfficeAsync) return;

    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    try {
      const officeparser = await import('officeparser');
      this.parseOfficeAsync = officeparser.parseOfficeAsync;
    } catch (error) {
      throw new Error(
        `Failed to initialize officeparser: ${error instanceof Error ? error.message : String(error)}`,
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
      // Read file as buffer to avoid officeparser's case-sensitive extension check
      // (e.g., .DOCX is rejected while .docx works)
      const { readFile } = await import('fs/promises');
      const buffer = await readFile(filePath);
      const text = await this.parseOfficeAsync!(buffer);

      // Extract metadata from text
      const metadata = this.extractMetadata(text, options);

      // Try to extract title from content (first line or heading)
      const title = this.extractTitle(text);

      return {
        text: this.truncateText(text, options?.maxTextLength),
        title,
        metadata,
        requiresOcr: false, // Office documents don't need OCR
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
      // officeparser.parseOfficeAsync can handle buffer input
      const text = await this.parseOfficeAsync!(buffer);

      const metadata = this.extractMetadata(text, options);
      const title = this.extractTitle(text);

      return {
        text: this.truncateText(text, options?.maxTextLength),
        title,
        metadata,
        requiresOcr: false,
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
   * Extract title from content.
   * Looks for the first non-empty line or heading.
   */
  private extractTitle(text: string): string | null {
    if (!text || text.trim().length === 0) return null;

    // Split by lines and find first meaningful line
    const lines = text.split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && trimmed.length <= 200) {
        // Don't use very long lines as title
        return trimmed;
      }
    }

    return null;
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

      // Count characters
      metadata.charCount = text.length;
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
 * Create a new OfficeParserAdapter instance.
 */
export function createOfficeParser(): OfficeParserAdapter {
  return new OfficeParserAdapter();
}
