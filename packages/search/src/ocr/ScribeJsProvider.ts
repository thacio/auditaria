/**
 * ScribeJsProvider - OCR provider using scribe.js-ocr.
 * Provides PDF OCR capabilities that tesseract.js cannot handle directly.
 *
 * Scribe.js builds on Tesseract.js and adds:
 * - Native PDF support (both text-native and image-based PDFs)
 * - Higher accuracy OCR
 * - Ability to create searchable PDFs with invisible text layers
 *
 * Note: Scribe.js uses AGPL 3.0 license.
 *
 * For image OCR, use TesseractJsProvider instead (faster for images).
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ScribeModule } from 'scribe.js-ocr';
import type { OcrRegion } from '../parsers/types.js';
import type {
  OcrProvider,
  OcrResult,
  OcrOptions,
  OcrProgressCallback,
} from './types.js';
import {
  SUPPORTED_LANGUAGES,
  toTesseractLangs,
  detectScript,
  type ScriptDetectionResult,
} from './language-detection.js';
import {
  getDefaultOcrCacheDir,
  ensureOcrCacheDir,
  isPdfFile,
} from './ocr-utils.js';

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for ScribeJsProvider.
 */
export interface ScribeJsProviderConfig {
  /** Languages for OCR (ISO 639-3 codes, e.g., 'eng', 'por') */
  languages?: string[];
  /** OCR quality mode. 'quality' is slower but more accurate. Default: 'quality' */
  mode?: 'speed' | 'quality';
  /** Cache directory for OCR data */
  cacheDir?: string;
}

/**
 * Default configuration.
 */
const DEFAULT_CONFIG: Required<ScribeJsProviderConfig> = {
  languages: ['eng'],
  mode: 'quality',
  cacheDir: getDefaultOcrCacheDir(),
};

// ============================================================================
// ScribeJsProvider Implementation
// ============================================================================

/**
 * OCR provider using scribe.js-ocr for PDF documents.
 *
 * Key features:
 * - Native PDF OCR support (tesseract.js cannot read PDFs directly)
 * - Can extract existing text from text-native PDFs
 * - Can run OCR on scanned/image-based PDFs
 * - Higher accuracy than vanilla Tesseract
 *
 * Performance note: Scribe.js is 40-90% slower than Tesseract.js
 * but provides better accuracy.
 */
export class ScribeJsProvider implements OcrProvider {
  readonly name = 'scribe-js';
  readonly supportedLanguages: string[] = SUPPORTED_LANGUAGES;
  readonly priority = 150; // Higher priority than TesseractJsProvider for PDFs

  private config: Required<ScribeJsProviderConfig>;
  private scribe: ScribeModule | null = null;
  private ready: boolean = false;
  private initializing: Promise<void> | null = null;

