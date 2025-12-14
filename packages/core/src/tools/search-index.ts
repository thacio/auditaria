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
import { SEARCH_INDEX_TOOL_NAME } from './tool-names.js';

/**
 * Parameters for the SearchIndex tool
 */
export interface SearchIndexToolParams {
  /**
   * Action to perform: 'init', 'status', or 'reindex'
   */
  action: 'init' | 'status' | 'reindex';

  /**
   * For reindex action: specific file path to reindex
   */
  file_path?: string;

  /**
   * For init action: force full reindex even if index exists
   */
  force?: boolean;
}

const SEARCH_INDEX_DESCRIPTION = `Manage the local document search index.

This tool manages the search index for the project. Available actions:

- **init**: Initialize or update the search index. Discovers all indexable files, parses them, generates embeddings, and stores them for fast searching. Use 'force: true' to rebuild the entire index from scratch.

- **status**: Get the current status of the search index including:
  - Total documents indexed
  - Pending documents in queue
  - OCR status (if available)
  - Index size and health

- **reindex**: Reindex a specific file. Useful when a file was updated but not picked up by the watcher. Requires 'file_path' parameter.

The index stores document chunks with vector embeddings for semantic search and full-text indexes for keyword search.

**Supported file types:** PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, TXT, MD, HTML, images (with OCR), and more.
`;

