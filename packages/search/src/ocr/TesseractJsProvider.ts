/**
 * TesseractJsProvider - OCR provider using tesseract.js.
 * Provides local OCR capabilities for images without requiring external services.
 *
 * For PDF OCR, use ScribeJsProvider instead.
 */

import { readFile } from 'node:fs/promises';
import type { OcrRegion } from '../parsers/types.js';
import type {
  OcrProvider,
  OcrResult,
  OcrTextRegion,
  OcrOptions,
  OcrProgressCallback,
} from './types.js';
import {
  SUPPORTED_LANGUAGES,
  toTesseractLang,
  detectScript,
  type ScriptDetectionResult,
} from './language-detection.js';
import {
  getDefaultOcrCacheDir,
  ensureOcrCacheDir,
  CDN_LANG_PATH,
} from './ocr-utils.js';

// ============================================================================
// Tesseract.js Types (minimal subset we need)
// ============================================================================

interface TesseractWorker {
  load(): Promise<void>;
  loadLanguage(lang: string): Promise<void>;
  initialize(lang: string): Promise<void>;
  recognize(
    image: Buffer | string,
    options?: Record<string, unknown>,
  ): Promise<TesseractRecognizeResult>;
  detect(image: Buffer | string): Promise<TesseractDetectResult>;
  terminate(): Promise<void>;
  setParameters(params: Record<string, unknown>): Promise<void>;
}

interface TesseractDetectResult {
  data: {
    script: string;
    script_confidence: number;
    orientation: number;
    orientation_degrees: number;
    orientation_confidence: number;
  };
}

interface TesseractRecognizeResult {
  data: {
    text: string;
    confidence: number;
    blocks: TesseractBlock[];
  };
}

interface TesseractBlock {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  paragraphs: TesseractParagraph[];
}

interface TesseractParagraph {
  text: string;
  confidence: number;
  lines: TesseractLine[];
}

interface TesseractLine {
  text: string;
  confidence: number;
  words: TesseractWord[];
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Configuration for TesseractJsProvider.
 */
export interface TesseractJsProviderConfig {
  /** Languages to load (ISO 639-3 codes, e.g., 'eng', 'por') */
  languages?: string[];
  /** Path to tesseract worker (optional, for custom builds) */
  workerPath?: string;
  /** Path to language data (optional, defaults to CDN) */
  langPath?: string;
  /** Worker blob path (optional) */
  corePath?: string;
  /** Cache directory for language data (defaults to ~/.auditaria/ocr/) */
  cacheDir?: string;
}

/**
 * Default configuration.
 * Note: workerPath and corePath are left empty for Node.js to use defaults.
 * langPath uses CDN for language data downloads.
 * cacheDir defaults to ~/.auditaria/ocr/ for reusable language data storage.
 */
const DEFAULT_CONFIG: Required<TesseractJsProviderConfig> = {
  languages: ['eng'],
  workerPath: '', // Let tesseract.js resolve this automatically in Node.js
  langPath: CDN_LANG_PATH, // Language data from CDN
  corePath: '', // Let tesseract.js resolve this automatically
  cacheDir: getDefaultOcrCacheDir(), // Store in ~/.auditaria/ocr/
};

// ============================================================================
// TesseractJsProvider Implementation
// ============================================================================

/**
 * OCR provider using tesseract.js.
 * Downloads language data on first use (~30MB per language).
 */
export class TesseractJsProvider implements OcrProvider {
  readonly name = 'tesseract-js';
  readonly supportedLanguages: string[] = SUPPORTED_LANGUAGES;
  readonly priority = 100;

  private config: Required<TesseractJsProviderConfig>;
  private worker: TesseractWorker | null = null;
  private ready: boolean = false;
  private initializing: Promise<void> | null = null;
  private loadedLanguages: Set<string> = new Set();

  constructor(config: TesseractJsProviderConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the provider is ready.
   */
  isReady(): boolean {
    return this.ready && this.worker !== null;
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
        message: 'Loading tesseract.js...',
      });

      // Ensure cache directory exists for storing language data (traineddata files)
      if (this.config.cacheDir) {
        await ensureOcrCacheDir(this.config.cacheDir);
      }

      // Dynamic import for tesseract.js (optional dependency)
      const tesseract = await import('tesseract.js');

      progressCallback?.({
        stage: 'loading',
        progress: 20,
        message: 'Creating worker...',
      });

