/**
 * TesseractJsProvider - OCR provider using tesseract.js.
 * Provides local OCR capabilities without requiring external services.
 */

import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { OcrRegion } from '../parsers/types.js';
import type {
  OcrProvider,
  OcrResult,
  OcrTextRegion,
  OcrOptions,
  OcrProgressCallback,
} from './types.js';

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
 * Get the default OCR cache directory path.
 * Uses ~/.auditaria/ocr/ to store language data files (like eng.traineddata).
 * This allows reuse across projects and avoids cluttering the project root.
 */
function getDefaultOcrCacheDir(): string {
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), '.auditaria', 'ocr');
  }
  return path.join(homeDir, '.auditaria', 'ocr');
}

/**
 * Ensure the OCR cache directory exists.
 */
async function ensureOcrCacheDir(cacheDir: string): Promise<void> {
  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }
}

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
 * CDN URLs for tesseract.js resources (version 5.x).
 * Used only in browser environments.
 */
const CDN_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

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
// Language Code Mapping
// ============================================================================

/**
 * Map ISO 639-1 (2-letter) to ISO 639-3 (3-letter) codes used by Tesseract.
 */
const LANG_MAP: Record<string, string> = {
  en: 'eng',
  pt: 'por',
  es: 'spa',
  fr: 'fra',
  de: 'deu',
  it: 'ita',
  nl: 'nld',
  ru: 'rus',
  zh: 'chi_sim',
  ja: 'jpn',
  ko: 'kor',
  ar: 'ara',
};

/**
 * Map detected scripts to recommended languages for OCR.
 * Script detection returns the writing system, not the specific language.
 * This mapping provides reasonable defaults for common scripts.
 *
 * Note: Script detection is not 100% accurate and may sometimes misclassify
 * (e.g., Chinese detected as Latin). Use these as hints, not guarantees.
 *
 * Languages are ordered by global usage/importance. For Latin script,
 * Portuguese is placed early due to Brazil/Portugal being major markets.
 */
const SCRIPT_TO_LANGUAGES: Record<string, string[]> = {
  // Latin: ordered by global importance, Portuguese early for Brazil/Portugal
  Latin: ['eng', 'por', 'spa', 'fra', 'deu', 'ita', 'nld'],
  Cyrillic: ['rus', 'ukr', 'bel', 'bul', 'srp'],
  Arabic: ['ara', 'fas', 'urd'],
  Hebrew: ['heb'],
  Greek: ['ell'],
  // Han: includes Japanese since Kanji may be detected as Han script
  Han: ['chi_sim', 'chi_tra', 'jpn'],
  Hangul: ['kor'],
  Hiragana: ['jpn'],
  Katakana: ['jpn'],
  Japanese: ['jpn'],
  Thai: ['tha'],
  Devanagari: ['hin', 'mar', 'nep', 'san'],
  Tamil: ['tam'],
  Telugu: ['tel'],
  Bengali: ['ben'],
  Gujarati: ['guj'],
  Kannada: ['kan'],
  Malayalam: ['mal'],
  Punjabi: ['pan'],
};

/**
 * Result from script detection.
 */
export interface ScriptDetectionResult {
  /** Detected script name (e.g., 'Latin', 'Cyrillic', 'Han') */
  script: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Suggested languages for the detected script */
  suggestedLanguages: string[];
  /** Detected text orientation in degrees */
  orientationDegrees: number;
  /** Orientation confidence (0-1) */
  orientationConfidence: number;
}

/**
 * Convert language code to Tesseract format.
 */
function toTesseractLang(lang: string): string {
  // If already 3 letters, return as-is
  if (lang.length >= 3) {
    return lang;
  }
  return LANG_MAP[lang.toLowerCase()] || lang;
}

// ============================================================================
// TesseractJsProvider Implementation
// ============================================================================

/**
 * OCR provider using tesseract.js.
 * Downloads language data on first use (~30MB per language).
 */
export class TesseractJsProvider implements OcrProvider {
  readonly name = 'tesseract-js';
  readonly supportedLanguages: string[] = [
    'en',
    'pt',
    'es',
    'fr',
    'de',
    'it',
    'nl',
    'ru',
    'zh',
    'ja',
    'ko',
    'ar',
  ];
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

    // Step 1: Detect script
    progressCallback?.({
      stage: 'processing',
      progress: 10,
      message: 'Detecting script and orientation...',
    });

