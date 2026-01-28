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
  DiversityStrategy,
} from '../types.js';
import type {
  SearchEngineConfig,
  NormalizedSearchParams,
  NormalizedDiversityOptions,
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

// Diversity defaults
const DEFAULT_DIVERSITY_STRATEGY: DiversityStrategy = 'score_penalty';
const DEFAULT_DIVERSITY_DECAY_FACTOR = 0.85;
const DEFAULT_DIVERSITY_MAX_PER_DOCUMENT = 5;
const DEFAULT_SEMANTIC_DEDUP = true;
const DEFAULT_SEMANTIC_DEDUP_THRESHOLD = 0.97;

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

      // Fetch more results to account for diversity filtering
      const diversityMultiplier = params.diversity.strategy !== 'none' ? 3 : 1;
      const fetchLimit = (params.limit + params.offset) * diversityMultiplier;
      const fetchParams = { ...params, limit: fetchLimit, offset: 0 };

      switch (params.strategy) {
        case 'keyword':
          results = await this.keywordSearch(queryId, fetchParams);
          break;
        case 'semantic':
          results = await this.semanticSearch(queryId, fetchParams);
          break;
        case 'hybrid':
        default:
          results = await this.hybridSearch(queryId, fetchParams);
      }

      // Apply minimum score filter
      if (params.filters.minScore !== undefined) {
        results = results.filter((r) => r.score >= params.filters.minScore!);
      }

      // Apply diversity strategy
      if (params.diversity.strategy !== 'none') {
        log.debug('search:applyDiversity', {
          queryId,
          strategy: params.diversity.strategy,
          beforeCount: results.length
        });

        results = this.applyDiversityStrategy(results, params.diversity);

        log.debug('search:diversityApplied', {
          queryId,
          afterCount: results.length
        });
      }

      // Apply semantic deduplication (merges similar passages)
      if (params.diversity.semanticDedup) {
        log.debug('search:applySemanticDedup', {
          queryId,
          threshold: params.diversity.semanticDedupThreshold,
          beforeCount: results.length
        });

        results = await this.applySemanticDedup(
          results,
          params.diversity.semanticDedupThreshold,
          queryId
        );

        log.debug('search:semanticDedupApplied', {
          queryId,
          afterCount: results.length
        });
      }

      // Apply offset
      if (params.offset > 0) {
        results = results.slice(params.offset);
      }

      // Apply limit
      results = results.slice(0, params.limit);

      // Apply highlighting
      // For keyword and hybrid searches, PostgreSQL's ts_headline() already provides
      // highlighting via the storage layer. Only use legacy highlighting for pure
      // semantic searches where FTS highlighting is not available.
      if (params.highlight && params.strategy === 'semantic') {
        results = this.addHighlightsLegacy(
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
    const diversity: NormalizedDiversityOptions = {
      strategy: options.diversity?.strategy ?? DEFAULT_DIVERSITY_STRATEGY,
      decayFactor: options.diversity?.decayFactor ?? DEFAULT_DIVERSITY_DECAY_FACTOR,
      maxPerDocument: options.diversity?.maxPerDocument ?? DEFAULT_DIVERSITY_MAX_PER_DOCUMENT,
      semanticDedup: options.diversity?.semanticDedup ?? DEFAULT_SEMANTIC_DEDUP,
      semanticDedupThreshold: options.diversity?.semanticDedupThreshold ?? DEFAULT_SEMANTIC_DEDUP_THRESHOLD,
    };

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
      diversity,
      useWebSearchSyntax: options.useWebSearchSyntax ?? false,
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
      { useWebSearchSyntax: params.useWebSearchSyntax },
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
      this.storage.searchKeyword(params.query, params.filters, fetchLimit, { useWebSearchSyntax: params.useWebSearchSyntax }),
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
   *
   * LEGACY: This method is kept for semantic-only searches where PostgreSQL's
   * ts_headline() cannot be used. For keyword and hybrid searches, highlighting
   * is now done natively by PostgreSQL using ts_headline() with <mark> tags.
   *
   * This method parses the query to extract quoted phrases and individual terms,
   * then highlights them in the text using regex replacement.
   */
  private addHighlightsLegacy(
    results: SearchResult[],
    query: string,
    tag: string,
  ): SearchResult[] {
    // Parse query to extract quoted phrases and individual terms
    const { phrases, terms } = this.parseQueryForHighlighting(query);

    // Combine phrases and terms for highlighting
    // Phrases should be matched first (longer matches take priority)
    const highlightPatterns = [
      ...phrases.map((p) => this.escapeRegex(p)),
      ...terms.map((t) => this.escapeRegex(t)),
    ].filter((p) => p.length > 0);

    if (highlightPatterns.length === 0) {
      return results;
    }

    // Create regex for highlighting - phrases first (longer), then individual terms
    // Sort by length descending so longer matches are tried first
    highlightPatterns.sort((a, b) => b.length - a.length);
    const pattern = new RegExp(
      `(${highlightPatterns.join('|')})`,
      'gi',
    );

    // For snippet extraction, use phrases first, then terms
    const snippetTerms = [...phrases, ...terms];

    return results.map((result) => {
      const highlightedText = result.chunkText.replace(
        pattern,
        `<${tag}>$1</${tag}>`,
      );

      // Extract snippets around matches
      const highlights = this.extractSnippets(
        result.chunkText,
        snippetTerms,
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
   * Parse a search query to extract quoted phrases and individual terms.
   * Handles Google-style syntax: "exact phrase" word1 word2
   */
  private parseQueryForHighlighting(query: string): {
    phrases: string[];
    terms: string[];
  } {
    const phrases: string[] = [];
    const terms: string[] = [];

    // Extract quoted phrases first
    const phraseRegex = /"([^"]+)"/g;
    let match;
    let remainingQuery = query;

    while ((match = phraseRegex.exec(query)) !== null) {
      const phrase = match[1].trim();
      if (phrase.length > 0) {
        phrases.push(phrase);
      }
      // Remove the matched phrase from remaining query
      remainingQuery = remainingQuery.replace(match[0], ' ');
    }

    // Extract individual terms from remaining query
    // Filter out short words (length > 2) and operators (OR, -)
    const words = remainingQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2 && t !== 'or' && !t.startsWith('-'));

    terms.push(...words);

    return { phrases, terms };
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

  // -------------------------------------------------------------------------
  // Diversity Processing Methods
  // -------------------------------------------------------------------------

  /**
   * Apply diversity strategy to reorder/filter results.
   * - score_penalty: Apply decay factor to subsequent passages from same document
   * - cap_then_fill: Hard cap per document, then fill remaining slots progressively
   */
  private applyDiversityStrategy(
    results: SearchResult[],
    diversity: NormalizedDiversityOptions
  ): SearchResult[] {
    if (diversity.strategy === 'score_penalty') {
      return this.applyScorePenalty(results, diversity.decayFactor);
    } else if (diversity.strategy === 'cap_then_fill') {
      return this.applyCapThenFill(results, diversity.maxPerDocument);
    }
    return results;
  }

  /**
   * Apply score penalty to subsequent passages from the same document.
   * First passage from each doc keeps original score, subsequent passages
   * have their scores multiplied by decay^(rank-1).
   */
  private applyScorePenalty(
    results: SearchResult[],
    decayFactor: number
  ): SearchResult[] {
    // Track rank within each document
    const docRanks = new Map<string, number>();

    // Apply penalty and create new results with adjusted scores
    const penalizedResults = results.map((result) => {
      const docRank = (docRanks.get(result.documentId) ?? 0) + 1;
      docRanks.set(result.documentId, docRank);

      // Apply decay: score * decay^(rank-1)
      // rank 1 -> decay^0 = 1.0 (no penalty)
      // rank 2 -> decay^1 = 0.85
      // rank 3 -> decay^2 = 0.7225
      const adjustedScore = result.score * Math.pow(decayFactor, docRank - 1);

      return {
        ...result,
        score: adjustedScore,
      };
    });

    // Re-sort by adjusted score
    penalizedResults.sort((a, b) => b.score - a.score);

    return penalizedResults;
  }

  /**
   * Apply cap-then-fill strategy: limit passages per document,
   * then progressively fill remaining slots.
   *
   * Round 1: 1 passage per document
   * Round 2: 2nd passage per document
   * Round N: Nth passage per document (up to maxPerDocument)
   * Round N+1: All remaining passages
   */
  private applyCapThenFill(
    results: SearchResult[],
    maxPerDocument: number
  ): SearchResult[] {
    // Group results by document, maintaining original score order within groups
    const byDocument = new Map<string, SearchResult[]>();
    for (const result of results) {
      const docResults = byDocument.get(result.documentId) || [];
      docResults.push(result);
      byDocument.set(result.documentId, docResults);
    }

    // Each group is already in score order from the original search

    const output: SearchResult[] = [];
    const maxRound = Math.max(maxPerDocument,
      Math.max(...Array.from(byDocument.values()).map(arr => arr.length)));

    // Fill in rounds
    for (let round = 0; round < maxRound; round++) {
      // Collect all passages at this round from each document
      const roundResults: SearchResult[] = [];

      for (const docResults of byDocument.values()) {
        if (round < docResults.length) {
          roundResults.push(docResults[round]);
        }
      }

      // Sort this round by score (best first)
      roundResults.sort((a, b) => b.score - a.score);

      // Add to output
      output.push(...roundResults);
    }

    return output;
  }

  /**
   * Apply semantic deduplication to merge near-duplicate passages.
   * Instead of discarding duplicates, this merges file paths into additionalSources.
   *
   * @param results - Search results to deduplicate
   * @param threshold - Cosine similarity threshold (default: 0.97)
   * @param queryId - Query ID for logging
   */
  private async applySemanticDedup(
    results: SearchResult[],
    threshold: number,
    queryId: string
  ): Promise<SearchResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Fetch embeddings for all chunks
    const chunkIds = results.map(r => r.chunkId);
    const embeddings = await this.fetchChunkEmbeddings(chunkIds);

    if (embeddings.size === 0) {
      log.debug('search:semanticDedup:noEmbeddings', { queryId });
      return results;
    }

    const merged: SearchResult[] = [];

    for (const candidate of results) {
      const candidateEmbedding = embeddings.get(candidate.chunkId);

      if (!candidateEmbedding) {
        // No embedding available, keep as-is
        merged.push(candidate);
        continue;
      }

      // Find if a similar passage already exists in merged results
      let foundSimilar = false;

      for (const existing of merged) {
        const existingEmbedding = embeddings.get(existing.chunkId);
        if (!existingEmbedding) continue;

        const similarity = this.cosineSimilarity(candidateEmbedding, existingEmbedding);

        if (similarity >= threshold) {
          // Merge: add candidate's file info to existing result's additionalSources
          if (!existing.additionalSources) {
            existing.additionalSources = [];
          }

          // Only add if it's from a different file
          if (existing.filePath !== candidate.filePath) {
            existing.additionalSources.push({
              filePath: candidate.filePath,
              fileName: candidate.fileName,
              documentId: candidate.documentId,
              score: candidate.score,
            });
          }

          foundSimilar = true;
          break;
        }
      }

      if (!foundSimilar) {
        // New unique passage
        merged.push({ ...candidate });
      }
    }

    log.debug('search:semanticDedup:complete', {
      queryId,
      originalCount: results.length,
      mergedCount: merged.length,
      duplicatesFound: results.length - merged.length
    });

    return merged;
  }

  /**
   * Fetch embeddings for a list of chunk IDs.
   * Returns a map of chunkId -> embedding vector.
   */
  private async fetchChunkEmbeddings(
    chunkIds: string[]
  ): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();

    if (chunkIds.length === 0) {
      return embeddings;
    }

    try {
      // Query the database for embeddings
      const placeholders = chunkIds.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `
        SELECT id, embedding
        FROM chunks
        WHERE id IN (${placeholders})
          AND embedding IS NOT NULL
      `;

      const rows = await this.storage.query<{ id: string; embedding: string }>(
        sql,
        chunkIds
      );

      for (const row of rows) {
        if (row.embedding) {
          // Parse the embedding vector from string format
          const embedding = this.parseEmbeddingVector(row.embedding);
          if (embedding) {
            embeddings.set(row.id, embedding);
          }
        }
      }
    } catch (error) {
      log.warn('fetchChunkEmbeddings:error', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return embeddings;
  }

  /**
   * Parse embedding vector from database format.
   * PGlite stores vectors as '[0.1, 0.2, ...]' string format.
   */
  private parseEmbeddingVector(vectorStr: string): number[] | null {
    try {
      // Handle array format
      if (Array.isArray(vectorStr)) {
        return vectorStr as unknown as number[];
      }

      // Handle string format '[0.1, 0.2, ...]'
      if (typeof vectorStr === 'string') {
        const cleaned = vectorStr.replace(/^\[|\]$/g, '');
        return cleaned.split(',').map(v => parseFloat(v.trim()));
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Compute cosine similarity between two vectors.
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) {
      return 0;
    }

    return dotProduct / magnitude;
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
