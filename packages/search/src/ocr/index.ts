/**
 * OCR module for the search package.
 * Provides optical character recognition capabilities for scanned documents.
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

// TesseractJsProvider
export {
  TesseractJsProvider,
  createTesseractJsProvider,
  isTesseractAvailable,
  type TesseractJsProviderConfig,
} from './TesseractJsProvider.js';

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
