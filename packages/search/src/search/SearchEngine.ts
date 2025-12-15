/**
 * Search engine for the Auditaria search system.
 * Supports keyword, semantic, and hybrid search strategies.
 */

import type { StorageAdapter } from '../storage/types.js';
import type { TextEmbedder } from '../embedders/types.js';
import type {
  SearchFilters,
  SearchResult,
  SearchOptions,
  SearchResponse,
} from '../types.js';
import type {
  SearchEngineConfig,
  NormalizedSearchParams,
  SearchEngineEvents,
} from './types.js';
import { EventEmitter } from '../core/EventEmitter.js';
import { createModuleLogger } from '../core/Logger.js';

const log = createModuleLogger('SearchEngine');

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 10;
const DEFAULT_STRATEGY = 'hybrid';
const DEFAULT_SEMANTIC_WEIGHT = 0.5;
const DEFAULT_KEYWORD_WEIGHT = 0.5;
const DEFAULT_RRF_K = 60;
const DEFAULT_MAX_SNIPPET_LENGTH = 300;
const DEFAULT_HIGHLIGHT_TAG = 'mark';

// ============================================================================
// SearchEngine
// ============================================================================

/**
 * Main search engine for performing document searches.
 * Supports keyword, semantic, and hybrid search strategies.
 */
export class SearchEngine extends EventEmitter<SearchEngineEvents> {
  private readonly storage: StorageAdapter;
  private readonly embedder: TextEmbedder;
  private readonly config: Required<SearchEngineConfig>;
  private queryCounter = 0;