      // Tesseract.js 5.x API: createWorker(langs, oem, options)
      const tesseractLangs = this.config.languages.map(toTesseractLang);
      const langString = tesseractLangs.join('+');

      // Build worker options
      const workerOptions: Record<string, unknown> = {
        logger: (m: { status: string; progress: number }) => {
          if (progressCallback) {
            let stage: 'loading' | 'recognizing' | 'processing' = 'loading';
            if (m.status.includes('loading')) {
              stage = 'loading';
            } else if (m.status.includes('recognizing')) {
              stage = 'recognizing';
            }
            progressCallback({
              stage,
              progress: Math.round(m.progress * 100),
              message: m.status,
            });
          }
        },
      };

      // Add optional paths if configured
      if (this.config.workerPath) {
        workerOptions['workerPath'] = this.config.workerPath;
      }
      if (this.config.langPath) {
        workerOptions['langPath'] = this.config.langPath;
      }
      if (this.config.corePath) {
        workerOptions['corePath'] = this.config.corePath;
      }
      if (this.config.cacheDir) {
        workerOptions['cachePath'] = this.config.cacheDir; // tesseract.js uses 'cachePath'
      }

      // Create worker with language string (tesseract.js 5.x API)
      this.worker = (await tesseract.createWorker(
        langString,
        1, // OEM_LSTM_ONLY
        workerOptions,
      )) as unknown as TesseractWorker;

      progressCallback?.({
        stage: 'loading',
        progress: 80,
        message: 'Worker ready...',
      });

      for (const lang of this.config.languages) {
        this.loadedLanguages.add(lang);
      }

      progressCallback?.({
        stage: 'loading',
        progress: 100,
        message: 'Ready',
      });

