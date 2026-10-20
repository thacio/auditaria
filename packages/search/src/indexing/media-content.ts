/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParsedDocument } from '../parsers/types.js';
import type { MediaEmbeddingCapability } from '../embedders/media.js';

/** Adapt media to existing chunks and source references without a storage migration. */
export async function prepareMediaContent(
  embedder: MediaEmbeddingCapability,
  path: string,
) {
  const media = await embedder.prepareMedia?.(path);
  if (!media) return undefined;
  if (!embedder.embedMedia)
    throw new Error('Media preparation requires a media embedder');
  const parsed: ParsedDocument = {
    text: media.chunks.map((chunk) => chunk.text).join('\n'),
    title: null,
    metadata: { pageCount: media.pageCount },
    requiresOcr: false,
  };
  return {
    parsed,
    chunks: media.chunks,
    sources: media.chunks.map((chunk) => chunk.source),
  };
}
