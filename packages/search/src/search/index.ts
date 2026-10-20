/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

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
  DiversityStrategy,
  DiversityOptions,
  AdditionalSource,
  SearchEngineConfig,
  NormalizedSearchParams,
  NormalizedDiversityOptions,
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
