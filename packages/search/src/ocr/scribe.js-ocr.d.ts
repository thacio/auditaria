/**
 * Type declarations for scribe.js-ocr package.
 * @see https://github.com/scribeocr/scribe.js
 */

declare module 'scribe.js-ocr' {
  export interface ScribeInitParams {
    /** Enable PDF support */
    pdf?: boolean;
    /** Enable OCR support */
    ocr?: boolean;
    /** Enable font recognition */
    font?: boolean;
  }

  export interface ScribeRecognizeOptions {
    /** OCR mode: 'speed' or 'quality' */
    mode?: 'speed' | 'quality';
    /** Languages for OCR (ISO 639-3 codes) */
    langs?: string[];
    /** Advanced mode: 'lstm', 'legacy', or 'combined' */
    modeAdv?: 'lstm' | 'legacy' | 'combined';
    /** Combine mode: 'conf', 'data', or 'none' */
    combineMode?: 'conf' | 'data' | 'none';
    /** Use vanilla Tesseract.js model */
    vanillaMode?: boolean;
    /** Custom Tesseract.js configuration */
    config?: Record<string, unknown>;
  }

  export interface ScribeExtractTextOptions {
    /** Languages for OCR (ISO 639-3 codes) */
    langs?: string[];
    /** Output format: 'text' or 'hocr' */
    format?: string;
  }

  export interface SortedInputFiles {
    pdfFiles?: Array<File | string | ArrayBuffer>;
    imageFiles?: Array<File | string | ArrayBuffer>;
    ocrFiles?: Array<File | string | ArrayBuffer>;
  }

  export interface ScribeModule {
    /**
     * Initialize scribe.js with optional resource pre-loading.
     */
    init(params?: ScribeInitParams): Promise<void>;

    /**
     * Import files for processing.
     */
    importFiles(
      files: Array<File | string | ArrayBuffer> | SortedInputFiles,
    ): Promise<void>;

    /**
     * Run OCR on imported documents.
     */
    recognize(options?: ScribeRecognizeOptions): Promise<void>;

    /**
     * Export processed data in specified format.
     */
    exportData(
      format: 'pdf' | 'hocr' | 'docx' | 'xlsx' | 'txt' | 'text',
      minPage?: number,
      maxPage?: number,
    ): Promise<string | ArrayBuffer>;

    /**
     * Simple text extraction from files.
     * @param files - Array of files to process (paths, File objects, or buffers)
     * @param langs - Array of language codes (default: ['eng'])
     * @param outputFormat - Output format: 'txt' or 'hocr' (default: 'txt')
     * @param options - Additional options
     */
    extractText(
      files: Array<File | string | Buffer | ArrayBuffer>,
      langs?: string[],
      outputFormat?: 'txt' | 'hocr',
      options?: Record<string, unknown>,
    ): Promise<string>;

    /**
     * Remove document-specific data.
     */
    clear(): Promise<void>;

    /**
     * Release all resources.
     */
    terminate(): Promise<void>;

    /**
     * Write debug images for visualization.
     */
    writeDebugImages(): Promise<ArrayBuffer[]>;
  }

  const scribe: ScribeModule;
  export default scribe;
}
