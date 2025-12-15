/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_LOCAL_SEARCH - Search Response Formatter

/**
 * Output format for search results
 */
export type OutputFormat = 'markdown' | 'json';

/**
 * Detail level for search results
 */
export type DetailLevel = 'minimal' | 'summary' | 'full';

/**
 * Options for the search response formatter
 */
export interface FormatterOptions {
  /** Output format: 'markdown' or 'json' */
  format: OutputFormat;
  /** Detail level: 'minimal', 'summary', or 'full' */
  detail: DetailLevel;
  /** Max characters per passage (only for summary detail) */
  passageLength: number;
  /** Group results by document */
  groupByDocument: boolean;
  /** Max passages per document when grouped */
  passagesPerDocument: number;
}

/**
 * Default formatter options
 */
export const DEFAULT_FORMATTER_OPTIONS: FormatterOptions = {
  format: 'markdown',
  detail: 'summary',
  passageLength: 300,
  groupByDocument: true,
  passagesPerDocument: 0, // 0 = no limit, show all passages per document
};

/**
 * Search result from the search engine
 */
export interface SearchResultInput {
  documentId: string;
  chunkId: string;
  filePath: string;
  fileName: string;
  chunkText: string;
  score: number;
  matchType: 'semantic' | 'keyword' | 'hybrid';
  highlights: string[];
  metadata: {
    page: number | null;
    section: string | null;
    tags: string[];
  };
}

/**
 * Pagination metadata for search results
 */
export interface PaginationMeta {
  query: string;
  strategy: string;
  took_ms: number;
  total_hits: number;
  returned_hits: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

/**
 * Passage within a grouped document
 */
export interface PassageOutput {
  chunk_id: string;
  score: number;
  text: string;
  highlights: string[];
  section?: string;
}

/**
 * Grouped document result (when group_by_document is true)
 */
export interface GroupedDocumentOutput {
  document_id: string;
  file_path: string;
  file_name: string;
  best_score: number;
  match_count: number;
  passages: PassageOutput[];
}

/**
 * Flat result output (when group_by_document is false)
 */
export interface FlatResultOutput {
  document_id: string;
  chunk_id: string;
  file_path: string;
  file_name: string;
  score: number;
  match_type: 'semantic' | 'keyword' | 'hybrid';
  text?: string;
  highlights?: string[];
  section?: string;
  tags?: string[];
}

/**
 * JSON output structure
 */
export interface JsonSearchOutput {
  meta: PaginationMeta;
  results: FlatResultOutput[] | GroupedDocumentOutput[];
  grouped: boolean;
}

/**
 * Formatted search response
 */
export interface FormattedSearchResponse {
  /** Content for LLM consumption */
  llmContent: string;
  /** Short display for user */
  returnDisplay: string;
}

// ============================================================================
// SearchResponseFormatter
// ============================================================================

/**
 * Formats search results for AI consumption.
 * Supports markdown and JSON output formats with configurable detail levels.
 */
export class SearchResponseFormatter {
  private options: FormatterOptions;

  constructor(options: Partial<FormatterOptions> = {}) {
    this.options = { ...DEFAULT_FORMATTER_OPTIONS, ...options };
  }

  /**
   * Format search results according to configured options
   */
  format(
    results: SearchResultInput[],
    query: string,
    took: number,
    pagination: { offset: number; limit: number; totalAvailable?: number },
  ): FormattedSearchResponse {
    const meta = this.buildPaginationMeta(results, query, took, pagination);

    if (results.length === 0) {
      return this.formatEmptyResults(query, meta);
    }

    // Group results if requested
    const processedResults = this.options.groupByDocument
      ? this.groupResultsByDocument(results)
      : this.flattenResults(results);

    // Format based on output format
    if (this.options.format === 'json') {
      return this.formatAsJson(processedResults, meta);
    } else {
      return this.formatAsMarkdown(processedResults, meta);
    }
  }

