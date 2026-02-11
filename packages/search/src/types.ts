/**
 * Core types for the Auditaria Search system.
 * These types are used across all components.
 */

// ============================================================================
// Document Types
// ============================================================================

export type DocumentStatus =
  | 'pending'
  | 'parsing'
  | 'chunking'
  | 'embedding'
  | 'indexed'
  | 'failed';

export type OcrStatus =
  | 'not_needed'
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface Document {
  id: string;
  filePath: string;
  fileName: string;
  fileExtension: string;
  fileSize: number;
  fileHash: string;
  mimeType: string | null;
  title: string | null;
  author: string | null;
  language: string | null;
  pageCount: number | null;
  status: DocumentStatus;
  ocrStatus: OcrStatus;
  indexedAt: Date | null;
  fileModifiedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
  tags: string[];
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  embedding: number[] | null;
  startOffset: number;
  endOffset: number;
  page: number | null;
  section: string | null;
  tokenCount: number | null;
  createdAt: Date;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchFilters {
  folders?: string[];
  fileTypes?: string[];
  tags?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  status?: DocumentStatus[];
  languages?: string[];
  minScore?: number;
}

export type MatchType = 'semantic' | 'keyword' | 'hybrid';

/**
 * Additional source information for deduplicated results.
 * When semantic deduplication merges similar passages, this tracks
 * all the files that contain the same/similar content.
 */
export interface AdditionalSource {
  filePath: string;
  fileName: string;
  documentId: string;
  score: number;
}

export interface SearchResult {
  documentId: string;
  chunkId: string;
  filePath: string;
  fileName: string;
  chunkText: string;
  score: number;
  matchType: MatchType;
  highlights: string[];
  metadata: {
    page: number | null;
    section: string | null;
    tags: string[];
  };
  /** Embedding vector for semantic deduplication (optional, only included when needed) */
  embedding?: number[];
  /** Additional files containing the same/similar passage (populated by semantic dedup) */
  additionalSources?: AdditionalSource[];
}

/**
 * Diversity strategy for search results.
 * - 'none': No diversity filtering, pure relevance ranking
 * - 'score_penalty': Apply decay factor to subsequent passages from same document
 * - 'cap_then_fill': Hard cap per document, then fill remaining slots progressively
 */
export type DiversityStrategy = 'none' | 'score_penalty' | 'cap_then_fill';

/**
 * Options for controlling result diversity.
 */
export interface DiversityOptions {
  /** Diversity strategy to apply (default: 'score_penalty') */
  strategy?: DiversityStrategy;
  /** Decay factor for score_penalty strategy (default: 0.85) */
  decayFactor?: number;
  /** Max passages per document for cap_then_fill strategy (default: 5) */
  maxPerDocument?: number;
  /** Enable semantic deduplication to merge similar passages (default: true) */
  semanticDedup?: boolean;
  /** Cosine similarity threshold for semantic dedup (default: 0.97) */
  semanticDedupThreshold?: number;
}

export interface SearchOptions {
  query: string;
  strategy: 'hybrid' | 'semantic' | 'keyword';
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
  weights?: {
    semantic: number;
    keyword: number;
  };
  highlight?: boolean;
  highlightTag?: string;
  /** Diversity options for result diversification */
  diversity?: DiversityOptions;
  /**
   * Use Google-style web search syntax for keyword queries (default: false).
   * When true, supports:
   *   - "quoted phrase" for exact phrase search
   *   - word1 word2 for AND search (both words, any order)
   *   - word1 OR word2 for OR search
   *   - -word for exclusion
   * When false (default), uses PostgreSQL plainto_tsquery which treats
   * all words as AND search.
   */
  useWebSearchSyntax?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  took: number;
  query: string;
  strategy: string;
  filters: SearchFilters;
}

// ============================================================================
// Queue Types
// ============================================================================

export type QueuePriority =
  | 'text'
  | 'markup'
  | 'pdf'
  | 'image'
  | 'ocr'
  | 'deferred';

export type QueueDeferReason =
  | 'raw_text_oversize'
  | 'raw_markup_oversize'
  | 'parsed_text_oversize'
  | 'unknown';

export type QueueItemStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface QueueItem {
  id: string;
  filePath: string;
  fileSize: number;
  priority: QueuePriority;
  status: QueueItemStatus;
  attempts: number;
  lastError: string | null;
  deferReason?: QueueDeferReason | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

// ============================================================================
// Sync Types
// ============================================================================

export interface SyncResult {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
  duration: number;
}

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  extension: string;
  size: number;
  modifiedAt: Date;
  hash: string;
}

// ============================================================================
// Stats Types
// ============================================================================

export interface SearchStats {
  totalDocuments: number;
  totalChunks: number;
  indexedDocuments: number;
  pendingDocuments: number;
  failedDocuments: number;
  ocrPending: number;
  totalTags: number;
  databaseSize: number;
}

export interface QueueStatus {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  byPriority: Record<QueuePriority, number>;
}

export type QueueStatusPrecision = 'exact' | 'approximate';

export interface QueueDetailedStatus extends QueueStatus {
  precision: QueueStatusPrecision;
  deferredByReason: Record<QueueDeferReason, number>;
}

// ============================================================================
// Tag Types
// ============================================================================

export interface TagCount {
  tag: string;
  count: number;
}

// ============================================================================
// Event Types
// ============================================================================

export interface SearchSystemEvents {
  'indexing:started': { documentId: string; filePath: string };
  'indexing:progress': {
    documentId: string;
    stage: string;
    progress: number;
  };
  'indexing:completed': { documentId: string; chunksCreated: number };
  'indexing:failed': { documentId: string; error: Error };
  'sync:started': undefined;
  'sync:detected': { added: string[]; modified: string[]; deleted: string[] };
  'sync:completed': SyncResult;
  'search:completed': {
    queryId: string;
    resultsCount: number;
    duration: number;
  };
  'queue:item:added': QueueItem;
  'queue:item:started': QueueItem;
  'queue:item:completed': QueueItem;
  'queue:item:failed': { item: QueueItem; error: Error };
}

export type SearchSystemEventName = keyof SearchSystemEvents;
