/**
 * Simple plain text parser as a fallback.
 * Handles any text-based file by reading it directly.
 */

import { readFile } from 'node:fs/promises';
import type {
  DocumentParser,
  ParsedDocument,
  ParserOptions,
  DocumentMetadata,
} from './types.js';

// ============================================================================
// PlainTextParser Implementation
// ============================================================================

/**
 * Fallback parser that reads files as plain text.
 * Lower priority than MarkitdownParser - used when specialized parsing fails.
 */
export class PlainTextParser implements DocumentParser {
  readonly name = 'plaintext';
  readonly supportedExtensions = ['*']; // Supports any extension as fallback
  readonly supportedMimeTypes = ['text/plain', 'application/octet-stream'];
  readonly priority = 1; // Low priority - fallback parser

  /**
   * This parser supports any file as a last resort.
   */
  supports(_filePath: string, _mimeType?: string): boolean {
    return true;
  }

  /**
   * Parse a file by reading it as text.
   */
  async parse(
    filePath: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    try {
      const content = await readFile(filePath, 'utf-8');

      return {
        text: this.truncateText(content, options?.maxTextLength),
        title: null,
        metadata: this.extractMetadata(content, options),
        requiresOcr: false,
      };
    } catch (error) {
      // If we can't read as UTF-8, the file might be binary
      if (error instanceof Error && error.message.includes('encoding')) {
        return {
          text: '',
          title: null,
          metadata: { error: 'Binary file - cannot read as text' },
          requiresOcr: false,
        };
      }

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
    _extension: string,
    options?: ParserOptions,
  ): Promise<ParsedDocument> {
    try {
      const content = buffer.toString('utf-8');

      return {
        text: this.truncateText(content, options?.maxTextLength),
        title: null,
        metadata: this.extractMetadata(content, options),
        requiresOcr: false,
      };
    } catch (error) {
      throw new Error(
        `Failed to parse buffer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Extract metadata from text content.
   */
  private extractMetadata(
    text: string,
    options?: ParserOptions,
  ): DocumentMetadata {
    const metadata: DocumentMetadata = {};

    if (options?.extractMetadata !== false) {
      const words = text.split(/\s+/).filter((w) => w.length > 0);
      metadata.wordCount = words.length;

      const lines = text.split('\n');
      metadata.lineCount = lines.length;
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
 * Create a new PlainTextParser instance.
 */
export function createPlainTextParser(): PlainTextParser {
  return new PlainTextParser();
}