  /**
   * Update formatter options
   */
  setOptions(options: Partial<FormatterOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options
   */
  getOptions(): FormatterOptions {
    return { ...this.options };
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  private buildPaginationMeta(
    results: SearchResultInput[],
    query: string,
    took: number,
    pagination: { offset: number; limit: number; totalAvailable?: number },
  ): PaginationMeta {
    const totalHits = pagination.totalAvailable ?? results.length;
    const returnedHits = results.length;

    return {
      query,
      strategy: this.inferStrategy(results),
      took_ms: took,
      total_hits: totalHits,
      returned_hits: returnedHits,
      offset: pagination.offset,
      limit: pagination.limit,
      has_more: pagination.offset + returnedHits < totalHits,
    };
  }

  private inferStrategy(results: SearchResultInput[]): string {
    if (results.length === 0) return 'hybrid';

    const types = new Set(results.map((r) => r.matchType));
    if (
      types.has('hybrid') ||
      (types.has('semantic') && types.has('keyword'))
    ) {
      return 'hybrid';
    }
    if (types.has('semantic')) return 'semantic';
    if (types.has('keyword')) return 'keyword';
    return 'hybrid';
  }

  private formatEmptyResults(
    query: string,
    meta: PaginationMeta,
  ): FormattedSearchResponse {
    if (this.options.format === 'json') {
      const output: JsonSearchOutput = {
        meta,
        results: [],
        grouped: this.options.groupByDocument,
      };
      return {
        llmContent: JSON.stringify(output, null, 2),
        returnDisplay: `No results found for "${query}"`,
      };
    }

    return {
      llmContent: `No results found for query: "${query}"`,
      returnDisplay: `No results found for "${query}"`,
    };
  }

  // -------------------------------------------------------------------------
  // Document Grouping
  // -------------------------------------------------------------------------

  private groupResultsByDocument(
    results: SearchResultInput[],
  ): GroupedDocumentOutput[] {
    // Group by document ID
    const groups = new Map<string, SearchResultInput[]>();

    for (const result of results) {
      const existing = groups.get(result.documentId) ?? [];
      existing.push(result);
      groups.set(result.documentId, existing);
    }

    // Convert to grouped output
    const grouped: GroupedDocumentOutput[] = [];

    for (const [docId, chunks] of groups) {
      // Sort chunks by score descending
      chunks.sort((a, b) => b.score - a.score);

      // Take top N passages (0 = no limit, show all)
      const topChunks =
        this.options.passagesPerDocument > 0
          ? chunks.slice(0, this.options.passagesPerDocument)
          : chunks;
      const firstChunk = chunks[0];

      grouped.push({
        document_id: docId,
        file_path: firstChunk.filePath,
        file_name: firstChunk.fileName,
        best_score: Math.round(firstChunk.score * 100) / 100,
        match_count: chunks.length,
        passages: topChunks.map((chunk) => this.chunkToPassage(chunk)),
      });
    }

    // Sort groups by best score descending
    grouped.sort((a, b) => b.best_score - a.best_score);

    return grouped;
  }

  private chunkToPassage(chunk: SearchResultInput): PassageOutput {
    const passage: PassageOutput = {
      chunk_id: chunk.chunkId,
      score: Math.round(chunk.score * 100) / 100,
      text: this.truncateText(chunk.chunkText),
      highlights: chunk.highlights ?? [],
    };

    if (chunk.metadata.section !== null) {
      passage.section = chunk.metadata.section;
    }

    return passage;
  }

  private flattenResults(results: SearchResultInput[]): FlatResultOutput[] {
    return results.map((result) => {
      const output: FlatResultOutput = {
        document_id: result.documentId,
        chunk_id: result.chunkId,
        file_path: result.filePath,
        file_name: result.fileName,
        score: Math.round(result.score * 100) / 100,
        match_type: result.matchType,
      };

      // Add fields based on detail level
      if (this.options.detail !== 'minimal') {
        output.text = this.truncateText(result.chunkText);
        output.highlights = result.highlights ?? [];

        if (result.metadata.section !== null) {
          output.section = result.metadata.section;
        }
        if (result.metadata.tags && result.metadata.tags.length > 0) {
          output.tags = result.metadata.tags;
        }
      }

      return output;
    });
  }

  private truncateText(text: string): string {
    if (this.options.detail === 'full') {
      return text;
    }

    if (text.length <= this.options.passageLength) {
      return text;
    }

    return text.substring(0, this.options.passageLength) + '...';
  }

  // -------------------------------------------------------------------------
  // JSON Formatting
  // -------------------------------------------------------------------------

  private formatAsJson(
    results: FlatResultOutput[] | GroupedDocumentOutput[],
    meta: PaginationMeta,
  ): FormattedSearchResponse {
    const output: JsonSearchOutput = {
      meta,
      results,
      grouped: this.options.groupByDocument,
    };

    const jsonStr = JSON.stringify(output, null, 2);

    return {
      llmContent: jsonStr,
      returnDisplay: this.buildReturnDisplay(meta),
    };
  }

  // -------------------------------------------------------------------------
  // Markdown Formatting
  // -------------------------------------------------------------------------

  private formatAsMarkdown(
    results: FlatResultOutput[] | GroupedDocumentOutput[],
    meta: PaginationMeta,
  ): FormattedSearchResponse {
    let content = '';

    // Header
    const paginationInfo =
      meta.has_more || meta.offset > 0
        ? ` (showing ${meta.offset + 1}-${meta.offset + meta.returned_hits}${meta.has_more ? `, more available` : ''})`
        : '';
    content += `Found ${meta.total_hits} result(s) for "${meta.query}" in ${meta.took_ms}ms${paginationInfo}:\n\n`;

    if (this.options.groupByDocument) {
      content += this.formatGroupedMarkdown(results as GroupedDocumentOutput[]);
    } else {
      content += this.formatFlatMarkdown(results as FlatResultOutput[]);
    }

    return {
      llmContent: content,
      returnDisplay: this.buildReturnDisplay(meta),
    };
  }

  private formatGroupedMarkdown(groups: GroupedDocumentOutput[]): string {
    let content = '';

    groups.forEach((group, index) => {
      content += `**${index + 1}. ${group.file_path}** [${group.document_id}] (score: ${group.best_score}, ${group.match_count} matches)\n`;

      // For minimal detail, only show document info without passages
      if (this.options.detail === 'minimal') {
        content += '\n';
        return;
      }

      // For summary and full, show passages
      group.passages.forEach((passage, passageIndex) => {
        // Add passage separator for multiple passages
        if (group.passages.length > 1) {
          content += `   --- Passage ${passageIndex + 1} ---\n`;
        }
        const location = this.formatLocation(passage.section);
        if (location) {
          content += `   ${location}\n`;
        }
        content += `   ${passage.text}\n\n`;
      });
    });

    return content;
  }

  private formatFlatMarkdown(results: FlatResultOutput[]): string {
    let content = '';

    results.forEach((result, index) => {
      content += `**${index + 1}. ${result.file_path}** [${result.document_id}] (score: ${result.score}, ${result.match_type})\n`;

      if (this.options.detail !== 'minimal') {
        const location = this.formatLocation(result.section);
        if (location) {
          content += `   ${location}\n`;
        }
        if (result.text) {
          content += `   ${result.text}\n`;
        }
      }

      content += '\n';
    });

    return content;
  }

  private formatLocation(section?: string): string | null {
    // Note: page is not reliably populated by chunkers, so we only show section
    if (section) {
      return `Section: ${section}`;
    }
    return null;
  }

  private buildReturnDisplay(meta: PaginationMeta): string {
    const hasMore = meta.has_more ? ' (more available)' : '';
    return `Found ${meta.total_hits} result(s) for "${meta.query}" (${meta.strategy} search, ${meta.took_ms}ms)${hasMore}`;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new SearchResponseFormatter instance
 */
export function createSearchResponseFormatter(
  options?: Partial<FormatterOptions>,
): SearchResponseFormatter {
  return new SearchResponseFormatter(options);
}