  constructor(
    storage: StorageAdapter,
    embedder: TextEmbedder,
    config?: SearchEngineConfig,
  ) {
    super();
    this.storage = storage;
    this.embedder = embedder;
    this.config = {
      defaultLimit: config?.defaultLimit ?? DEFAULT_LIMIT,
      defaultStrategy: config?.defaultStrategy ?? DEFAULT_STRATEGY,
      semanticWeight: config?.semanticWeight ?? DEFAULT_SEMANTIC_WEIGHT,
      keywordWeight: config?.keywordWeight ?? DEFAULT_KEYWORD_WEIGHT,
      rrfK: config?.rrfK ?? DEFAULT_RRF_K,
      maxSnippetLength: config?.maxSnippetLength ?? DEFAULT_MAX_SNIPPET_LENGTH,
      highlightTag: config?.highlightTag ?? DEFAULT_HIGHLIGHT_TAG,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Perform a search with the specified options.
   */
  async search(options: SearchOptions): Promise<SearchResponse> {
    const startTime = Date.now();
    const queryId = this.generateQueryId();
    const timerKey = `search-${queryId}`;

    log.startTimer(timerKey, true);
    log.debug('search:start', { queryId, strategy: options.strategy, queryLength: options.query.length });
    log.logMemory('search:memoryBefore');

    const params = this.normalizeParams(options);

    void this.emit('search:started', {
      queryId,
      query: params.query,
      strategy: params.strategy,
    });

    try {
      let results: SearchResult[];

      switch (params.strategy) {
        case 'keyword':
          results = await this.keywordSearch(queryId, params);
          break;
        case 'semantic':
          results = await this.semanticSearch(queryId, params);
          break;
        case 'hybrid':
        default:
          results = await this.hybridSearch(queryId, params);
      }

      // Apply minimum score filter
      if (params.filters.minScore !== undefined) {
        results = results.filter((r) => r.score >= params.filters.minScore!);
      }

      // Apply offset
      if (params.offset > 0) {
        results = results.slice(params.offset);
      }

      // Apply limit
      results = results.slice(0, params.limit);

      // Apply highlighting
      if (params.highlight) {
        results = this.addHighlights(
          results,
          params.query,
          params.highlightTag,
        );
      }

      const duration = Date.now() - startTime;

      void this.emit('search:completed', {
        queryId,
        resultCount: results.length,
        duration,
        strategy: params.strategy,
      });

      log.endTimer(timerKey, 'search:complete', { queryId, resultCount: results.length, strategy: params.strategy });
      log.logMemory('search:memoryAfter');

      return {
        results,
        total: results.length,
        took: duration,
        query: params.query,
        strategy: params.strategy,
        filters: params.filters,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      void this.emit('search:error', { queryId, error: err });
      log.endTimer(timerKey, 'search:error', { queryId, error: err.message });
      throw err;
    }
  }

  /**
   * Perform a keyword-only search.
   */
  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    return this.storage.searchKeyword(
      query,
      filters,
      limit ?? this.config.defaultLimit,
    );
  }

  /**
   * Perform a semantic-only search.
   */
  async searchSemantic(
    query: string,
    filters?: SearchFilters,
    limit?: number,
  ): Promise<SearchResult[]> {
    // Ensure embedder is ready
    if (!this.embedder.isReady()) {
      await this.embedder.initialize();
    }

    // Generate query embedding
    const queryEmbedding = await this.embedder.embedQuery(query);

    return this.storage.searchSemantic(
      queryEmbedding,
      filters,
      limit ?? this.config.defaultLimit,
    );
  }

  /**
   * Perform a hybrid search combining keyword and semantic.
   */
  async searchHybrid(
    query: string,
    filters?: SearchFilters,
    limit?: number,
    weights?: { semantic: number; keyword: number },
  ): Promise<SearchResult[]> {
    // Ensure embedder is ready
    if (!this.embedder.isReady()) {
      await this.embedder.initialize();
    }

    // Generate query embedding
    const queryEmbedding = await this.embedder.embedQuery(query);

    return this.storage.searchHybrid(
      query,
      queryEmbedding,
      filters,
      limit ?? this.config.defaultLimit,
      weights ?? {
        semantic: this.config.semanticWeight,
        keyword: this.config.keywordWeight,
      },
      this.config.rrfK,
    );
  }

  /**
   * Get search suggestions based on indexed content.
   */
  async getSuggestions(prefix: string, limit = 5): Promise<string[]> {
    // Simple implementation: search for documents matching prefix
    const results = await this.storage.searchKeyword(prefix, undefined, limit);

    // Extract unique terms from results
    const terms = new Set<string>();
    for (const result of results) {
      const words = result.chunkText
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.startsWith(prefix.toLowerCase()));

      for (const word of words) {
        terms.add(word);
        if (terms.size >= limit) break;
      }
      if (terms.size >= limit) break;
    }

    return Array.from(terms);
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Normalize search parameters with defaults.
   */
  private normalizeParams(options: SearchOptions): NormalizedSearchParams {
    return {
      query: options.query.trim(),
      strategy: options.strategy ?? this.config.defaultStrategy,
      filters: options.filters ?? {},
      limit: options.limit ?? this.config.defaultLimit,
      offset: options.offset ?? 0,
      semanticWeight: options.weights?.semantic ?? this.config.semanticWeight,
      keywordWeight: options.weights?.keyword ?? this.config.keywordWeight,
      rrfK: this.config.rrfK,
      highlight: options.highlight ?? false,
      highlightTag: options.highlightTag ?? this.config.highlightTag,
    };
  }

  /**
   * Perform keyword search with event emission.
   */
  private async keywordSearch(
    queryId: string,
    params: NormalizedSearchParams,
  ): Promise<SearchResult[]> {
    const startTime = Date.now();

    const results = await this.storage.searchKeyword(
      params.query,
      params.filters,
      params.limit + params.offset,
    );

    void this.emit('search:keyword', {
      queryId,
      resultCount: results.length,
      duration: Date.now() - startTime,
    });

    return results;
  }

  /**
   * Perform semantic search with event emission.
   */
  private async semanticSearch(
    queryId: string,
    params: NormalizedSearchParams,
  ): Promise<SearchResult[]> {
    // Ensure embedder is ready
    if (!this.embedder.isReady()) {
      await this.embedder.initialize();
    }

    void this.emit('search:embedding', { queryId, query: params.query });

    // Generate query embedding
    const queryEmbedding = await this.embedder.embedQuery(params.query);

    const startTime = Date.now();

    const results = await this.storage.searchSemantic(
      queryEmbedding,
      params.filters,
      params.limit + params.offset,
    );

    void this.emit('search:semantic', {
      queryId,
      resultCount: results.length,
      duration: Date.now() - startTime,
    });

    return results;
  }

  /**
   * Perform hybrid search with RRF fusion.
   */
  private async hybridSearch(
    queryId: string,
    params: NormalizedSearchParams,
  ): Promise<SearchResult[]> {
    const timerKey = `hybridSearch-${queryId}`;
    log.startTimer(timerKey, true);
    log.debug('hybridSearch:start', { queryId });

    // Ensure embedder is ready
    if (!this.embedder.isReady()) {
      await this.embedder.initialize();
    }

    void this.emit('search:embedding', { queryId, query: params.query });

    // Generate query embedding
    log.debug('hybridSearch:embeddingStart', { queryId });
    const queryEmbedding = await this.embedder.embedQuery(params.query);
    log.debug('hybridSearch:embeddingComplete', { queryId, embeddingDim: queryEmbedding.length });

    // Run both searches in parallel
    const fetchLimit = (params.limit + params.offset) * 2; // Fetch more for fusion

    log.debug('hybridSearch:parallelSearchStart', { queryId, fetchLimit });
    const [semanticResults, keywordResults] = await Promise.all([
      this.storage.searchSemantic(queryEmbedding, params.filters, fetchLimit),
      this.storage.searchKeyword(params.query, params.filters, fetchLimit),
    ]);
    log.debug('hybridSearch:parallelSearchComplete', {
      queryId,
      semanticCount: semanticResults.length,
      keywordCount: keywordResults.length
    });

    void this.emit('search:semantic', {
      queryId,
      resultCount: semanticResults.length,
      duration: 0, // Already complete
    });

    void this.emit('search:keyword', {
      queryId,
      resultCount: keywordResults.length,
      duration: 0, // Already complete
    });

    // Apply RRF fusion
    log.debug('hybridSearch:fusionStart', { queryId });
    const fusedResults = this.rrfFusion(
      semanticResults,
      keywordResults,
      params.semanticWeight,
      params.keywordWeight,
      params.rrfK,
      queryId,
    );
    log.debug('hybridSearch:fusionComplete', { queryId, fusedCount: fusedResults.length });

    void this.emit('search:fusion', {
      queryId,
      semanticCount: semanticResults.length,
      keywordCount: keywordResults.length,
      fusedCount: fusedResults.length,
    });

    log.endTimer(timerKey, 'hybridSearch:complete', { queryId, fusedCount: fusedResults.length });
    return fusedResults;
  }

  /**
   * Apply Reciprocal Rank Fusion to combine results.
   */
  private rrfFusion(
    semanticResults: SearchResult[],
    keywordResults: SearchResult[],
    semanticWeight: number,
    keywordWeight: number,
    k: number,
    queryId: string,
  ): SearchResult[] {
    log.debug('rrfFusion:start', {
      queryId,
      semanticCount: semanticResults.length,
      keywordCount: keywordResults.length
    });

    // Build rank maps
    const semanticRanks = new Map<string, number>();
    semanticResults.forEach((result, index) => {
      semanticRanks.set(result.chunkId, index + 1);
    });
    log.debug('rrfFusion:semanticRanksBuilt', { queryId, mapSize: semanticRanks.size });

    const keywordRanks = new Map<string, number>();
    keywordResults.forEach((result, index) => {
      keywordRanks.set(result.chunkId, index + 1);
    });
    log.debug('rrfFusion:keywordRanksBuilt', { queryId, mapSize: keywordRanks.size });

    // Collect all unique chunks
    const allChunks = new Map<string, SearchResult>();
    for (const result of semanticResults) {
      allChunks.set(result.chunkId, result);
    }
    for (const result of keywordResults) {
      if (!allChunks.has(result.chunkId)) {
        allChunks.set(result.chunkId, result);
      }
    }
    log.debug('rrfFusion:allChunksCollected', { queryId, uniqueChunks: allChunks.size });

    // Calculate RRF scores
    const scoredResults: Array<{ result: SearchResult; rrfScore: number }> = [];

    for (const [chunkId, result] of allChunks) {
      const semanticRank = semanticRanks.get(chunkId);
      const keywordRank = keywordRanks.get(chunkId);

      let rrfScore = 0;

      if (semanticRank !== undefined) {
        rrfScore += semanticWeight / (k + semanticRank);
      }

      if (keywordRank !== undefined) {
        rrfScore += keywordWeight / (k + keywordRank);
      }

      // Determine match type
      let matchType: 'semantic' | 'keyword' | 'hybrid';
      if (semanticRank !== undefined && keywordRank !== undefined) {
        matchType = 'hybrid';
      } else if (semanticRank !== undefined) {
        matchType = 'semantic';
      } else {
        matchType = 'keyword';
      }

      scoredResults.push({
        result: {
          ...result,
          score: rrfScore,
          matchType,
        },
        rrfScore,
      });
    }

    // Sort by RRF score
    scoredResults.sort((a, b) => b.rrfScore - a.rrfScore);

    log.debug('rrfFusion:complete', { queryId, scoredResultsCount: scoredResults.length });

    return scoredResults.map((sr) => sr.result);
  }

  /**
   * Add highlight markers to search results.
   */
  private addHighlights(
    results: SearchResult[],
    query: string,
    tag: string,
  ): SearchResult[] {
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (queryTerms.length === 0) {
      return results;
    }

    // Create regex for highlighting
    const pattern = new RegExp(
      `(${queryTerms.map((t) => this.escapeRegex(t)).join('|')})`,
      'gi',
    );

    return results.map((result) => {
      const highlightedText = result.chunkText.replace(
        pattern,
        `<${tag}>$1</${tag}>`,
      );

      // Extract snippets around matches
      const highlights = this.extractSnippets(
        result.chunkText,
        queryTerms,
        this.config.maxSnippetLength,
      );

      return {
        ...result,
        chunkText: highlightedText,
        highlights,
      };
    });
  }

  /**
   * Extract snippets around query matches.
   */
  private extractSnippets(
    text: string,
    queryTerms: string[],
    maxLength: number,
  ): string[] {
    const snippets: string[] = [];
    const seen = new Set<number>();

    for (const term of queryTerms) {
      const regex = new RegExp(this.escapeRegex(term), 'gi');
      let match;

      while ((match = regex.exec(text)) !== null) {
        const start = match.index;

        // Skip if we've already created a snippet near this location
        const nearExisting = Array.from(seen).some(
          (pos) => Math.abs(pos - start) < maxLength / 2,
        );
        if (nearExisting) continue;

        seen.add(start);

        // Extract snippet around match
        const snippetStart = Math.max(0, start - Math.floor(maxLength / 3));
        const snippetEnd = Math.min(
          text.length,
          start + Math.floor((maxLength * 2) / 3),
        );

        let snippet = text.slice(snippetStart, snippetEnd);

        // Add ellipsis if truncated
        if (snippetStart > 0) {
          snippet = '...' + snippet.trimStart();
        }
        if (snippetEnd < text.length) {
          snippet = snippet.trimEnd() + '...';
        }

        snippets.push(snippet);

        if (snippets.length >= 3) break;
      }

      if (snippets.length >= 3) break;
    }

    return snippets;
  }

  /**
   * Escape special regex characters.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Generate a unique query ID.
   */
  private generateQueryId(): string {
    return `q_${++this.queryCounter}_${Date.now()}`;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new SearchEngine instance.
 */
export function createSearchEngine(
  storage: StorageAdapter,
  embedder: TextEmbedder,
  config?: SearchEngineConfig,
): SearchEngine {
  return new SearchEngine(storage, embedder, config);
}