  constructor(config: ScribeJsProviderConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the provider is ready.
   */
  isReady(): boolean {
    return this.ready && this.scribe !== null;
  }

  /**
   * Initialize the OCR provider.
   */
  async initialize(progressCallback?: OcrProgressCallback): Promise<void> {
    if (this.ready) {
      return;
    }

    if (this.initializing) {
      await this.initializing;
      return;
    }

    this.initializing = this.doInitialize(progressCallback);
    await this.initializing;
    this.initializing = null;
  }

  private async doInitialize(
    progressCallback?: OcrProgressCallback,
  ): Promise<void> {
    try {
      progressCallback?.({
        stage: 'loading',
        progress: 0,
        message: 'Loading scribe.js-ocr...',
      });

      // Ensure cache directory exists
      if (this.config.cacheDir) {
        await ensureOcrCacheDir(this.config.cacheDir);
      }

      // Dynamic import for scribe.js-ocr (optional dependency)
      const scribeModule = await import('scribe.js-ocr');
      this.scribe = scribeModule.default;

      progressCallback?.({
        stage: 'loading',
        progress: 50,
        message: 'Initializing scribe.js...',
      });

      // Initialize with PDF and OCR support
      await this.scribe.init({
        pdf: true,
        ocr: true,
        font: false, // We don't need font recognition
      });

      progressCallback?.({
        stage: 'loading',
        progress: 100,
        message: 'Ready',
      });

      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(
        `Failed to initialize Scribe.js: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Recognize text from a PDF or image.
   * For images, consider using TesseractJsProvider for better performance.
   */
  async recognize(
    image: Buffer | string,
    options?: OcrOptions,
  ): Promise<OcrResult> {
    if (!this.isReady()) {
      await this.initialize();
    }

    try {
      // Determine languages
      const langs = options?.languages
        ? toTesseractLangs(options.languages)
        : this.config.languages;

      // Convert file path to buffer if needed
      let inputData: Buffer | string = image;
      if (typeof image === 'string' && !image.startsWith('data:')) {
        inputData = await readFile(image);
      }

      // Use extractText for simple OCR
      // API: extractText(files, langs, outputFormat, options)
      const text = await this.scribe!.extractText(
        [inputData as Buffer],
        langs,
        'txt',
      );

      return {
        text: text.trim(),
        confidence: 0.9, // Scribe.js doesn't provide overall confidence
        regions: [], // Simple extraction doesn't provide region info
      };
    } catch (error) {
      throw new Error(
        `OCR recognition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Recognize text from multiple regions.
   * Note: Scribe.js processes entire documents, so regions are processed individually.
   */
  async recognizeRegions(
    regions: OcrRegion[],
    options?: OcrOptions,
  ): Promise<OcrResult[]> {
    const results: OcrResult[] = [];

    for (const region of regions) {
      if (!region.imageData) {
        results.push({
          text: '',
          confidence: 0,
          regions: [],
        });
        continue;
      }

      try {
        const result = await this.recognize(region.imageData, {
          ...options,
          languages: region.language ? [region.language] : options?.languages,
        });
        results.push(result);
      } catch (_error) {
        results.push({
          text: '',
          confidence: 0,
          regions: [],
        });
      }
    }

    return results;
  }

  /**
   * Recognize text from a file (PDF or image).
   * This is the primary method for PDF OCR.
   */
  async recognizeFile(
    filePath: string,
    options?: OcrOptions,
  ): Promise<OcrResult> {
    if (!this.isReady()) {
      await this.initialize();
    }

    try {
      // Determine languages
      const langs = options?.languages
        ? toTesseractLangs(options.languages)
        : this.config.languages;

      // Use extractText with file path
      // API: extractText(files, langs, outputFormat, options)
      const text = await this.scribe!.extractText([filePath], langs, 'txt');

      return {
        text: text.trim(),
        confidence: 0.9, // Scribe.js doesn't provide overall confidence
        regions: [],
      };
    } catch (error) {
      throw new Error(
        `OCR recognition failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Render first page of PDF as image for script detection.
   * Uses Scribe.js internal MuPDF to render PDF pages.
   */
  private async renderPdfFirstPage(
    pdfPath: string,
    progressCallback?: OcrProgressCallback,
  ): Promise<Buffer> {
    progressCallback?.({
      stage: 'processing',
      progress: 5,
      message: 'Reading PDF file...',
    });

    // Read the PDF file
    const pdfBuffer = await readFile(pdfPath);
    const pdfArrayBuffer = pdfBuffer.buffer.slice(
      pdfBuffer.byteOffset,
      pdfBuffer.byteOffset + pdfBuffer.byteLength,
    );

    progressCallback?.({
      stage: 'processing',
      progress: 10,
      message: 'Opening PDF with MuPDF...',
    });

    // Open the PDF using Scribe's internal ImageCache
    const imageCache = this.scribe!.data.image;
    await imageCache.openMainPDF(pdfArrayBuffer);

    progressCallback?.({
      stage: 'processing',
      progress: 20,
      message: 'Rendering first page...',
    });

    // Get MuPDF scheduler and render first page
    const muPdfScheduler = await imageCache.getMuPDFScheduler();
    const pngBase64 = await muPdfScheduler.drawPageAsPNG({
      page: 1, // 1-indexed
      dpi: 150, // Lower DPI for faster detection, still enough for script detection
      color: false, // Grayscale is fine for script detection
    });

    progressCallback?.({
      stage: 'processing',
      progress: 30,
      message: 'First page rendered, preparing for detection...',
    });

    // Convert base64 to Buffer
    // The returned string is a data URL: "data:image/png;base64,..."
    const base64Data = pngBase64.includes(',')
      ? pngBase64.split(',')[1]
      : pngBase64;
    return Buffer.from(base64Data, 'base64');
  }

  /**
   * Recognize text with automatic language detection.
   *
   * This method:
   * 1. For PDFs: First renders a page to image for script detection
   * 2. Detects the script (writing system) using Tesseract OSD
   * 3. Maps the script to appropriate languages
   * 4. Runs OCR with detected languages
   *
   * @param input - PDF file path or image buffer
   * @param options - OCR options (languages option is ignored, auto-detected instead)
   * @param progressCallback - Optional progress callback
   * @returns OCR result with detected language information
   */
  async recognizeWithAutoDetect(
    input: Buffer | string,
    options?: OcrOptions,
    progressCallback?: OcrProgressCallback,
  ): Promise<OcrResult & { detectedScript?: ScriptDetectionResult }> {
    if (!this.isReady()) {
      await this.initialize(progressCallback);
    }

    progressCallback?.({
      stage: 'processing',
      progress: 0,
      message: 'Starting automatic language detection...',
    });

    const isPdf = typeof input === 'string' && isPdfFile(input);
    let scriptResult: ScriptDetectionResult | undefined;

    const cacheDir = getDefaultOcrCacheDir();
    await ensureOcrCacheDir(cacheDir);

    if (isPdf && typeof input === 'string') {
      // For PDFs: render first page and detect script
      progressCallback?.({
        stage: 'processing',
        progress: 5,
        message: 'Rendering PDF page for language detection...',
      });

      try {
        const pageImage = await this.renderPdfFirstPage(
          input,
          progressCallback,
        );

        progressCallback?.({
          stage: 'processing',
          progress: 35,
          message: 'Detecting script from PDF page...',
        });

        scriptResult = await detectScript(pageImage, cacheDir, (info) => {
          progressCallback?.({
            stage: info.stage,
            progress: 35 + info.progress * 0.15,
            message: info.message,
          });
        });
      } catch (error) {
        // If PDF rendering fails, fall back to default languages
        console.warn(
          `PDF page rendering failed, using default languages: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else if (typeof input !== 'string' || !input.startsWith('data:')) {
      // For images, detect script directly
      progressCallback?.({
        stage: 'processing',
        progress: 10,
        message: 'Detecting script from image...',
      });

      const imageBuffer =
        typeof input === 'string' ? await readFile(input) : input;

      scriptResult = await detectScript(imageBuffer, cacheDir, (info) => {
        progressCallback?.({
          stage: info.stage,
          progress: 10 + info.progress * 0.3,
          message: info.message,
        });
      });
    }

    // Determine languages from detected script or use defaults
    const langs = scriptResult
      ? scriptResult.suggestedLanguages.slice(0, 5)
      : this.config.languages;

    progressCallback?.({
      stage: 'recognizing',
      progress: 50,
      message: `Running OCR with languages: ${langs.join(', ')}...`,
    });

    try {
      // Read file if it's a path
      let inputData: Buffer | string = input;
      if (typeof input === 'string' && !input.startsWith('data:')) {
        inputData = isPdf ? input : await readFile(input);
      }

      // For PDFs, use file path directly (Scribe.js handles PDF parsing)
      // For images, use buffer
      const files =
        isPdf && typeof input === 'string' ? [input] : [inputData as Buffer];

      // API: extractText(files, langs, outputFormat, options)
      const text = await this.scribe!.extractText(files, langs, 'txt');

      progressCallback?.({
        stage: 'processing',
        progress: 100,
        message: 'OCR complete',
      });

      return {
        text: text.trim(),
        confidence: 0.9,
        regions: [],
        language: scriptResult?.script,
        detectedScript: scriptResult,
      };
    } catch (error) {
      throw new Error(
        `OCR recognition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Release resources.
   */
  async dispose(): Promise<void> {
    if (this.scribe) {
      try {
        await this.scribe.terminate();
      } catch {
        // Ignore termination errors
      }
      this.scribe = null;
    }
    this.ready = false;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new ScribeJsProvider instance.
 */
export function createScribeJsProvider(
  config?: ScribeJsProviderConfig,
): ScribeJsProvider {
  return new ScribeJsProvider(config);
}

/**
 * Check if scribe.js-ocr is available.
 */
export async function isScribeAvailable(): Promise<boolean> {
  try {
    await import('scribe.js-ocr');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a file is supported by ScribeJsProvider.
 * ScribeJsProvider specializes in PDFs but can handle images too.
 */
export function isScribeSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    ext === '.pdf' ||
    [
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.bmp',
      '.tiff',
      '.tif',
      '.webp',
    ].includes(ext)
  );
}
