/**
 * Fixed-size text chunker.
 * Simple chunker that splits text into fixed-size pieces with overlap.
 */

import type {
  Chunk,
  ChunkMetadata,
  ChunkerOptions,
  DocumentChunker,
} from './types.js';
import { DEFAULT_CHUNKER_OPTIONS } from './types.js';

// ============================================================================
// FixedSizeChunker Implementation
// ============================================================================

/**
 * Simple chunker that splits text into fixed-size pieces.
 * Fast and predictable, but may split in the middle of sentences/words.
 */
export class FixedSizeChunker implements DocumentChunker {
  readonly name = 'fixed';
  readonly priority = 50;

  /**
   * Split text into fixed-size chunks.
   */
  async chunk(
    text: string,
    options?: Partial<ChunkerOptions>,
  ): Promise<Chunk[]> {
    const opts = { ...DEFAULT_CHUNKER_OPTIONS, ...options };
    const {
      maxChunkSize,
      chunkOverlap,
      preserveSentences,
      preserveParagraphs,
    } = opts;

    if (!text || text.trim().length === 0) {
      return [];
    }

    // Calculate step size (how much to advance after each chunk)
    const stepSize = maxChunkSize - chunkOverlap;
    if (stepSize <= 0) {
      throw new Error('chunkOverlap must be less than maxChunkSize');
    }

    const chunks: Chunk[] = [];
    let position = 0;
    let index = 0;

    while (position < text.length) {
      let endPosition = Math.min(position + maxChunkSize, text.length);

      // Try to find a better break point if we should preserve boundaries
      if (endPosition < text.length) {
        const searchStart = Math.max(position, endPosition - 100);
        const searchText = text.slice(searchStart, endPosition);

        if (preserveParagraphs) {
          // Try to break at paragraph
          const paragraphBreak = searchText.lastIndexOf('\n\n');
          if (paragraphBreak > 0) {
            endPosition = searchStart + paragraphBreak + 2;
          }
        }

        if (preserveSentences && endPosition === position + maxChunkSize) {
          // Try to break at sentence
          const sentenceBreaks = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
          let bestBreak = -1;

          for (const breakStr of sentenceBreaks) {
            const breakPos = searchText.lastIndexOf(breakStr);
            if (breakPos > bestBreak) {
              bestBreak = breakPos;
            }
          }

          if (bestBreak > 0) {
            endPosition = searchStart + bestBreak + 2;
          }
        }
      }

      const chunkText = text.slice(position, endPosition);

      const metadata: ChunkMetadata = {
        tokenCount: this.estimateTokenCount(chunkText),
      };

      chunks.push({
        index,
        text: chunkText.trim(),
        startOffset: position,
        endOffset: endPosition,
        metadata,
      });

      position += stepSize;
      index++;

      // Prevent infinite loop if text is shorter than overlap
      if (position >= text.length && chunks.length > 0) {
        break;
      }
    }

    return chunks;
  }

  /**
   * Estimate token count (rough approximation).
   */
  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new FixedSizeChunker instance.
 */
export function createFixedSizeChunker(): FixedSizeChunker {
  return new FixedSizeChunker();
}
