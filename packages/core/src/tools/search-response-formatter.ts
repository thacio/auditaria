/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_LOCAL_SEARCH - Search Response Formatter

/**
 * Output format for search results
 */
export type SearchOutputFormat = 'markdown' | 'json';

/**
 * Detail level for search results
 */
export type SearchDetailLevel = 'minimal' | 'summary' | 'full';

/**
 * Options for the search response formatter
 */
export interface FormatterOptions {
  /** Output format: 'markdown' or 'json' */
  format: SearchOutputFormat;
  /** Detail level: 'minimal', 'summary', or 'full' */
  detail: SearchDetailLevel;
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
  passageLength: 500, // Minimum chars to show (0 = full text)
  groupByDocument: true,
  passagesPerDocument: 0, // 0 = no limit, show all passages per document
};

// ============================================================================
// Truncation Types
// ============================================================================

/**
 * Position of a <mark> tag in text
 */
interface MarkPosition {
  start: number; // Position of <mark>
  end: number; // Position after </mark>
}

/**
 * Information about a sentence
 */
interface SentenceInfo {
  text: string;
  start: number;
  end: number;
  index: number;
}

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
    tags?: string[]; // Optional - not currently exposed in tools
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

      // Deduplicate by text content (ignoring <mark> tags)
      const seenTexts = new Set<string>();
      const uniqueChunks = chunks.filter((chunk) => {
        const normalizedText = this.stripMarkTags(chunk.chunkText);
        if (seenTexts.has(normalizedText)) {
          return false;
        }
        seenTexts.add(normalizedText);
        return true;
      });

      // Take top N passages (0 = no limit, show all)
      const topChunks =
        this.options.passagesPerDocument > 0
          ? uniqueChunks.slice(0, this.options.passagesPerDocument)
          : uniqueChunks;
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
    // Deduplicate by text content (ignoring <mark> tags)
    const seenTexts = new Set<string>();
    const uniqueResults = results.filter((result) => {
      const normalizedText = this.stripMarkTags(result.chunkText);
      if (seenTexts.has(normalizedText)) {
        return false;
      }
      seenTexts.add(normalizedText);
      return true;
    });

    return uniqueResults.map((result) => {
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

  // -------------------------------------------------------------------------
  // Smart Truncation System
  // -------------------------------------------------------------------------

  /**
   * Smart truncation that:
   * - passageLength = 0 means full text (explicit no-truncate mode)
   * - passageLength > 0 is treated as MINIMUM (not maximum)
   * - Centers content around <mark> tags when present
   * - Uses sentence-aware bookend strategy when no marks
   * - Shows ALL marked content, may exceed passageLength for quality
   */
  private truncateText(text: string): string {
    const minLen = this.options.passageLength;

    // passageLength = 0 is explicit "show full text" mode
    if (minLen === 0 || this.options.detail === 'full') {
      return text;
    }

    // Document smaller than minimum - return full text
    if (text.length <= minLen) {
      return text;
    }

    // Find all <mark> positions
    const marks = this.findMarkPositions(text);

    if (marks.length > 0) {
      // MARK-AWARE: Show all marked sentences with expanding context
      return this.truncateAroundMarks(text, marks, minLen);
    } else {
      // SEMANTIC (no marks): Bookend strategy with expansion
      return this.truncateSemantic(text, minLen);
    }
  }

  /**
   * Find all <mark>...</mark> positions in text
   */
  private findMarkPositions(text: string): MarkPosition[] {
    const positions: MarkPosition[] = [];
    const regex = /<mark>([\s\S]*?)<\/mark>/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
      positions.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    return positions;
  }

  /**
   * Split text into sentences using punctuation boundaries.
   * Handles common cases like abbreviations by requiring capital letter after.
   */
  private splitIntoSentences(text: string): SentenceInfo[] {
    const sentences: SentenceInfo[] = [];

    // Normalize whitespace
    const normalizedText = text.replace(/\s+/g, ' ').trim();

    if (normalizedText.length === 0) {
      return [];
    }

    // Pattern: sentence-ending punctuation followed by space and capital letter (or end)
    const boundaryPattern = /[.!?](?=\s+[A-Z]|\s*$)/g;

    let lastEnd = 0;
    let match;
    let index = 0;

    while ((match = boundaryPattern.exec(normalizedText)) !== null) {
      const sentenceEnd = match.index + 1; // Include the punctuation
      const sentenceText = normalizedText
        .substring(lastEnd, sentenceEnd)
        .trim();

      if (sentenceText.length > 0) {
        sentences.push({
          text: sentenceText,
          start: lastEnd,
          end: sentenceEnd,
          index: index++,
        });
      }

      lastEnd = sentenceEnd;
      // Skip whitespace for next sentence
      while (
        lastEnd < normalizedText.length &&
        /\s/.test(normalizedText[lastEnd])
      ) {
        lastEnd++;
      }
    }

    // Handle remaining text (last sentence without standard ending)
    if (lastEnd < normalizedText.length) {
      const remaining = normalizedText.substring(lastEnd).trim();
      if (remaining.length > 0) {
        sentences.push({
          text: remaining,
          start: lastEnd,
          end: normalizedText.length,
          index,
        });
      }
    }

    // If no sentences found, treat entire text as one sentence
    if (sentences.length === 0) {
      sentences.push({
        text: normalizedText,
        start: 0,
        end: normalizedText.length,
        index: 0,
      });
    }

    return sentences;
  }

  /**
   * Truncate around marked content.
   * Shows ALL sentences containing marks with expanding context until minimum is reached.
   */
  private truncateAroundMarks(
    text: string,
    marks: MarkPosition[],
    minLen: number,
  ): string {
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) return text;

    // Find sentences containing marks
    const markedIndices = this.findMarkedSentenceIndices(sentences, marks);

    if (markedIndices.size === 0) {
      // Marks exist but not within sentence boundaries (edge case)
      return this.truncateSemantic(text, minLen);
    }

    // Start with context radius of 1 (1 sentence before/after each marked sentence)
    let contextRadius = 1;
    let selectedIndices = this.expandMarkedRegion(
      markedIndices,
      sentences.length,
      contextRadius,
    );
    let currentLength = this.calculateSelectedLength(
      sentences,
      selectedIndices,
    );

    // Expand context until we reach minimum OR include all sentences
    while (currentLength < minLen && selectedIndices.size < sentences.length) {
      contextRadius++;
      selectedIndices = this.expandMarkedRegion(
        markedIndices,
        sentences.length,
        contextRadius,
      );
      currentLength = this.calculateSelectedLength(sentences, selectedIndices);
    }

    // If still below minimum, fill remaining gaps
    if (currentLength < minLen) {
      selectedIndices = this.fillToMinimum(sentences, selectedIndices, minLen);
    }

    const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
    return this.buildResultWithGaps(sentences, sortedIndices);
  }

  /**
   * Find which sentences contain mark tags
   */
  private findMarkedSentenceIndices(
    sentences: SentenceInfo[],
    marks: MarkPosition[],
  ): Set<number> {
    const markedIndices = new Set<number>();

    for (const mark of marks) {
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        // Mark overlaps with sentence if mark.start < sentence.end AND mark.end > sentence.start
        if (mark.start < s.end && mark.end > s.start) {
          markedIndices.add(i);
        }
      }
    }

    return markedIndices;
  }

  /**
   * Expand selection around marked sentences by a given radius
   */
  private expandMarkedRegion(
    markedIndices: Set<number>,
    totalSentences: number,
    radius: number,
  ): Set<number> {
    const expanded = new Set<number>();

    for (const idx of markedIndices) {
      // Add sentences within radius before and after
      for (let r = -radius; r <= radius; r++) {
        const newIdx = idx + r;
        if (newIdx >= 0 && newIdx < totalSentences) {
          expanded.add(newIdx);
        }
      }
    }

    return expanded;
  }

  /**
   * Truncate using bookend strategy for semantic search (no marks).
   * Shows first + last sentences, expanding inward until minimum is reached.
   */
  private truncateSemantic(text: string, minLen: number): string {
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) return text;

    // For very few sentences, return all
    if (sentences.length <= 2) {
      return sentences.map((s) => s.text).join(' ');
    }

    // Start with first and last sentence
    const selectedIndices = new Set<number>();
    selectedIndices.add(0);
    selectedIndices.add(sentences.length - 1);

    let currentLength = this.calculateSelectedLength(
      sentences,
      selectedIndices,
    );

    // Expand from both ends toward middle until we reach minimum
    let leftBoundary = 0;
    let rightBoundary = sentences.length - 1;

    while (currentLength < minLen && leftBoundary < rightBoundary - 1) {
      // Add from left (expand right from first sentence)
      if (leftBoundary + 1 < rightBoundary) {
        leftBoundary++;
        selectedIndices.add(leftBoundary);
        currentLength = this.calculateSelectedLength(
          sentences,
          selectedIndices,
        );
        if (currentLength >= minLen) break;
      }

      // Add from right (expand left from last sentence)
      if (rightBoundary - 1 > leftBoundary) {
        rightBoundary--;
        selectedIndices.add(rightBoundary);
        currentLength = this.calculateSelectedLength(
          sentences,
          selectedIndices,
        );
        if (currentLength >= minLen) break;
      }
    }

    const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
    return this.buildResultWithGaps(sentences, sortedIndices);
  }

  /**
   * Fill gaps to reach minimum length
   */
  private fillToMinimum(
    sentences: SentenceInfo[],
    selectedIndices: Set<number>,
    minLen: number,
  ): Set<number> {
    const result = new Set(selectedIndices);
    let currentLength = this.calculateSelectedLength(sentences, result);

    // Add unselected sentences in order until we reach minimum
    for (let i = 0; i < sentences.length && currentLength < minLen; i++) {
      if (!result.has(i)) {
        result.add(i);
        currentLength = this.calculateSelectedLength(sentences, result);
      }
    }

    return result;
  }

  /**
   * Calculate total length of selected sentences including gap indicators
   */
  private calculateSelectedLength(
    sentences: SentenceInfo[],
    indices: Set<number>,
  ): number {
    let length = 0;
    const sortedIndices = Array.from(indices).sort((a, b) => a - b);

    for (const idx of sortedIndices) {
      length += sentences[idx].text.length + 1; // +1 for space between sentences
    }

    // Account for gap indicators ([...])
    let gaps = 0;
    for (let i = 1; i < sortedIndices.length; i++) {
      if (sortedIndices[i] > sortedIndices[i - 1] + 1) {
        gaps++;
      }
    }
    length += gaps * 7; // " [...] " = 7 chars

    // Account for start/end ellipsis
    if (sortedIndices.length > 0) {
      if (sortedIndices[0] > 0) length += 4; // "... "
      if (sortedIndices[sortedIndices.length - 1] < sentences.length - 1)
        length += 4; // " ..."
    }

    return length;
  }

  /**
   * Build result string with gap indicators for discontinuous sections
   */
  private buildResultWithGaps(
    sentences: SentenceInfo[],
    selectedIndices: number[],
  ): string {
    if (selectedIndices.length === 0) {
      return '';
    }

    let result = '';
    let prevIdx = -2;

    // Check if we're skipping the beginning
    if (selectedIndices[0] > 0) {
      result = '... ';
    }

    for (const idx of selectedIndices) {
      // Check for gap (non-consecutive indices)
      if (prevIdx >= 0 && idx > prevIdx + 1) {
        result = result.trimEnd() + ' [...] ';
      } else if (result.length > 0 && !result.endsWith(' ')) {
        result += ' ';
      }

      result += sentences[idx].text;
      prevIdx = idx;
    }

    // Check if we're skipping the end
    const lastSelectedIdx = selectedIndices[selectedIndices.length - 1];
    if (lastSelectedIdx < sentences.length - 1) {
      result = result.trimEnd() + ' ...';
    }

    return result.trim();
  }

  /**
   * Truncate at word boundary as fallback
   */
  private truncateAtWordBoundary(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }

    const truncated = text.substring(0, maxLen);
    const lastSpace = truncated.lastIndexOf(' ');

    // Use word boundary if reasonable (at least 60% of maxLen)
    if (lastSpace > maxLen * 0.6) {
      return truncated.substring(0, lastSpace).trimEnd() + '...';
    }

    return truncated.trimEnd() + '...';
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
      // Add divider before documents 2, 3, 4, etc.
      if (index > 0) {
        content += '---\n\n';
      }
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

  /**
   * Strip <mark> tags from text for deduplication comparison.
   * The original text with marks is preserved in the output.
   */
  private stripMarkTags(text: string): string {
    return text.replace(/<\/?mark>/gi, '');
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
