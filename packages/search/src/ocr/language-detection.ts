/**
 * Shared language and script detection utilities for OCR providers.
 *
 * This module provides common language mapping and script detection
 * functionality used by both TesseractJsProvider and ScribeJsProvider.
 */

import { readFile } from 'node:fs/promises';

// ============================================================================
// Language Code Mapping
// ============================================================================

/**
 * Map ISO 639-1 (2-letter) to ISO 639-3 (3-letter) codes used by Tesseract.
 */
export const LANG_MAP: Record<string, string> = {
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
export const SCRIPT_TO_LANGUAGES: Record<string, string[]> = {
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
 * List of commonly supported languages across OCR providers.
 */
export const SUPPORTED_LANGUAGES: string[] = [
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

// ============================================================================
// Language Code Utilities
// ============================================================================

/**
 * Convert language code to Tesseract format (ISO 639-3).
 * Accepts both 2-letter (ISO 639-1) and 3-letter (ISO 639-3) codes.
 */
export function toTesseractLang(lang: string): string {
  // If already 3 letters, return as-is
  if (lang.length >= 3) {
    return lang;
  }
  return LANG_MAP[lang.toLowerCase()] || lang;
}

/**
 * Convert an array of language codes to Tesseract format.
 */
export function toTesseractLangs(langs: string[]): string[] {
  return langs.map(toTesseractLang);
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

// ============================================================================
// Script Detection Types
// ============================================================================

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
 * Progress callback for script detection.
 */
export interface ScriptDetectionProgress {
  stage: 'loading' | 'processing';
  progress: number;
  message: string;
}

// ============================================================================
// Tesseract Types for Script Detection
// ============================================================================

interface TesseractWorker {
  detect(image: Buffer | string): Promise<TesseractDetectResult>;
  terminate(): Promise<void>;
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

// ============================================================================
// Script Detection Implementation
// ============================================================================

/** CDN URL for tesseract.js language data (version 4.0.0). */
const CDN_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

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
 * @param cacheDir - Directory to store language data files
 * @param progressCallback - Optional progress callback
 * @returns Script detection result with suggested languages
 *
 * @example
 * ```typescript
 * const result = await detectScript('document.png', '~/.auditaria/ocr');
 * console.log(`Script: ${result.script}, Suggested: ${result.suggestedLanguages}`);
 * ```
 */
export async function detectScript(
  image: Buffer | string,
  cacheDir: string,
  progressCallback?: (progress: ScriptDetectionProgress) => void,
): Promise<ScriptDetectionResult> {
  let worker: TesseractWorker | null = null;

  try {
    progressCallback?.({
      stage: 'loading',
      progress: 0,
      message: 'Loading script detection model (legacy mode)...',
    });

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
      cachePath: cacheDir,
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