      this.ready = true;
    } catch (error) {
      this.ready = false;
      throw new Error(
        `Failed to initialize Tesseract.js: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Recognize text from an image.
   */
  async recognize(
    image: Buffer | string,
    options?: OcrOptions,
  ): Promise<OcrResult> {
    if (!this.isReady()) {
      throw new Error(
        'TesseractJsProvider not initialized. Call initialize() first.',
      );
    }

    try {
      // Load additional languages if specified
      if (options?.languages) {
        await this.loadLanguages(options.languages);
      }

      const result = await this.worker!.recognize(image);
      return this.convertResult(result);
    } catch (error) {
      throw new Error(
        `OCR recognition failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Recognize text from multiple regions.
   */
  async recognizeRegions(
    regions: OcrRegion[],
    options?: OcrOptions,
  ): Promise<OcrResult[]> {
    if (!this.isReady()) {
      throw new Error(
        'TesseractJsProvider not initialized. Call initialize() first.',
      );
    }

    const results: OcrResult[] = [];

    for (const region of regions) {
      if (!region.imageData) {
        // Skip regions without image data
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
        // Return empty result for failed regions
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
   * Recognize text from a file.
   */
  async recognizeFile(
    filePath: string,
    options?: OcrOptions,
  ): Promise<OcrResult> {
    const imageData = await readFile(filePath);
    return this.recognize(imageData, options);
  }

  /**
   * Recognize text with automatic language detection.
   *
   * This method:
   * 1. First detects the script (writing system) using Tesseract OSD
   * 2. Maps the script to appropriate languages
   * 3. Creates a worker with those languages and runs OCR
   * 4. Returns results with detected language info
   *
   * This is fully automatic - all language data is downloaded on demand.
   *
   * @param image - Image buffer or file path
   * @param options - OCR options (languages option is ignored, auto-detected instead)
   * @param progressCallback - Optional progress callback
   * @returns OCR result with detected language information
   */
  async recognizeWithAutoDetect(
    image: Buffer | string,
    options?: OcrOptions,
    progressCallback?: OcrProgressCallback,
  ): Promise<OcrResult & { detectedScript: ScriptDetectionResult }> {
    progressCallback?.({
      stage: 'processing',
      progress: 0,
      message: 'Starting automatic language detection...',
    });

    // Load image if it's a file path
    let imageData: Buffer | string = image;
    if (typeof image === 'string' && !image.startsWith('data:')) {
      imageData = await readFile(image);
    }

    // Step 1: Detect script using shared language detection
    progressCallback?.({
      stage: 'processing',
      progress: 10,
      message: 'Detecting script and orientation...',
    });

    const cacheDir = getDefaultOcrCacheDir();
    await ensureOcrCacheDir(cacheDir);

    const scriptResult = await detectScript(imageData, cacheDir, (info) => {
      progressCallback?.({
        stage: 'loading',
        progress: 10 + info.progress * 0.3,
        message: info.message,
      });
    });

    progressCallback?.({
      stage: 'processing',
      progress: 40,
      message: `Detected script: ${scriptResult.script} (${Math.round(scriptResult.confidence * 100)}% confidence)`,
    });

    // Step 2: Get languages for detected script
    // Use top 5 languages to balance accuracy and speed
    // For Latin script: eng, por, spa, fra, deu (covers most common languages)
    const detectedLangs = scriptResult.suggestedLanguages.slice(0, 5);

    progressCallback?.({
      stage: 'loading',
      progress: 45,
      message: `Loading languages: ${detectedLangs.join(', ')}...`,
    });

    // Step 3: Create a worker with detected languages and run OCR
    const tesseract = await import('tesseract.js');

    const langString = detectedLangs.map(toTesseractLang).join('+');
    const workerOptions = {
      cachePath: cacheDir, // tesseract.js uses 'cachePath'
      langPath: CDN_LANG_PATH,
      logger: (m: { status: string; progress: number }) => {
        if (progressCallback) {
          progressCallback({
            stage: m.status.includes('loading') ? 'loading' : 'recognizing',
            progress: 45 + m.progress * 45,
            message: m.status,
          });
        }
      },
    } as Record<string, unknown>;

    const worker = (await tesseract.createWorker(
      langString,
      1, // OEM_LSTM_ONLY
      workerOptions,
    )) as unknown as TesseractWorker;

    try {
      progressCallback?.({
        stage: 'recognizing',
        progress: 90,
        message: 'Running OCR...',
      });

      const result = await worker.recognize(imageData);
      const ocrResult = this.convertResult(result);

      progressCallback?.({
        stage: 'processing',
        progress: 100,
        message: 'OCR complete',
      });

      return {
        ...ocrResult,
        language: scriptResult.script, // Add detected script as language hint
        detectedScript: scriptResult,
      };
    } finally {
      await worker.terminate();
    }
  }

  /**
   * Release resources.
   */
  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.loadedLanguages.clear();
  }

  /**
   * Check if requested languages are loaded.
   * In tesseract.js 5.x, languages are set at worker creation.
   */
  private async loadLanguages(languages: string[]): Promise<void> {
    const notLoaded = languages.filter(
      (lang) => !this.loadedLanguages.has(lang),
    );

    if (notLoaded.length > 0) {
      console.warn(
        `[TesseractJsProvider] Requested languages not loaded: ${notLoaded.join(', ')}. ` +
          `Using: ${Array.from(this.loadedLanguages).join(', ')}. ` +
          `To use different languages, reinitialize with the desired languages.`,
      );
    }
  }

  /**
   * Convert Tesseract result to OcrResult.
   */
  private convertResult(result: TesseractRecognizeResult): OcrResult {
    const { data } = result;

    const regions: OcrTextRegion[] = data.blocks.map((block) => ({
      text: block.text.trim(),
      bounds: {
        x: block.bbox.x0,
        y: block.bbox.y0,
        width: block.bbox.x1 - block.bbox.x0,
        height: block.bbox.y1 - block.bbox.y0,
      },
      confidence: block.confidence / 100,
      words: this.extractWords(block),
    }));

    return {
      text: data.text.trim(),
      confidence: data.confidence / 100,
      regions,
    };
  }

  /**
   * Extract words from a block.
   */
  private extractWords(block: TesseractBlock): Array<{
    text: string;
    confidence: number;
    bounds?: OcrTextRegion['bounds'];
  }> {
    const words: Array<{
      text: string;
      confidence: number;
      bounds?: OcrTextRegion['bounds'];
    }> = [];

    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          words.push({
            text: word.text,
            confidence: word.confidence / 100,
            bounds: {
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
            },
          });
        }
      }
    }

    return words;
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new TesseractJsProvider instance.
 */
export function createTesseractJsProvider(
  config?: TesseractJsProviderConfig,
): TesseractJsProvider {
  return new TesseractJsProvider(config);
}

/**
 * Check if tesseract.js is available.
 */
export async function isTesseractAvailable(): Promise<boolean> {
  try {
    await import('tesseract.js');
    return true;
  } catch {
    return false;
  }
}

// Re-export shared utilities for backwards compatibility
export { getDefaultOcrCacheDir } from './ocr-utils.js';
export { detectScript, getLanguagesForScript } from './language-detection.js';
export type { ScriptDetectionResult } from './language-detection.js';