class SearchIndexToolInvocation extends BaseToolInvocation<
  SearchIndexToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: SearchIndexToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    switch (this.params.action) {
      case 'init':
        return this.params.force
          ? 'Rebuilding search index'
          : 'Initializing search index';
      case 'status':
        return 'Checking search index status';
      case 'reindex':
        return `Reindexing ${this.params.file_path ?? 'file'}`;
      default:
        return 'Managing search index';
    }
  }

  async execute(
    _signal: AbortSignal,
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    switch (this.params.action) {
      case 'init':
        return this.executeInit(updateOutput);
      case 'status':
        return this.executeStatus();
      case 'reindex':
        return this.executeReindex();
      default:
        return {
          llmContent: `Unknown action: ${this.params.action}`,
          returnDisplay: `Invalid action: ${this.params.action}`,
          error: {
            message: `Unknown action: ${this.params.action}`,
            type: ToolErrorType.INVALID_TOOL_PARAMS,
          },
        };
    }
  }

  private async executeInit(
    updateOutput?: (output: string) => void,
  ): Promise<ToolResult> {
    const rootPath = this.config.getTargetDir();

    try {
      const { initializeSearchSystem, loadSearchSystem, searchDatabaseExists } =
        await import('@thacio/search');

      let searchSystem;
      const indexExists = searchDatabaseExists(rootPath);

      if (indexExists && !this.params.force) {
        // Load existing index and update
        updateOutput?.('Loading existing search index...');
        searchSystem = await loadSearchSystem(rootPath, {
          useMockEmbedder: false,
        });

        if (!searchSystem) {
          // Database exists but couldn't load - reinitialize
          updateOutput?.('Reinitializing corrupted index...');
          searchSystem = await initializeSearchSystem({
            rootPath,
            useMockEmbedder: false,
          });
        }
      } else {
        // Initialize new index
        updateOutput?.(
          this.params.force
            ? 'Force rebuilding search index...'
            : 'Creating new search index...',
        );
        searchSystem = await initializeSearchSystem({
          rootPath,
          useMockEmbedder: false,
        });
      }

      try {
        // Discover and index files
        updateOutput?.('Discovering files...');
        const files = await searchSystem.discoverFiles();
        updateOutput?.(`Found ${files.length} files to index`);

        // Index all files
        updateOutput?.('Indexing documents (this may take a while)...');

        // Subscribe to progress events
        searchSystem.on('indexing:progress', (event) => {
          updateOutput?.(
            `Indexing progress: ${event.current}/${event.total} documents`,
          );
        });

        const result = await searchSystem.indexAll({
          force: this.params.force,
        });

        // Get final stats
        const stats = await searchSystem.getStats();
        const state = searchSystem.getState();

        let llmContent = `Search index ${indexExists && !this.params.force ? 'updated' : 'created'} successfully!\n\n`;
        llmContent += `**Indexing Results:**\n`;
        llmContent += `- Documents indexed: ${result.indexed}\n`;
        llmContent += `- Failed: ${result.failed}\n`;
        llmContent += `- Duration: ${(result.duration / 1000).toFixed(1)}s\n\n`;
        llmContent += `**Index Statistics:**\n`;
        llmContent += `- Total documents: ${stats.totalDocuments}\n`;
        llmContent += `- Total chunks: ${stats.totalChunks}\n`;
        llmContent += `- Database size: ${formatBytes(stats.databaseSize)}\n`;

        if (state.ocrAvailable) {
          llmContent += `- OCR: Available\n`;
          if (stats.ocrPending > 0) {
            llmContent += `- OCR pending: ${stats.ocrPending} documents\n`;
          }
        }

        return {
          llmContent,
          returnDisplay: `Indexed ${result.indexed} documents (${result.failed} failed) in ${(result.duration / 1000).toFixed(1)}s`,
        };
      } finally {
        await searchSystem.close();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to initialize search index: ${errorMessage}`,
        returnDisplay: `Initialization error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  private async executeStatus(): Promise<ToolResult> {
    const rootPath = this.config.getTargetDir();

    try {
      const { loadSearchSystem, searchDatabaseExists } = await import(
        '@thacio/search'
      );

      if (!searchDatabaseExists(rootPath)) {
        return {
          llmContent:
            'Search index not found. Use search_index with action "init" to create it.',
          returnDisplay: 'Search index not initialized',
        };
      }

      const searchSystem = await loadSearchSystem(rootPath, {
        useMockEmbedder: false,
      });

      if (!searchSystem) {
        return {
          llmContent:
            'Search index exists but could not be loaded. Consider reinitializing with force: true.',
          returnDisplay: 'Failed to load search index',
        };
      }

      try {
        const stats = await searchSystem.getStats();
        const state = searchSystem.getState();
        const queueStatus = await searchSystem.getQueueStatus();
        const ocrStatus = searchSystem.getOcrQueueStatus();

        let llmContent = `**Search Index Status**\n\n`;
        llmContent += `- Root path: ${state.rootPath}\n`;
        llmContent += `- Database: ${state.databasePath}\n`;
        llmContent += `- Initialized: Yes\n\n`;

        llmContent += `**Statistics:**\n`;
        llmContent += `- Total documents: ${stats.totalDocuments}\n`;
        llmContent += `- Indexed documents: ${stats.indexedDocuments}\n`;
        llmContent += `- Total chunks: ${stats.totalChunks}\n`;
        llmContent += `- Tags: ${stats.totalTags}\n`;
        llmContent += `- Database size: ${formatBytes(stats.databaseSize)}\n\n`;

        if (queueStatus.pending > 0 || queueStatus.processing > 0) {
          llmContent += `**Queue Status:**\n`;
          llmContent += `- Pending: ${queueStatus.pending}\n`;
          llmContent += `- Processing: ${queueStatus.processing}\n`;
          llmContent += `- Failed: ${queueStatus.failed}\n\n`;
        }

        if (state.ocrAvailable && ocrStatus) {
          llmContent += `**OCR Status:**\n`;
          llmContent += `- Available: Yes\n`;
          llmContent += `- Pending jobs: ${ocrStatus.pendingJobs}\n`;
          llmContent += `- Processing: ${ocrStatus.processingJobs}\n`;
          llmContent += `- Completed: ${ocrStatus.completedJobs}\n`;
          llmContent += `- Failed: ${ocrStatus.failedJobs}\n`;
        } else {
          llmContent += `**OCR:** Not available\n`;
        }

        return {
          llmContent,
          returnDisplay: `${stats.totalDocuments} documents indexed (${stats.totalChunks} chunks, ${formatBytes(stats.databaseSize)})`,
        };
      } finally {
        await searchSystem.close();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to get search index status: ${errorMessage}`,
        returnDisplay: `Status error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  private async executeReindex(): Promise<ToolResult> {
    const { file_path } = this.params;

    if (!file_path) {
      const msg = 'file_path is required for reindex action';
      return {
        llmContent: msg,
        returnDisplay: msg,
        error: {
          message: msg,
          type: ToolErrorType.INVALID_TOOL_PARAMS,
        },
      };
    }

    const rootPath = this.config.getTargetDir();

    try {
      const { loadSearchSystem, searchDatabaseExists } = await import(
        '@thacio/search'
      );

      if (!searchDatabaseExists(rootPath)) {
        const msg =
          'Search index not found. Initialize it first using action "init".';
        return {
          llmContent: msg,
          returnDisplay: msg,
          error: {
            message: msg,
            type: ToolErrorType.EXECUTION_FAILED,
          },
        };
      }

      const searchSystem = await loadSearchSystem(rootPath, {
        useMockEmbedder: false,
      });

      if (!searchSystem) {
        const msg = 'Failed to load search index.';
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
        const success = await searchSystem.reindexFile(file_path);

        if (success) {
          return {
            llmContent: `Successfully reindexed: ${file_path}`,
            returnDisplay: `Reindexed: ${file_path}`,
          };
        } else {
          const msg = `Failed to reindex: ${file_path}. The file may not exist or may not be a supported type.`;
          return {
            llmContent: msg,
            returnDisplay: `Reindex failed: ${file_path}`,
            error: {
              message: msg,
              type: ToolErrorType.EXECUTION_FAILED,
            },
          };
        }
      } finally {
        await searchSystem.close();
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to reindex file: ${errorMessage}`,
        returnDisplay: `Reindex error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Tool for managing the search index
 */
export class SearchIndexTool extends BaseDeclarativeTool<
  SearchIndexToolParams,
  ToolResult
> {
  static readonly Name = SEARCH_INDEX_TOOL_NAME;

  constructor(
    private readonly config: Config,
    messageBus?: MessageBus,
  ) {
    super(
      SearchIndexTool.Name,
      'SearchIndex',
      SEARCH_INDEX_DESCRIPTION,
      Kind.Other,
      {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['init', 'status', 'reindex'],
            description:
              'Action to perform: "init" to create/update index, "status" to check index health, "reindex" to reindex a specific file',
          },
          file_path: {
            type: 'string',
            description: 'For reindex action: the file path to reindex',
          },
          force: {
            type: 'boolean',
            description:
              'For init action: force rebuild the entire index from scratch',
          },
        },
        required: ['action'],
      },
      true,
      false,
      messageBus,
    );
  }

  protected override validateToolParamValues(
    params: SearchIndexToolParams,
  ): string | null {
    if (!params.action) {
      return 'Action is required';
    }

    if (!['init', 'status', 'reindex'].includes(params.action)) {
      return 'Action must be one of: init, status, reindex';
    }

    if (params.action === 'reindex' && !params.file_path) {
      return 'file_path is required for reindex action';
    }

    return null;
  }

  protected createInvocation(
    params: SearchIndexToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<SearchIndexToolParams, ToolResult> {
    return new SearchIndexToolInvocation(
      this.config,
      params,
      messageBus,
      toolName,
      displayName,
    );
  }
}
