/**
 * Search module.
 * Provides search engine and related utilities.
 */

// Types
export type {
  SearchFilters,
  SearchResult,
  SearchOptions,
  SearchResponse,
  MatchType,
  SearchEngineConfig,
  NormalizedSearchParams,
  SearchEngineEvents,
} from './types.js';

// Search Engine
export { SearchEngine, createSearchEngine } from './SearchEngine.js';

// Filter Builder
export {
  FilterBuilder,
  createFilterBuilder,
  type FilterBuildResult,
} from './FilterBuilder.js';
