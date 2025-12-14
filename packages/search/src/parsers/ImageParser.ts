/**
 * ImageParser - Parser for image files.
 * Images don't have text content, so this parser returns minimal metadata
 * and marks them as requiring OCR.
 */

import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { DocumentParser, ParsedDocument, ParserOptions } from './types.js';

// ============================================================================
// Supported Extensions and MIME Types
// ============================================================================

const SUPPORTED_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
];

const SUPPORTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/tiff',
];

// ============================================================================
// ImageParser Class
// ============================================================================

/**
 * Parser for image files.
 * Returns minimal metadata and marks images as requiring OCR.
 * Priority 250 ensures images are handled by this parser, not markitdown.
 */
export class ImageParser implements DocumentParser {
  readonly name = 'image-parser';
  readonly supportedExtensions: string[] = SUPPORTED_EXTENSIONS;
  readonly supportedMimeTypes: string[] = SUPPORTED_MIME_TYPES;
  readonly priority = 250; // Higher than markitdown (100) to take precedence

  /**
   * Check if this parser can handle the file.
   */
  supports(filePath: string, mimeType?: string): boolean {
    const ext = extname(filePath).toLowerCase();

    if (SUPPORTED_EXTENSIONS.includes(ext)) {
      return true;
    }

    if (mimeType && SUPPORTED_MIME_TYPES.includes(mimeType.toLowerCase())) {
      return true;
    }

    return false;
  }

  /**
   * Parse an image file.
   * Since images don't have text content, we return minimal metadata
   * and mark the document as requiring OCR.
   */
  async parse(
    filePath: string,
    _options?: ParserOptions,
  ): Promise<ParsedDocument> {
    const fileName = basename(filePath);
    const extension = extname(filePath).toLowerCase();

    // Get file stats for metadata
    let fileSize = 0;
    try {
      const stats = await stat(filePath);
      fileSize = stats.size;
    } catch {
      // Ignore stat errors
    }

    // Determine MIME type from extension
    const mimeType = this.getMimeType(extension);

    return {
      text: '', // Images don't have text content
      title: fileName,
      metadata: {
        fileName,
        fileType: extension,
        mimeType,
        fileSize,
      },
      // Mark as requiring OCR - the OCR system will process this
      requiresOcr: true,
    };
  }

  /**
   * Parse from a buffer.
   */
  async parseBuffer(
    buffer: Buffer,
    fileName: string,
    _options?: ParserOptions,
  ): Promise<ParsedDocument> {
    const extension = extname(fileName).toLowerCase();
    const mimeType = this.getMimeType(extension);

    return {
      text: '', // Images don't have text content
      title: fileName,
      metadata: {
        fileName,
        fileType: extension,
        mimeType,
        fileSize: buffer.length,
      },
      requiresOcr: true,
    };
  }

  /**
   * Get MIME type from file extension.
   */
  private getMimeType(extension: string): string {
    const mimeMap: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.tiff': 'image/tiff',
      '.tif': 'image/tiff',
      '.webp': 'image/webp',
    };
    return mimeMap[extension] || 'application/octet-stream';
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new ImageParser instance.
 */
export function createImageParser(): ImageParser {
  return new ImageParser();
}
