/**
 * Recursive text chunker.
 * Splits text by trying different separators recursively to find optimal chunks.
 */

import type {
  Chunk,
  ChunkMetadata,
  ChunkerOptions,
  DocumentChunker,
} from './types.js';
import { DEFAULT_CHUNKER_OPTIONS } from './types.js';

// ============================================================================
// Utility: Event Loop Yielding
// ============================================================================

/** Yield to the event loop to prevent blocking */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** How often to yield during chunk processing */
const YIELD_EVERY_N_CHUNKS = 20;

// ============================================================================
// Constants
// ============================================================================

/** Separators to try, in order of preference (largest to smallest) */
const SEPARATORS = [
  '\n\n\n', // Multiple blank lines (major sections)
  '\n\n', // Paragraph breaks
  '\n', // Line breaks
  '. ', // Sentence endings
  '! ',
  '? ',
  '; ', // Clause separators
  ', ', // Phrase separators
  ' ', // Word boundaries
  '', // Character-by-character (last resort)
];

/** Heading patterns to detect sections */
const HEADING_PATTERNS = [
  /^#{1,6}\s+(.+)$/m, // Markdown headings
  /^(.+)\n[=-]{3,}$/m, // Underlined headings
  /^(?:Chapter|Section|Part)\s+\d+[:.]\s*(.+)$/im, // Chapter/Section markers
];

// ============================================================================
// RecursiveChunker Implementation
// ============================================================================

/**
 * Recursively splits text into chunks using a hierarchy of separators.
 * Tries to preserve semantic boundaries (paragraphs, sentences) when possible.
 */
export class RecursiveChunker implements DocumentChunker {
  readonly name = 'recursive';
  readonly priority = 100;

  /**
   * Split text into chunks.
   */
  async chunk(
    text: string,
    options?: Partial<ChunkerOptions>,
  ): Promise<Chunk[]> {
    const opts = { ...DEFAULT_CHUNKER_OPTIONS, ...options };

    // Validate options
    if (opts.chunkOverlap >= opts.maxChunkSize) {
      throw new Error(
        `chunkOverlap (${opts.chunkOverlap}) must be less than maxChunkSize (${opts.maxChunkSize})`,
      );
    }

    if (!text || text.trim().length === 0) {
      return [];
    }

    // Extract sections if tracking is enabled
    const sections = opts.trackSections ? this.extractSections(text) : [];

    // Recursively split the text
    const rawChunks = this.recursiveSplit(text, opts, SEPARATORS);

    // Build chunks with metadata
    const chunks: Chunk[] = [];
    let currentOffset = 0;

    for (let i = 0; i < rawChunks.length; i++) {
      // Yield to event loop periodically to prevent blocking
      if (i > 0 && i % YIELD_EVERY_N_CHUNKS === 0) {
        await yieldToEventLoop();
      }

      const chunkText = rawChunks[i];
      const startOffset = text.indexOf(chunkText, currentOffset);
      const endOffset = startOffset + chunkText.length;

      // Find which section this chunk belongs to
      const section = this.findSectionForOffset(sections, startOffset);

      const metadata: ChunkMetadata = {
        tokenCount: this.estimateTokenCount(chunkText),
      };

      if (section) {
        metadata.section = section;
      }

      // Check if chunk starts with a heading
      const heading = this.extractHeading(chunkText);
      if (heading) {
        metadata.heading = heading;
      }

      chunks.push({
        index: i,
        text: chunkText.trim(),
        startOffset,
        endOffset,
        metadata,
      });

      currentOffset = startOffset + 1;
    }

    return chunks;
  }

