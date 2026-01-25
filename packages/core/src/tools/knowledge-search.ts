/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_LOCAL_SEARCH - Auditaria Custom Feature

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import type { Config } from '../config/config.js';
import { KNOWLEDGE_SEARCH_TOOL_NAME } from './tool-names.js';
import { SearchServiceManager } from '../services/search-service.js';
import {
  SearchResponseFormatter,
  type SearchOutputFormat,
  type SearchDetailLevel,
  type SearchResultInput,
} from './search-response-formatter.js';

/**
 * Diversity strategy for search results
 */
export type DiversityStrategyParam = 'none' | 'score_penalty' | 'cap_then_fill';

/**
 * Parameters for the KnowledgeSearch tool
 */
export interface KnowledgeSearchToolParams {
  /**
   * The search query (required unless document_id is provided)
   */
  query: string;

  /**
   * Search strategy: 'hybrid' (default), 'semantic', or 'keyword'
   */
  strategy?: 'hybrid' | 'semantic' | 'keyword';

  /**
   * Filter to specific folders. Use relative paths from project root.
   * Partial matching is supported (e.g., "docs" matches "docs/reports" and "my-docs").
   */
  folders?: string[];

  /**
   * Filter by file extension. Case-insensitive, leading dot is optional.
   * Examples: ["pdf", "docx"] or [".pdf", ".docx"] or [".PDF"]
   */
  file_types?: string[];

  /**
   * Maximum number of results to return (default: 30, max: 200)
   */
  limit?: number;

  /**
   * Filter to a specific document by ID (from previous search results).
   * When provided, returns all chunks for that document.
   */
  document_id?: string;

  /**
   * Output format: 'markdown' (default) or 'json' for structured data
   */
  format?: SearchOutputFormat;

  /**
   * Detail level: 'minimal', 'summary' (default), or 'full'
   * - minimal: document IDs and scores only
   * - summary: includes truncated text and metadata
   * - full: includes complete chunk text (no truncation)
   */
  detail?: SearchDetailLevel;

  /**
   * Max characters per passage (default: 300, max: 2000).
   * Only applies when detail is 'summary'.
   */
  passage_length?: number;

  /**
   * Group results by document (default: true).
   * When true, returns top passages per document instead of flat list.
   * Set to false for flat list of all matching chunks.
   */
  group_by_document?: boolean;

  /**
   * Max passages per document when grouped (default: 0 = no limit)
   */
  passages_per_document?: number;

  /**
   * Pagination offset (default: 0)
   */
  offset?: number;

  // -------------------------------------------------------------------------
  // Diversity Options
  // -------------------------------------------------------------------------

  /**
   * Diversity strategy for search results (default: 'score_penalty')
   * - 'none': No diversity filtering, pure relevance ranking
   * - 'score_penalty': Apply decay factor to subsequent passages from same document
   * - 'cap_then_fill': Hard cap per document, then fill remaining slots progressively
   */
  diversity_strategy?: DiversityStrategyParam;

  /**
   * Decay factor for score_penalty strategy (default: 0.85).
   * Lower values increase diversity by penalizing same-document passages more.
   * Range: 0.5 to 1.0
   */
  diversity_decay?: number;

  /**
   * Max passages per document for cap_then_fill strategy (default: 5).
   * After the cap is reached, remaining slots are filled progressively.
   */
  max_per_document?: number;

  /**
   * Enable semantic deduplication to merge near-duplicate passages (default: true).
   * When enabled, similar passages from different files are merged, showing
   * "Also found in: file1, file2" in results.
   */
  semantic_dedup?: boolean;

  /**
   * Cosine similarity threshold for semantic deduplication (default: 0.97).
   * Higher values require more similarity to merge. Range: 0.9 to 1.0
   */
  semantic_dedup_threshold?: number;
}

