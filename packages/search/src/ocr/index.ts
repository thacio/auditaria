/**
 * OCR module for the search package.
 * Provides optical character recognition capabilities for scanned documents.
 *
 * Providers:
 * - TesseractJsProvider: For images (PNG, JPG, etc.) - fast and lightweight
 * - ScribeJsProvider: For PDFs - native PDF support with higher accuracy
 *
 * The OcrRegistry automatically selects the best provider based on file type.
 */

// Types
export type {
  OcrProvider,
  OcrResult,
  OcrTextRegion,
  OcrWord,
  OcrOptions,
  OcrRegistryOptions,
  OcrJob,
  OcrJobStatus,
  OcrQueueConfig,
  OcrProgressCallback,
  OcrProgressInfo,
  OcrEvents,
  OcrMergeOptions,
  OcrMergeResult,
} from './types.js';

// Shared Language Detection (used by both providers)
export {
  LANG_MAP,
  SCRIPT_TO_LANGUAGES,
  SUPPORTED_LANGUAGES,
  toTesseractLang,
  toTesseractLangs,
  getLanguagesForScript,
  detectScript,
  type ScriptDetectionResult,
  type ScriptDetectionProgress,
} from './language-detection.js';

// Shared OCR Utilities
export {
  getDefaultOcrCacheDir,
  ensureOcrCacheDir,
  IMAGE_EXTENSIONS,
  PDF_EXTENSION,
  isImageFile,
  isPdfFile,
  isOcrSupported,
  CDN_LANG_PATH,
} from './ocr-utils.js';

// TesseractJsProvider (for images)
export {
  TesseractJsProvider,
  createTesseractJsProvider,
  isTesseractAvailable,
  type TesseractJsProviderConfig,
} from './TesseractJsProvider.js';

// ScribeJsProvider (for PDFs)
export {
  ScribeJsProvider,
  createScribeJsProvider,
  isScribeAvailable,
  isScribeSupportedFile,
  type ScribeJsProviderConfig,
} from './ScribeJsProvider.js';

// OcrRegistry
export {
  OcrRegistry,
  createOcrRegistry,
  createOcrRegistryAsync,
} from './OcrRegistry.js';

// OcrQueueManager
export {
  OcrQueueManager,
  createOcrQueueManager,
  type OcrQueueState,
  type OcrQueueStatus,
} from './OcrQueueManager.js';
