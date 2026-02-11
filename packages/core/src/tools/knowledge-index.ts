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
import { KNOWLEDGE_INDEX_TOOL_NAME } from './tool-names.js';
import {
  SearchServiceManager,
  type IndexingProgress,
} from '../services/search-service.js';

// ============================================================================
// Tool Parameters and Description
// ============================================================================

/**
 * Parameters for the KnowledgeIndex tool
 */
export interface KnowledgeIndexToolParams {
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

const KNOWLEDGE_INDEX_DESCRIPTION = `Manage the knowledge base index.

This tool manages the knowledge base index for the project. Available actions:

- **init**: Initialize or update the knowledge base. Discovers all indexable files, parses them, generates embeddings, and stores them for fast searching. Use 'force: true' to rebuild the entire index from scratch.

- **status**: Get the current status of the knowledge base including:
  - Total documents indexed
  - Pending documents in queue
  - OCR status (if available)
  - Index size and health

- **reindex**: Reindex a specific file. Useful when a file was updated but not picked up by the watcher. Requires 'file_path' parameter.

The knowledge base stores document chunks with vector embeddings for semantic search and full-text indexes for keyword search.

**Supported file types:** PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, TXT, MD, HTML, images (with OCR), and more.
`;

class KnowledgeIndexToolInvocation extends BaseToolInvocation<
  KnowledgeIndexToolParams,
  ToolResult
> {
  constructor(
    private config: Config,
    params: KnowledgeIndexToolParams,
    messageBus: MessageBus,
    toolName?: string,
    displayName?: string,
  ) {
    super(params, messageBus, toolName, displayName);
  }

  getDescription(): string {
    switch (this.params.action) {
      case 'init':
        return this.params.force
          ? 'Rebuilding knowledge base'
          : 'Initializing knowledge base';
      case 'status':
        return 'Checking knowledge base status';
      case 'reindex':
        return `Reindexing ${this.params.file_path ?? 'file'}`;
      default:
        return 'Managing knowledge base';
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
    const service = SearchServiceManager.getInstance();

    try {
      updateOutput?.(
        this.params.force
          ? 'Starting full knowledge base rebuild...'
          : 'Starting knowledge base initialization...',
      );

      if (service.isRunning()) {
        // Service already running - trigger sync if force, else return status
        if (this.params.force) {
          updateOutput?.('Service running, triggering full sync...');
          await service.triggerSync({ force: true });
        }

        const progress = service.getIndexingProgress();
        return this.formatProgressResult(progress, 'Service is running');
      }

      // Start the service
      await service.start(rootPath, {
        forceReindex: this.params.force,
      });

      const progress = service.getIndexingProgress();
      let llmContent = `**Knowledge Base Service Started**\n\n`;
      llmContent += `- Status: ${progress.status}\n`;
      llmContent += `- Files discovered: ${progress.totalFiles}\n`;
      llmContent += `- Mode: ${this.params.force ? 'Full rebuild' : 'Incremental update'}\n\n`;

      if (progress.status === 'indexing') {
        llmContent += `Indexing is running in the background. Use action "status" to check progress.\n`;
        llmContent += `You can continue using search while indexing is in progress (results may be incomplete).`;
      } else if (progress.status === 'completed') {
        llmContent += `Indexing completed: ${progress.processedFiles} files indexed, ${progress.failedFiles} failed.`;
      }

      return {
        llmContent,
        returnDisplay: `Search service started (${progress.totalFiles} files)`,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to start knowledge base service: ${errorMessage}`,
        returnDisplay: `Initialization error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.EXECUTION_FAILED,
        },
      };
    }
  }

  private formatProgressResult(
    progress: IndexingProgress,
    context: string,
  ): ToolResult {
    let llmContent = `**${context}**\n\n`;
    llmContent += `- Status: ${progress.status}\n`;
    llmContent += `- Progress: ${progress.processedFiles}/${progress.totalFiles} files\n`;
    if (progress.failedFiles > 0) {
      llmContent += `- Failed: ${progress.failedFiles} files\n`;
    }
    if (progress.startedAt) {
      const elapsed = Math.round(
        (Date.now() - progress.startedAt.getTime()) / 1000,
      );
      llmContent += `- Elapsed: ${elapsed}s\n`;
    }
    if (progress.status === 'indexing') {
      llmContent += `\nSearch is available but results may be incomplete until indexing finishes.`;
    }

    return {
      llmContent,
      returnDisplay: `${progress.status}: ${progress.processedFiles}/${progress.totalFiles} files`,
    };
  }

  private async executeStatus(): Promise<ToolResult> {
    const rootPath = this.config.getTargetDir();
    const service = SearchServiceManager.getInstance();

    // Check if service is running
    if (service.isRunning()) {
      const progress = service.getIndexingProgress();

      // If indexing is in progress, show that
      if (
        progress.status === 'indexing' ||
        progress.status === 'syncing' ||
        progress.status === 'discovering'
      ) {
        return this.formatProgressResult(
          progress,
          'Background Indexing in Progress',
        );
      }

      // Get stats from search system
      const searchSystem = service.getSearchSystem();
      if (searchSystem) {
        try {
          const stats = await searchSystem.getStats();
          const systemState = searchSystem.getState();
          const queueStatus = await searchSystem.getQueueStatus();
          const ocrStatus = searchSystem.getOcrQueueStatus();

          let llmContent = '';

          // Show recent completion if applicable
          if (progress.status === 'completed' && progress.completedAt) {
            const completedAgo = Math.round(
              (Date.now() - progress.completedAt.getTime()) / 1000,
            );
            if (completedAgo < 300) {
              llmContent += `**Recent Indexing Completed**\n`;
              llmContent += `- Indexed: ${progress.processedFiles} files\n`;
              llmContent += `- Failed: ${progress.failedFiles} files\n`;
              llmContent += `- Completed: ${completedAgo}s ago\n\n`;
            }
          }

          llmContent += `**Knowledge Base Status**\n\n`;
          llmContent += `- Root path: ${systemState.rootPath}\n`;
          llmContent += `- Database: ${systemState.databasePath}\n`;
          llmContent += `- Service running: Yes\n\n`;

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

          if (systemState.ocrAvailable && ocrStatus) {
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
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            llmContent: `Failed to get knowledge base status: ${errorMessage}`,
            returnDisplay: `Status error: ${errorMessage}`,
            error: {
              message: errorMessage,
              type: ToolErrorType.EXECUTION_FAILED,
            },
          };
        }
      }
    }

    // Service not running - check if database exists
    try {
      const { searchDatabaseExists } = await import('@thacio/auditaria-search');

      if (!searchDatabaseExists(rootPath)) {
        return {
          llmContent:
            'Knowledge base not found. Use knowledge_index with action "init" to create it.',
          returnDisplay: 'Knowledge base not initialized',
        };
      }

      // Database exists but service not running
      return {
        llmContent:
          'Knowledge base exists but service is not running. Use action "init" to start the knowledge base service.',
        returnDisplay: 'Knowledge base service not running',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to check knowledge base: ${errorMessage}`,
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

    const service = SearchServiceManager.getInstance();

    if (!service.isRunning()) {
      const msg =
        'Search service not running. Initialize it first using action "init".';
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
      const success = await service.reindexFile(file_path);

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
 * Tool for managing the knowledge base index
 */
export class KnowledgeIndexTool extends BaseDeclarativeTool<
  KnowledgeIndexToolParams,
  ToolResult
> {
  static readonly Name = KNOWLEDGE_INDEX_TOOL_NAME;
  static readonly Bridgeable = true; // AUDITARIA_CLAUDE_PROVIDER: auto-bridge to external providers via MCP

  constructor(
    private readonly config: Config,
    messageBus: MessageBus,
  ) {
    super(
      KnowledgeIndexTool.Name,
      'KnowledgeIndex',
      KNOWLEDGE_INDEX_DESCRIPTION,
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
      messageBus,
      true,
      false,
    );
  }

  protected override validateToolParamValues(
    params: KnowledgeIndexToolParams,
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
    params: KnowledgeIndexToolParams,
    messageBus?: MessageBus,
    toolName?: string,
    displayName?: string,
  ): ToolInvocation<KnowledgeIndexToolParams, ToolResult> {
    return new KnowledgeIndexToolInvocation(
      this.config,
      params,
      messageBus ?? this.messageBus,
      toolName,
      displayName,
    );
  }
}

// ============================================================================
// Exported Functions for External Use
// ============================================================================

/**
 * Get the SearchServiceManager singleton instance.
 * Exported for use by other tools and the app initializer.
 */
export function getSearchServiceManager(): SearchServiceManager {
  return SearchServiceManager.getInstance();
}
