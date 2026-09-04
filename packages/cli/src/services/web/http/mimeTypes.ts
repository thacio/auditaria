/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

/**
 * Content-type table for the `/preview-file` endpoint. Text types carry an
 * explicit UTF-8 charset so browsers never guess.
 *
 * Kept in sync with `packages/web-client/src/utils/binaryExtensions.js`.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  // HTML & Web
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.rss': 'application/rss+xml; charset=utf-8',
  '.atom': 'application/atom+xml; charset=utf-8',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',

  // Data formats
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.toml': 'application/toml; charset=utf-8',
  '.ini': 'text/plain; charset=utf-8',
  '.conf': 'text/plain; charset=utf-8',
  '.cfg': 'text/plain; charset=utf-8',

  // Text files
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.rtf': 'application/rtf',

  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mkv': 'video/x-matroska',
  '.m4v': 'video/x-m4v',
  '.ogv': 'video/ogg',

  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wma': 'audio/x-ms-wma',
  '.opus': 'audio/opus',

  // Archives
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz',
  '.iso': 'application/x-iso9660-image',

  // Executables
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.dll': 'application/x-msdownload',
  '.dmg': 'application/x-apple-diskimage',
  '.pkg': 'application/x-newton-compatible-pkg',
  '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-rpm',

  // Programming languages (common source code)
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.jsx': 'text/jsx; charset=utf-8',
  '.py': 'text/x-python; charset=utf-8',
  '.rb': 'text/x-ruby; charset=utf-8',
  '.php': 'text/x-php; charset=utf-8',
  '.java': 'text/x-java; charset=utf-8',
  '.c': 'text/x-c; charset=utf-8',
  '.cpp': 'text/x-c++; charset=utf-8',
  '.h': 'text/x-c; charset=utf-8',
  '.hpp': 'text/x-c++; charset=utf-8',
  '.cs': 'text/x-csharp; charset=utf-8',
  '.go': 'text/x-go; charset=utf-8',
  '.rs': 'text/x-rust; charset=utf-8',
  '.swift': 'text/x-swift; charset=utf-8',
  '.kt': 'text/x-kotlin; charset=utf-8',
  '.sh': 'application/x-sh; charset=utf-8',
  '.bash': 'application/x-sh; charset=utf-8',
  '.zsh': 'application/x-sh; charset=utf-8',

  // Other
  '.wasm': 'application/wasm',
  '.ics': 'text/calendar; charset=utf-8',
  '.vcf': 'text/vcard; charset=utf-8',
};

/** Extensions read as bytes (everything else is decoded as UTF-8 text). */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.tiff',
  '.tif',
  '.avif',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  // Documents
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // Video
  '.mp4',
  '.webm',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.mkv',
  '.m4v',
  '.ogv',
  // Audio
  '.mp3',
  '.wav',
  '.ogg',
  '.aac',
  '.m4a',
  '.flac',
  '.wma',
  '.opus',
  // Archives
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.gz',
  '.bz2',
  '.xz',
  '.iso',
  // Executables and binaries
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.dmg',
  '.pkg',
  '.deb',
  '.rpm',
]);

/** Extensions streamed with HTTP Range support so players can seek. */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4',
  '.webm',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.mkv',
  '.m4v',
  '.ogv',
  '.mp3',
  '.wav',
  '.ogg',
  '.aac',
  '.m4a',
  '.flac',
  '.wma',
  '.opus',
]);

export const OCTET_STREAM = 'application/octet-stream';

/** `ext` must be lower-case and include the leading dot. */
export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext] ?? OCTET_STREAM;
}

export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext);
}

export function isMediaExtension(ext: string): boolean {
  return MEDIA_EXTENSIONS.has(ext);
}

export function isHtmlExtension(ext: string): boolean {
  return ext === '.html' || ext === '.htm';
}
