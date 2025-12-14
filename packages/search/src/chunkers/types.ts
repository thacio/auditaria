/**
 * Types for text chunkers.
 * Chunkers split documents into smaller pieces for embedding and search.
 */

// ============================================================================
// Chunk Types
// ============================================================================

export interface Chunk {
  /** Chunk index within the document (0-based) */
  index: number;
  /** The text content of this chunk */
  text: string;
  /** Start offset in the original document */
  startOffset: number;
  /** End offset in the original document */
  endOffset: number;
  /** Metadata about the chunk */
  metadata: ChunkMetadata;
}

export interface ChunkMetadata {
  /** Page number if applicable */
  page?: number;
  /** Section/heading the chunk belongs to */
  section?: string;
  /** Heading text if chunk starts with a heading */
  heading?: string;
  /** Approximate token count */
  tokenCount?: number;
}

// ============================================================================
// Chunker Interface
// ============================================================================

export interface ChunkerOptions {
  /** Maximum chunk size in characters */
  maxChunkSize: number;
  /** Overlap between consecutive chunks in characters */
  chunkOverlap: number;
  /** Try to preserve sentence boundaries */
  preserveSentences?: boolean;
  /** Try to preserve paragraph boundaries */
  preserveParagraphs?: boolean;
  /** Extract and track section headings */
  trackSections?: boolean;
}

export interface DocumentChunker {
  /** Unique name for this chunker */
  readonly name: string;
  /** Priority (higher = preferred) */
  readonly priority: number;

  /**
   * Split text into chunks.
   *
   * @param text - The text to chunk
   * @param options - Chunking options
   * @returns Array of chunks
   */
  chunk(text: string, options?: Partial<ChunkerOptions>): Promise<Chunk[]>;
}

// ============================================================================
// Chunker Registry Types
// ============================================================================

export interface ChunkerRegistryOptions {
  /** Default chunking options */
  defaultOptions?: Partial<ChunkerOptions>;
}

// ============================================================================
// Default Options
// ============================================================================

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = {
  maxChunkSize: 1000,
  chunkOverlap: 200,
  preserveSentences: true,
  preserveParagraphs: true,
  trackSections: true,
};