const KNOWLEDGE_SEARCH_DESCRIPTION = `Search the knowledge base using keyword, semantic, or hybrid search.

This tool searches through all indexed documents in the project using advanced search capabilities:

**Search Strategies:**
- **hybrid** (default): Combines semantic and keyword search using Reciprocal Rank Fusion for best results
- **semantic**: Uses vector embeddings to find semantically similar content (understands meaning)
- **keyword**: Traditional full-text search based on exact word matches

**Filtering:**
- **folders**: Search only in specific directories. Use relative paths from project root. Partial matching is supported (e.g., "docs" matches "docs/reports" and "my-docs"). Can use forward slashes on all platforms.
- **file_types**: Filter by file extension. Accepts with or without leading dot, case-insensitive (e.g., "pdf", ".PDF", ".docx" all work). Examples: ["pdf", "docx"] or [".pdf", ".docx"]
- **document_id**: Retrieve all chunks for a specific document (from previous search results)

**Output Control:**
- **format**: 'markdown' (human-readable) or 'json' (structured for programmatic use)
- **detail**: 'minimal' (IDs/scores only), 'summary' (truncated text), 'full' (complete text)
- **group_by_document**: Groups results by document with best passages (default: true)
- **passage_length**: Max characters per passage (1-2000, default: 300)

**Result Diversity (prevents single document from dominating results):**
- **diversity_strategy**: 'score_penalty' (default), 'cap_then_fill', or 'none'
  - 'score_penalty': Penalizes subsequent passages from same document (good balance)
  - 'cap_then_fill': Hard cap per document, fills remaining slots progressively (maximum diversity)
  - 'none': Pure relevance ranking (no diversity adjustment)
- **diversity_decay**: Decay factor for score_penalty (0.5-1.0, default: 0.85). Lower = more diversity
- **max_per_document**: Max passages per document for cap_then_fill (default: 5)
- **semantic_dedup**: Merge near-duplicate passages from different files (default: true)
  - Shows "Also found in: file1, file2" for duplicated content
- **semantic_dedup_threshold**: Cosine similarity for dedup (0.9-1.0, default: 0.97)

**Pagination:**
- **limit**: Max passages to return (default: 30, max: 200)
- **offset**: Starting position for pagination

**Workflow for retrieving full documents:**
1. Search: \`knowledge_search(query: "audit methodology")\` - returns document IDs with snippets
2. Retrieve: \`knowledge_search(document_id: "doc_xxx", detail: "full")\` - returns complete document content

**Note:** The knowledge base must be initialized first using the knowledge_index tool with action "init".
`;

