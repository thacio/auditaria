/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare module 'officeparser' {
  /**
   * Configuration options for officeparser.
   */
  export interface OfficeParserConfig {
    newlineDelimiter?: string;
    ignoreNotes?: boolean;
    putNotesAtLast?: boolean;
    outputErrorToConsole?: boolean;
  }

  /**
   * Parse an Office document file and extract text content (async version).
   * @param filePath - Path to the file or buffer
   * @param config - Optional configuration
   * @returns Promise resolving to extracted text
   */
  export function parseOfficeAsync(
    filePath: string | Buffer | ArrayBuffer,
    config?: OfficeParserConfig,
  ): Promise<string>;

  /**
   * Parse an Office document file and extract text content (callback version).
   * @param filePath - Path to the file or buffer
   * @param config - Configuration options or callback
   * @param callback - Callback function (text, error)
   */
  export function parseOffice(
    filePath: string | Buffer | ArrayBuffer,
    configOrCallback?:
      | OfficeParserConfig
      | ((text: string, error: Error | undefined) => void),
    callback?: (text: string, error: Error | undefined) => void,
  ): void;
}

declare module 'markitdown-ts' {
  /**
   * Result from converting a document.
   */
  export interface ConvertResult {
    markdown: string;
    text_content?: string;
    title?: string;
  }

  /**
   * Options for converting a buffer.
   */
  export interface ConvertBufferOptions {
    file_extension: string;
  }

  /**
   * MarkItDown converter class.
   */
  export class MarkItDown {
    /**
     * Convert a file to markdown.
     * @param filePath - Path to the file or URL
     * @returns Promise resolving to ConvertResult
     */
    convert(filePath: string): Promise<ConvertResult | null>;

    /**
     * Convert a buffer to markdown.
     * @param buffer - Buffer containing file data
     * @param options - Options including file_extension
     * @returns Promise resolving to ConvertResult
     */
    convertBuffer(
      buffer: Buffer,
      options: ConvertBufferOptions,
    ): Promise<ConvertResult | null>;
  }
}

declare module 'xxhash-wasm' {
  interface Hasher {
    update(data: Buffer | string): this;
    digest(encoding?: 'hex'): string;
  }

  /**
   * Create a 64-bit xxhash hasher.
   */
  export function xxhash64(): Promise<Hasher>;
}

declare module 'vectorlite' {
  /**
   * Returns the path to the vectorlite SQLite extension.
   * Use this with better-sqlite3's loadExtension() method.
   *
   * @returns The file path to the vectorlite extension
   */
  export function vectorlitePath(): string;
}

declare module 'scribe.js-ocr' {
  /**
   * Scribe.js module interface.
   * Provides OCR capabilities for PDFs and images.
   */
  export interface ScribeModule {
    /**
     * Initialize Scribe.js OCR engine.
     * @param options - Initialization options
     */
    init(options?: {
      /** Enable PDF processing */
      pdf?: boolean;
      /** Enable OCR processing */
      ocr?: boolean;
      /** Enable font recognition */
      font?: boolean;
    }): Promise<void>;

    /**
     * Extract text from files.
     * @param files - Array of file buffers or paths
     * @param langs - Language codes (e.g., ['eng', 'por'])
     * @param format - Output format ('txt', 'hocr', etc.)
     * @returns Extracted text
     */
    extractText(
      files: Array<Buffer | string>,
      langs?: string[],
      format?: string,
    ): Promise<string>;

    /**
     * Terminate the Scribe.js engine and release resources.
     */
    terminate(): Promise<void>;

    /**
     * Internal data caches.
     */
    data: {
      image: ScribeImageCache;
      [key: string]: unknown;
    };
  }

  /**
   * Internal image cache interface.
   */
  export interface ScribeImageCache {
    /**
     * Open a PDF for processing.
     * @param pdfData - PDF data as ArrayBuffer
     */
    openMainPDF(pdfData: ArrayBuffer): Promise<void>;

    /**
     * Get the MuPDF scheduler for rendering.
     */
    getMuPDFScheduler(): Promise<MuPDFScheduler>;
  }

  /**
   * MuPDF scheduler for rendering PDF pages.
   */
  export interface MuPDFScheduler {
    /**
     * Draw a page as PNG.
     * @param options - Rendering options
     * @returns Base64-encoded PNG data URL
     */
    drawPageAsPNG(options: {
      page: number;
      dpi?: number;
      color?: boolean;
    }): Promise<string>;
  }

  /**
   * Default export is the Scribe module instance.
   */
  const scribe: ScribeModule;
  export default scribe;
}
