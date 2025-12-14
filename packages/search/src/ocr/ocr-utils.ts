/**
 * Shared utilities for OCR providers.
 *
 * This module provides common functionality used by both
 * TesseractJsProvider and ScribeJsProvider.
 */

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Cache Directory Management
// ============================================================================

/**
 * Get the default OCR cache directory path.
 * Uses ~/.auditaria/ocr/ to store language data files (like eng.traineddata).
 * This allows reuse across projects and avoids cluttering the project root.
 */
export function getDefaultOcrCacheDir(): string {
  const homeDir = os.homedir();
  if (!homeDir) {
    return path.join(os.tmpdir(), '.auditaria', 'ocr');
  }
  return path.join(homeDir, '.auditaria', 'ocr');
}

/**
 * Ensure the OCR cache directory exists.
 */
export async function ensureOcrCacheDir(cacheDir: string): Promise<void> {
  if (!existsSync(cacheDir)) {
    await mkdir(cacheDir, { recursive: true });
  }
}

// ============================================================================
// File Type Utilities
// ============================================================================

/**
 * Image file extensions supported by OCR.
 */
export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
];

/**
 * PDF file extension.
 */
export const PDF_EXTENSION = '.pdf';

/**
 * Check if a file is an image based on extension.
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a file is a PDF based on extension.
 */
export function isPdfFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === PDF_EXTENSION;
}

/**
 * Check if a file is supported for OCR (image or PDF).
 */
export function isOcrSupported(filePath: string): boolean {
  return isImageFile(filePath) || isPdfFile(filePath);
}

// ============================================================================
// CDN Configuration
// ============================================================================

/**
 * CDN URLs for tesseract.js resources (version 4.0.0).
 * Used for language data downloads.
 */
export const CDN_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';