  /**
   * Recursively split text using separators.
   */
  private recursiveSplit(
    text: string,
    options: ChunkerOptions,
    separators: string[],
  ): string[] {
    const { maxChunkSize, chunkOverlap } = options;

    // Base case: text is small enough
    if (text.length <= maxChunkSize) {
      return [text];
    }

    // Find a separator that works
    let bestSeparator = '';
    let parts: string[] = [];

    for (const sep of separators) {
      if (sep === '') {
        // Last resort: split by character
        parts = this.splitBySize(text, maxChunkSize, chunkOverlap);
        bestSeparator = '';
        break;
      }

      const tempParts = text.split(sep);
      if (tempParts.length > 1) {
        // This separator splits the text
        parts = tempParts;
        bestSeparator = sep;
        break;
      }
    }

    if (parts.length === 0) {
      // Shouldn't happen, but handle edge case
      return [text];
    }

    // Merge small parts and recursively split large ones
    const chunks: string[] = [];
    let currentChunk = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      // Add separator back (except for last part)
      const partWithSep = i < parts.length - 1 ? part + bestSeparator : part;

      if (currentChunk.length + partWithSep.length <= maxChunkSize) {
        // Part fits in current chunk
        currentChunk += partWithSep;
      } else {
        // Part doesn't fit - save current chunk and start new one
        if (currentChunk.length > 0) {
          chunks.push(currentChunk);
        }

        if (partWithSep.length > maxChunkSize) {
          // Part is too large - recursively split it
          const subSeparators = separators.slice(
            separators.indexOf(bestSeparator) + 1,
          );
          const subChunks = this.recursiveSplit(
            partWithSep,
            options,
            subSeparators,
          );
          chunks.push(...subChunks);
          currentChunk = '';
        } else {
          currentChunk = partWithSep;
        }
      }
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    // Apply overlap if configured
    if (chunkOverlap > 0 && chunks.length > 1) {
      return this.applyOverlap(chunks, chunkOverlap);
    }

    return chunks;
  }

  /**
   * Split text by size (last resort).
   */
  private splitBySize(
    text: string,
    maxSize: number,
    overlap: number,
  ): string[] {
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + maxSize, text.length);
      chunks.push(text.slice(start, end));
      start = end - overlap;
      if (start <= chunks.length * maxSize - text.length) {
        // Prevent infinite loop
        break;
      }
    }

    return chunks;
  }

  /**
   * Apply overlap between chunks.
   */
  private applyOverlap(chunks: string[], overlap: number): string[] {
    if (chunks.length <= 1) return chunks;

    const result: string[] = [chunks[0]];

    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1];
      const currentChunk = chunks[i];

      // Take overlap from end of previous chunk
      const overlapText = prevChunk.slice(-Math.min(overlap, prevChunk.length));

      // Prepend overlap to current chunk
      result.push(overlapText + currentChunk);
    }

    return result;
  }

  /**
   * Extract section headings from text.
   */
  private extractSections(
    text: string,
  ): Array<{ title: string; offset: number }> {
    const sections: Array<{ title: string; offset: number }> = [];

    for (const pattern of HEADING_PATTERNS) {
      let match;
      const regex = new RegExp(pattern, 'gm');

      while ((match = regex.exec(text)) !== null) {
        const title = match[1]?.trim() || match[0].trim();
        sections.push({
          title,
          offset: match.index,
        });
      }
    }

    // Sort by offset
    return sections.sort((a, b) => a.offset - b.offset);
  }

  /**
   * Find which section a given offset belongs to.
   */
  private findSectionForOffset(
    sections: Array<{ title: string; offset: number }>,
    offset: number,
  ): string | undefined {
    let lastSection: string | undefined;

    for (const section of sections) {
      if (section.offset > offset) break;
      lastSection = section.title;
    }

    return lastSection;
  }

  /**
   * Extract heading from the start of a chunk.
   */
  private extractHeading(text: string): string | undefined {
    const firstLine = text.split('\n')[0].trim();

    for (const pattern of HEADING_PATTERNS) {
      const match = firstLine.match(pattern);
      if (match) {
        return match[1]?.trim() || firstLine;
      }
    }

    return undefined;
  }

  /**
   * Estimate token count (rough approximation).
   * Rule of thumb: ~4 characters per token for English text.
   */
  private estimateTokenCount(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new RecursiveChunker instance.
 */
export function createRecursiveChunker(): RecursiveChunker {
  return new RecursiveChunker();
}
