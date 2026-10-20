/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { extname } from 'node:path';
import type { Chunk } from '../chunkers/types.js';

/** References stay small: media is decoded only when its embedding is needed. */
export type MediaSource =
  | { kind: 'image'; path: string }
  | { kind: 'pdf'; path: string; page: number }
  | { kind: 'audio' | 'video'; path: string; start: number; end: number };

export interface MediaChunk extends Chunk {
  source: MediaSource;
}

export interface MediaDocument {
  chunks: MediaChunk[];
  pageCount?: number;
}

/** Optional capability; text-only embedders and storage need no media decoder. */
export interface MediaEmbeddingCapability {
  canEmbedMedia?(filePath: string): boolean;
  prepareMedia?(filePath: string): Promise<MediaDocument | undefined>;
  embedMedia?(sources: MediaSource[]): Promise<number[][]>;
}

export const AUDIO_VIDEO_EXTENSIONS = [
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.m4a',
  '.aac',
  '.mp4',
  '.webm',
  '.mov',
  '.mkv',
  '.avi',
];

const MEDIA_EXTENSIONS = new Set([
  ...AUDIO_VIDEO_EXTENSIONS,
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
  '.pdf',
]);

export function isMediaFile(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(extname(filePath).toLowerCase());
}
