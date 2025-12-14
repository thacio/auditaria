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
import { SEARCH_DOCUMENTS_TOOL_NAME } from './tool-names.js';

/**
 * Parameters for the SearchDocuments tool
 */
export interface SearchDocumentsToolParams {
  /**
   * The search query
   */
  query: string;

  /**
   * Search strategy: 'hybrid' (default), 'semantic', or 'keyword'
   */
  strategy?: 'hybrid' | 'semantic' | 'keyword';

  /**
   * Filter results to specific folders
   */
  folders?: string[];

  /**
   * Filter results to specific file types (e.g., '.pdf', '.docx')
   */
  file_types?: string[];

  /**
   * Filter results to documents with specific tags
   */
  tags?: string[];

  /**
   * Maximum number of results to return (default: 10)
   */
  limit?: number;
}

const SEARCH_DOCUMENTS_DESCRIPTION = `Search indexed documents using keyword, semantic, or hybrid search.

This tool searches through all indexed documents in the project using advanced search capabilities:

- **hybrid** (default): Combines semantic and keyword search using Reciprocal Rank Fusion for best results
- **semantic**: Uses vector embeddings to find semantically similar content (understands meaning)
- **keyword**: Traditional full-text search based on exact word matches

You can filter results by:
- **folders**: Only search in specific directories
- **file_types**: Only search specific file types (e.g., '.pdf', '.docx')
- **tags**: Only search documents with specific tags

The search returns relevant document chunks with their file paths, scores, and highlighted text.

**Note:** The search index must be initialized first using the search_init tool.
`;

class SearchDocumentsToolInvocation extends BaseToolInvocation<
  SearchDocumentsToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: SearchDocumentsToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    const strategy = this.params.strategy ?? 'hybrid';
    return `Searching for "${this.params.query}" (${strategy})`;
  }

  async execute(): Promise<ToolResult> {
    const { query, strategy, folders, file_types, tags, limit } = this.params;

    try {
      // Dynamically import search package to avoid bundling issues
      const { loadSearchSystem, searchDatabaseExists } = await import(
        '@thacio/search'
      );

      const rootPath = this.config.getTargetDir();

      // Check if search index exists
      if (!searchDatabaseExists(rootPath)) {
        const msg =
          'Search index not found. Please initialize it first using the search_index tool with action "init".';
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: {
            message: msg,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      // Load the search system
      const searchSystem = await loadSearchSystem(rootPath, {
        useMockEmbedder: false,
      });

      if (!searchSystem) {
        const msg =
          'Failed to load search index. Please reinitialize using search_index tool with action "init".';
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
        // Perform the search
        const response = await searchSystem.search({
          query,
          strategy: strategy ?? 'hybrid',
          filters: {
            folders,
            fileTypes: file_types,
            tags,
          },
          limit: limit ?? 10,
          highlight: true,
        });

        // Format results for display
        const formattedResults = response.results.map((result, index) => ({
          rank: index + 1,
          file: result.filePath,
          score: Math.round(result.score * 100) / 100,
          matchType: result.matchType,
          section: result.metadata?.section ?? null,
          page: result.metadata?.page ?? null,
          text:
            result.chunkText.length > 300
              ? result.chunkText.substring(0, 300) + '...'
              : result.chunkText,
          highlights: result.highlights ?? [],
        }));

        // Build response message
        let llmContent = '';

        if (response.results.length === 0) {
          llmContent = `No results found for query: "${query}"`;
        } else {
          llmContent = `Found ${response.results.length} result(s) for "${query}" in ${response.took}ms:\n\n`;

          formattedResults.forEach((result) => {
            llmContent += `**${result.rank}. ${result.file}** (score: ${result.score}, ${result.matchType})\n`;
            if (result.section) {
              llmContent += `   Section: ${result.section}\n`;
            }
            if (result.page) {
              llmContent += `   Page: ${result.page}\n`;
            }
            llmContent += `   ${result.text}\n\n`;
          });
        }

        return {
          llmContent,
          returnDisplay: `Found ${response.results.length} result(s) for "${query}" (${strategy ?? 'hybrid'} search, ${response.took}ms)`,
        };
      } finally {
        // Always close the search system to release resources
        await searchSystem.close();
      }
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
}

/**
 * Tool for searching indexed documents
 */
export class SearchDocumentsTool extends BaseDeclarativeTool<
  SearchDocumentsToolParams,
  ToolResult
> {
  static readonly Name = SEARCH_DOCUMENTS_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus?: MessageBus,
  ) {
    super(
      SearchDocumentsTool.Name,
      'SearchDocuments',
      SEARCH_DOCUMENTS_DESCRIPTION,
      Kind.Read,
      {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
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
            description: 'Filter results to specific folders',
          },
          file_types: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Filter results to specific file types (e.g., ".pdf", ".docx")',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter results to documents with specific tags',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 10)',
          },
        },
        required: ['query'],
      },
      true,
      false,
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: SearchDocumentsToolParams,
  ): string | null {
    if (!params.query || params.query.trim() === '') {
      return 'Query must be a non-empty string';
    }

    if (
      params.strategy &&
      !['hybrid', 'semantic', 'keyword'].includes(params.strategy)
    ) {
      return 'Strategy must be one of: hybrid, semantic, keyword';
    }

    if (
      params.limit !== undefined &&
      (params.limit <= 0 || params.limit > 50)
    ) {
      return 'Limit must be between 1 and 50';
    }

    return null;
  }

  protected createInvocation(
    params: SearchDocumentsToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<SearchDocumentsToolParams, ToolResult> {
    return new SearchDocumentsToolInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      displayName,
    );
  }
}
