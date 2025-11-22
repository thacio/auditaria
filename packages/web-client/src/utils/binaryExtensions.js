/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Binary file detection for preview system

/**
 * List of file extensions that are considered binary (non-text) files
 *
 * This list is used to determine if a file should be:
 * 1. Opened in preview mode (if preview available)
 * 2. Rejected from Monaco editor (cannot edit binary files)
 * 3. Served with proper MIME types via /preview-file/* endpoint
 *
 * Synchronized with WebInterfaceService.ts binary extensions list
 */
export const BINARY_EXTENSIONS = [
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.tif', '.avif',

  // Fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',

  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',

  // Video
  '.mp4', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.m4v', '.ogv',

  // Audio
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.opus',

  // Archives
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso',

  // Executables and binaries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dmg', '.pkg', '.deb', '.rpm',

  // Other binary formats
  '.wasm'
];

/**
 * Check if a file is binary based on its extension
 *
 * @param {string} filename - Full filename or path
 * @returns {boolean} True if file is binary, false if text
 */
export function isBinaryFile(filename) {
  if (!filename) return false;

  // Extract extension (case-insensitive)
  const match = filename.toLowerCase().match(/(\.[^.]+)$/);
  if (!match) return false;

  const ext = match[1];
  return BINARY_EXTENSIONS.includes(ext);
}

/**
 * Get file extension from filename or path
 *
 * @param {string} filename - Full filename or path
 * @returns {string} Extension including dot (e.g., '.png') or empty string
 */
export function getFileExtension(filename) {
  if (!filename) return '';

  const match = filename.toLowerCase().match(/(\.[^.]+)$/);
  return match ? match[1] : '';
}

/**
 * Check if file extension is in a specific category
 *
 * @param {string} filename - Full filename or path
 * @param {string} category - Category: 'image', 'video', 'audio', 'document', 'archive'
 * @returns {boolean} True if file belongs to category
 */
export function isFileCategory(filename, category) {
  const ext = getFileExtension(filename);
  if (!ext) return false;

  const categories = {
    image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.tif', '.avif', '.svg'],
    video: ['.mp4', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.m4v', '.ogv'],
    audio: ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.opus'],
    document: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp'],
    archive: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso'],
    font: ['.woff', '.woff2', '.ttf', '.eot', '.otf']
  };

  return categories[category]?.includes(ext) || false;
}
