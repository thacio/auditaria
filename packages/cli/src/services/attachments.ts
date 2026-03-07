/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ATTACHMENTS_FEATURE: Shared attachment handling for Telegram and Discord bots

import { debugLogger } from '@google/gemini-cli-core';

/**
 * Allowed image MIME types — only formats Gemini supports natively via vision.
 * No text files, PDFs, or executables — they expand the attack surface beyond
 * what text input already allows (prompt injection, parser exploits).
 */
export const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Allowed file extensions (mapped to MIME types for validation) */
const EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Maximum file size in bytes (5 MB) */
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

/** Maximum number of attachments per message */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/** PNG magic bytes */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
/** JPEG magic bytes */
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
/** GIF magic bytes */
const GIF_MAGIC = [0x47, 0x49, 0x46];
/** WEBP magic bytes (RIFF....WEBP) */
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];

/**
 * Validated attachment ready to be converted to an inlineData Part.
 */
export interface ValidatedAttachment {
  data: Buffer;
  mimeType: string;
  fileName: string;
}

/**
 * Checks if the first bytes of a buffer match the expected MIME type.
 * Prevents extension spoofing (e.g., renaming .exe to .png).
 */
function matchesMagicBytes(data: Buffer, mimeType: string): boolean {
  if (data.length < 12) return false;

  switch (mimeType) {
    case 'image/png':
      return PNG_MAGIC.every((b, i) => data[i] === b);
    case 'image/jpeg':
      return JPEG_MAGIC.every((b, i) => data[i] === b);
    case 'image/gif':
      return GIF_MAGIC.every((b, i) => data[i] === b);
    case 'image/webp':
      // WEBP is RIFF container with WEBP at offset 8
      return (
        RIFF_MAGIC.every((b, i) => data[i] === b) &&
        data[8] === 0x57 &&
        data[9] === 0x45 &&
        data[10] === 0x42 &&
        data[11] === 0x50
      );
    default:
      return false;
  }
}

/**
 * Resolves a MIME type from a file name extension.
 * Returns undefined if the extension is not in the allowlist.
 */
export function mimeFromExtension(fileName: string): string | undefined {
  const ext =
    fileName.lastIndexOf('.') >= 0
      ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
      : '';
  return EXTENSION_TO_MIME[ext];
}

/**
 * Validates an attachment: checks MIME type, size, and magic bytes.
 * Returns an error string if invalid, or undefined if valid.
 */
export function validateAttachment(
  data: Buffer,
  mimeType: string,
  fileName: string,
  sizeBytes: number,
): string | undefined {
  // Check size
  if (sizeBytes > MAX_ATTACHMENT_SIZE) {
    return `File "${fileName}" is too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_ATTACHMENT_SIZE / 1024 / 1024} MB.`;
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return `File type "${mimeType}" is not allowed. Only images (PNG, JPG, GIF, WEBP) are supported.`;
  }

  // Check magic bytes
  if (!matchesMagicBytes(data, mimeType)) {
    debugLogger.debug(
      `Attachment "${fileName}" failed magic byte check for ${mimeType}`,
    );
    return `File "${fileName}" does not match its declared type. The file content doesn't appear to be a valid ${mimeType}.`;
  }

  return undefined;
}

/**
 * Converts validated attachments to Gemini inlineData parts.
 */
export function attachmentsToParts(
  attachments: ValidatedAttachment[],
): Array<{ inlineData: { data: string; mimeType: string } }> {
  return attachments.map((att) => ({
    inlineData: {
      data: att.data.toString('base64'),
      mimeType: att.mimeType,
    },
  }));
}