class KnowledgeSearchToolInvocation extends BaseToolInvocation<
  KnowledgeSearchToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: KnowledgeSearchToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    if (this.params.document_id) {
      return `Retrieving document "${this.params.document_id}"`;
    }
    const strategy = this.params.strategy ?? 'hybrid';
    return `Searching for "${this.params.query}" (${strategy})`;
  }

  async execute(): Promise<ToolResult> {
    const {
      query,
      strategy,
      folders,
      file_types,
      limit,
      document_id,
      format,
      detail,
      passage_length,
      group_by_document,
      passages_per_document,
      offset,
      // Diversity options
      diversity_strategy,
      diversity_decay,
      max_per_document,
      semantic_dedup,
      semantic_dedup_threshold,
    } = this.params;

    // Get the shared SearchSystem from ServiceManager
    const service = SearchServiceManager.getInstance();

    if (!service.isRunning()) {
      // Try to start the service automatically if database exists
      const rootPath = this.config.getTargetDir();
      try {
        const { searchDatabaseExists } = await import('@thacio/auditaria-cli-search');

        if (!searchDatabaseExists(rootPath)) {
          const msg =
            'Knowledge base not found. Please initialize it first using the knowledge_index tool with action "init".';
          return {
            llmContent: msg,
            returnDisplay: msg,
            error: {
              message: msg,
              type: ToolErrorType.EXECUTION_FAILED,
            },
          };
        }

        // Auto-start the service
        console.log('[KnowledgeSearch] Auto-starting search service...');
        await service.start(rootPath, {
          skipInitialSync: true, // Don't sync now, just make search available
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          llmContent: `Failed to start search service: ${errorMessage}`,
          returnDisplay: `Search error: ${errorMessage}`,
          error: {
            message: errorMessage,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }
    }

    const searchSystem = service.getSearchSystem();
    if (!searchSystem) {
      const msg = 'Search service is starting. Please try again in a moment.';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: {
          message: msg,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }

    try {
      // Handle document retrieval mode (when document_id is provided)
      if (document_id) {
        return await this.retrieveDocument(searchSystem, document_id);
      }

      // Perform the search
      const effectiveLimit = limit ?? 30;
      const effectiveOffset = offset ?? 0;

      const response = await searchSystem.search({
        query,
        strategy: strategy ?? 'hybrid',
        filters: {
          folders,
          fileTypes: file_types,
        },
        limit: effectiveLimit + effectiveOffset, // Fetch extra for offset
        offset: 0, // We handle offset in formatter
        highlight: true,
        // Diversity options
        diversity: {
          strategy: diversity_strategy,
          decayFactor: diversity_decay,
          maxPerDocument: max_per_document,
          semanticDedup: semantic_dedup,
          semanticDedupThreshold: semantic_dedup_threshold,
        },
      });

      // Apply offset to results
      const offsetResults = response.results.slice(effectiveOffset);

      // Convert to formatter input format
      const formatterInput: SearchResultInput[] = offsetResults.map(
        (result) => ({
          documentId: result.documentId,
          chunkId: result.chunkId,
          filePath: result.filePath,
          fileName: result.fileName,
          chunkText: result.chunkText,
          score: result.score,
          matchType: result.matchType,
          highlights: result.highlights ?? [],
          metadata: {
            page: result.metadata?.page ?? null,
            section: result.metadata?.section ?? null,
          },
          // Include additional sources from semantic deduplication
          additionalSources: result.additionalSources?.map(src => ({
            filePath: src.filePath,
            fileName: src.fileName,
            documentId: src.documentId,
            score: src.score,
          })),
        }),
      );

      // Create formatter with options
      const formatter = new SearchResponseFormatter({
        format: format ?? 'markdown',
        detail: detail ?? 'summary',
        passageLength: passage_length ?? 300,
        groupByDocument: group_by_document ?? true,
        passagesPerDocument: passages_per_document ?? 0, // 0 = no limit
      });

      // Format the response
      const formatted = formatter.format(formatterInput, query, response.took, {
        offset: effectiveOffset,
        limit: effectiveLimit,
        totalAvailable: response.results.length,
      });

      return {
        llmContent: formatted.llmContent,
        returnDisplay: formatted.returnDisplay,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Search failed: ${errorMessage}`,
        returnDisplay: `Search error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  /**
   * Retrieve all chunks for a specific document by ID
   */
  private async retrieveDocument(
    searchSystem: NonNullable<
      ReturnType<typeof SearchServiceManager.prototype.getSearchSystem>
    >,
    documentId: string,
  ): Promise<ToolResult> {
    const { format, detail } = this.params;
    const startTime = Date.now();

    try {
      // Get document info
      const document = await searchSystem.getDocument(documentId);

      if (!document) {
        const msg = `Document not found: "${documentId}"`;
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: {
            message: msg,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      // Get all chunks for this document
      const chunks = await searchSystem.getDocumentChunks(documentId);
      const took = Date.now() - startTime;

      // Convert to formatter input
      const formatterInput: SearchResultInput[] = chunks.map((chunk) => ({
        documentId: document.id,
        chunkId: chunk.id,
        filePath: document.filePath,
        fileName: document.fileName,
        chunkText: chunk.text,
        score: 1.0, // Full relevance for direct retrieval
        matchType: 'hybrid' as const,
        highlights: [],
        metadata: {
          page: chunk.page ?? null,
          section: chunk.section ?? null,
        },
      }));

      // Create formatter - defaults to 'full' detail for document retrieval
      // but respects user's choice if they specify a different detail level
      const effectiveDetail = detail ?? 'full';
      const formatter = new SearchResponseFormatter({
        format: format ?? 'markdown',
        detail: effectiveDetail,
        // For 'full' detail, use max length; otherwise respect user's passage_length
        passageLength:
          effectiveDetail === 'full'
            ? 10000
            : (this.params.passage_length ?? 300),
        groupByDocument: true, // Always group for document retrieval
        passagesPerDocument: 1000, // Return all chunks
      });

      const formatted = formatter.format(
        formatterInput,
        `document:${documentId}`,
        took,
        {
          offset: 0,
          limit: chunks.length,
          totalAvailable: chunks.length,
        },
      );

      return {
        llmContent: formatted.llmContent,
        returnDisplay: `Retrieved document "${document.fileName}" (${chunks.length} chunks, ${took}ms)`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to retrieve document: ${errorMessage}`,
        returnDisplay: `Retrieval error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

/**
 * Tool for searching the knowledge base
 */
export class KnowledgeSearchTool extends BaseDeclarativeTool<
  KnowledgeSearchToolParams,
  ToolResult
> {
  static readonly Name = KNOWLEDGE_SEARCH_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      KnowledgeSearchTool.Name,
      'KnowledgeSearch',
      KNOWLEDGE_SEARCH_DESCRIPTION,
      Kind.Read,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'The search query. Required unless document_id is provided.',
          },
          strategy: {
            type: 'string',
            enum: ['hybrid', 'semantic', 'keyword'],
            description:
              'Search strategy to use. "hybrid" (default) combines semantic and keyword search for best results.',
          },
          folders: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter to specific folders. Use relative paths from project root. Partial matching supported (e.g., "docs" matches "docs/reports").',
          },
          file_types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter by file extension. Case-insensitive, dot optional (e.g., "pdf", ".PDF", ".docx" all work).',
          },
          limit: {
            type: 'number',
            description:
              'Maximum number of passages to return (default: 30, max: 200)',
          },
          document_id: {
            type: 'string',
            description:
              'Retrieve all chunks for a specific document by ID. When provided, query is optional and detail defaults to "full".',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'json'],
            description:
              'Output format. "markdown" (default) for human-readable, "json" for structured data.',
          },
          detail: {
            type: 'string',
            enum: ['minimal', 'summary', 'full'],
            description:
              'Detail level. "minimal" = IDs/scores only, "summary" (default) = truncated text, "full" = complete text.',
          },
          passage_length: {
            type: 'number',
            description:
              'Max characters per passage for summary detail (default: 300, max: 2000)',
          },
          group_by_document: {
            type: 'boolean',
            description:
              'Group results by document showing top passages per document (default: true)',
          },
          passages_per_document: {
            type: 'number',
            description:
              'Max passages per document when grouped (default: 0 = no limit)',
          },
          offset: {
            type: 'number',
            description: 'Pagination offset for skipping results (default: 0)',
          },
          diversity_strategy: {
            type: 'string',
            enum: ['none', 'score_penalty', 'cap_then_fill'],
            description:
              'Diversity strategy for results. "score_penalty" (default) penalizes same-document passages, "cap_then_fill" caps per document then fills, "none" uses pure relevance.',
          },
          diversity_decay: {
            type: 'number',
            description:
              'Decay factor for score_penalty strategy (0.5-1.0, default: 0.85). Lower values increase diversity.',
          },
          max_per_document: {
            type: 'number',
            description:
              'Max passages per document for cap_then_fill strategy (default: 5).',
          },
          semantic_dedup: {
            type: 'boolean',
            description:
              'Merge near-duplicate passages from different files (default: true). Shows "Also found in:" for duplicates.',
          },
          semantic_dedup_threshold: {
            type: 'number',
            description:
              'Cosine similarity threshold for semantic dedup (0.9-1.0, default: 0.97). Higher = stricter matching.',
          },
        },
        required: ['query'],
      },
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: KnowledgeSearchToolParams,
  ): string | null {
    // Query is required unless document_id is provided
    if (!params.document_id) {
      if (!params.query || params.query.trim() === '') {
        return 'Query must be a non-empty string (unless document_id is provided)';
      }
    }

    if (
      params.strategy &&
      !['hybrid', 'semantic', 'keyword'].includes(params.strategy)
    ) {
      return 'Strategy must be one of: hybrid, semantic, keyword';
    }

    if (
      params.limit !== undefined &&
      (params.limit <= 0 || params.limit > 200)
    ) {
      return 'Limit must be between 1 and 200';
    }

    if (params.format && !['markdown', 'json'].includes(params.format)) {
      return 'Format must be one of: markdown, json';
    }

    if (
      params.detail &&
      !['minimal', 'summary', 'full'].includes(params.detail)
    ) {
      return 'Detail must be one of: minimal, summary, full';
    }

    if (
      params.passage_length !== undefined &&
      (params.passage_length < 1 || params.passage_length > 2000)
    ) {
      return 'Passage length must be between 1 and 2000';
    }

    if (
      params.passages_per_document !== undefined &&
      params.passages_per_document < 0
    ) {
      return 'Passages per document must be 0 (no limit) or a positive number';
    }

    if (params.offset !== undefined && params.offset < 0) {
      return 'Offset must be a non-negative number';
    }

    // Diversity parameter validation
    if (
      params.diversity_strategy &&
      !['none', 'score_penalty', 'cap_then_fill'].includes(params.diversity_strategy)
    ) {
      return 'Diversity strategy must be one of: none, score_penalty, cap_then_fill';
    }

    if (
      params.diversity_decay !== undefined &&
      (params.diversity_decay < 0.5 || params.diversity_decay > 1.0)
    ) {
      return 'Diversity decay must be between 0.5 and 1.0';
    }

    if (params.max_per_document !== undefined && params.max_per_document < 1) {
      return 'Max per document must be at least 1';
    }

    if (
      params.semantic_dedup_threshold !== undefined &&
      (params.semantic_dedup_threshold < 0.9 || params.semantic_dedup_threshold > 1.0)
    ) {
      return 'Semantic dedup threshold must be between 0.9 and 1.0';
    }

    return null;
  }

  protected createInvocation(
    params: KnowledgeSearchToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<KnowledgeSearchToolParams, ToolResult> {
    return new KnowledgeSearchToolInvocation(
      this.config,
      params,
      messageBus ?? this.messageBus,
      toolName,
      displayName,
    );
  }
}
