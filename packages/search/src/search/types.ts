/**
 * Types for the search engine.
 * Re-exports core types and adds search-specific types.
 */

// Import types for local use
import type { SearchFilters as _SearchFilters } from '../types.js';

// Re-export core search types
export type {
  SearchFilters,
  SearchResult,
  SearchOptions,
  SearchResponse,
  MatchType,
  DiversityStrategy,
  DiversityOptions,
  AdditionalSource,
} from '../types.js';

// Local alias for use in this file
type SearchFilters = _SearchFilters;

// ============================================================================
// Search Engine Configuration
// ============================================================================

/**
 * Configuration for the SearchEngine.
 */
export interface SearchEngineConfig {
  /** Default number of results to return */
  defaultLimit?: number;
  /** Default search strategy */
  defaultStrategy?: 'hybrid' | 'semantic' | 'keyword';
  /** Default semantic weight for hybrid search (0-1) */
  semanticWeight?: number;
  /** Default keyword weight for hybrid search (0-1) */
  keywordWeight?: number;
  /** RRF constant k (higher = more weight to lower-ranked results) */
  rrfK?: number;
  /** Maximum snippet length for highlights */
  maxSnippetLength?: number;
  /** HTML tag for highlighting matches */
  highlightTag?: string;
}

/**
 * Normalized diversity options after applying defaults.
 */
export interface NormalizedDiversityOptions {
  strategy: 'none' | 'score_penalty' | 'cap_then_fill';
  decayFactor: number;
  maxPerDocument: number;
  semanticDedup: boolean;
  semanticDedupThreshold: number;
}

/**
 * Internal search parameters after normalization.
 */
export interface NormalizedSearchParams {
  query: string;
  strategy: 'hybrid' | 'semantic' | 'keyword';
  filters: SearchFilters;
  limit: number;
  offset: number;
  semanticWeight: number;
  keywordWeight: number;
  rrfK: number;
  highlight: boolean;
  highlightTag: string;
  diversity: NormalizedDiversityOptions;
  /** Use Google-style web search syntax (default: false) */
  useWebSearchSyntax: boolean;
}

// ============================================================================
// Search Engine Events
// ============================================================================

/**
 * Events emitted by the SearchEngine.
 */
export interface SearchEngineEvents {
  [key: string]: unknown;
  'search:started': {
    queryId: string;
    query: string;
    strategy: string;
  };
  'search:embedding': {
    queryId: string;
    query: string;
  };
  'search:semantic': {
    queryId: string;
    resultCount: number;
    duration: number;
  };
  'search:keyword': {
    queryId: string;
    resultCount: number;
    duration: number;
  };
  'search:fusion': {
    queryId: string;
    semanticCount: number;
    keywordCount: number;
    fusedCount: number;
  };
  'search:completed': {
    queryId: string;
    resultCount: number;
    duration: number;
    strategy: string;
  };
  'search:error': {
    queryId: string;
    error: Error;
  };
}