    const scriptResult = await detectScript(imageData, (info) => {
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
    const cacheDir = getDefaultOcrCacheDir();
    await ensureOcrCacheDir(cacheDir);

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
  private extractWords(
    block: TesseractBlock,
  ): Array<{
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

/**
 * Get the OCR cache directory path.
 * Useful for checking where language data (traineddata) files are stored.
 */
export { getDefaultOcrCacheDir };

// ============================================================================
// Script Detection (Requires Legacy Mode)
// ============================================================================

/**
 * Detect the script (writing system) of an image using Tesseract's OSD.
 *
 * **Important**: This function requires downloading additional legacy model data
 * (~30MB) because OSD is only supported in Tesseract's legacy mode.
 *
 * This is a standalone function that creates a temporary worker with legacy mode
 * enabled, performs detection, and disposes the worker. For repeated detections,
 * consider caching the worker.
 *
 * **Limitations**:
 * - Script detection is not 100% accurate
 * - Chinese/Japanese text may sometimes be detected as Latin
 * - Works best with clear, properly oriented text
 *
 * @param image - Image buffer or file path
 * @param progressCallback - Optional progress callback
 * @returns Script detection result with suggested languages
 *
 * @example
 * ```typescript
 * const result = await detectScript('document.png');
 * console.log(`Script: ${result.script}, Suggested: ${result.suggestedLanguages}`);
 *
 * // Use detected languages for OCR
 * const provider = new TesseractJsProvider({
 *   languages: result.suggestedLanguages.slice(0, 2) // Use top 2 suggestions
 * });
 * ```
 */
export async function detectScript(
  image: Buffer | string,
  progressCallback?: OcrProgressCallback,
): Promise<ScriptDetectionResult> {
  let worker: TesseractWorker | null = null;

  try {
    progressCallback?.({
      stage: 'loading',
      progress: 0,
      message: 'Loading script detection model (legacy mode)...',
    });

    const cacheDir = getDefaultOcrCacheDir();
    await ensureOcrCacheDir(cacheDir);

    const tesseract = await import('tesseract.js');

    progressCallback?.({
      stage: 'loading',
      progress: 30,
      message: 'Creating legacy worker for OSD...',
    });

    // OSD requires legacy mode - this downloads additional model data
    const workerOptions = {
      // OEM_TESSERACT_ONLY for legacy mode (required for OSD)
      legacyCore: true,
      legacyLang: true,
      cachePath: cacheDir, // tesseract.js uses 'cachePath'
      langPath: CDN_LANG_PATH,
      logger: (m: { status: string; progress: number }) => {
        if (progressCallback) {
          progressCallback({
            stage: 'loading',
            progress: 30 + Math.round(m.progress * 50),
            message: m.status,
          });
        }
      },
    } as Record<string, unknown>;
    worker = (await tesseract.createWorker(
      'osd',
      0,
      workerOptions,
    )) as unknown as TesseractWorker;

    progressCallback?.({
      stage: 'processing',
      progress: 80,
      message: 'Detecting script and orientation...',
    });

    // Load image if it's a file path
    let imageData: Buffer | string = image;
    if (typeof image === 'string' && !image.startsWith('data:')) {
      imageData = await readFile(image);
    }

    const result = await worker.detect(imageData);

    progressCallback?.({
      stage: 'processing',
      progress: 100,
      message: 'Detection complete',
    });

    const detectedScript = result.data.script || 'Unknown';
    const suggestedLanguages = SCRIPT_TO_LANGUAGES[detectedScript] || ['eng'];

    return {
      script: detectedScript,
      confidence: result.data.script_confidence / 100,
      suggestedLanguages,
      orientationDegrees: result.data.orientation_degrees,
      orientationConfidence: result.data.orientation_confidence / 100,
    };
  } finally {
    if (worker) {
      await worker.terminate();
    }
  }
}

/**
 * Get suggested languages for a script name.
 * Useful when you already know the script from other sources.
 *
 * @param scriptName - Script name (e.g., 'Latin', 'Cyrillic', 'Han')
 * @returns Array of suggested Tesseract language codes
 */
export function getLanguagesForScript(scriptName: string): string[] {
  return SCRIPT_TO_LANGUAGES[scriptName] || ['eng'];
}
