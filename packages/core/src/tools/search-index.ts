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

// ============================================
// IndexingManager - Singleton for Background Indexing
// ============================================

interface IndexingProgress {
  status: 'idle' | 'discovering' | 'indexing' | 'completed' | 'failed';
  totalFiles: number;
  indexed: number;
  failed: number;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
}

/**
 * Singleton manager for background indexing operations.
 * Keeps the search system alive during indexing and tracks progress.
 */
class IndexingManager {
  private static instance: IndexingManager;
  private searchSystem: unknown = null;
  private progress: IndexingProgress = {
    status: 'idle',
    totalFiles: 0,
    indexed: 0,
    failed: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
  };
  private unsubscribers: Array<() => void> = [];

  static getInstance(): IndexingManager {
    if (!IndexingManager.instance) {
      IndexingManager.instance = new IndexingManager();
    }
    return IndexingManager.instance;
  }

  isIndexing(): boolean {
    return (
      this.progress.status === 'discovering' ||
      this.progress.status === 'indexing'
    );
  }

  getProgress(): IndexingProgress {
    return { ...this.progress };
  }

  /**
   * Start background indexing. Returns immediately with initial stats.
   */
  async startBackgroundIndexing(
    rootPath: string,
    force: boolean = false,
  ): Promise<{
    started: boolean;
    totalFiles: number;
    message: string;
  }> {
    if (this.isIndexing()) {
      return {
        started: false,
        totalFiles: this.progress.totalFiles,
        message: `Indexing already in progress: ${this.progress.indexed}/${this.progress.totalFiles} files processed`,
      };
    }

    // Reset progress
    this.progress = {
      status: 'discovering',
      totalFiles: 0,
      indexed: 0,
      failed: 0,
      startedAt: new Date(),
      completedAt: null,
      lastError: null,
    };

    try {
      const { initializeSearchSystem, loadSearchSystem, searchDatabaseExists } =
        await import('@thacio/search');

      const indexExists = searchDatabaseExists(rootPath);

      if (indexExists && !force) {
        this.searchSystem = await loadSearchSystem(rootPath, {
          useMockEmbedder: false,
        });
        if (!this.searchSystem) {
          this.searchSystem = await initializeSearchSystem({
            rootPath,
            useMockEmbedder: false,
          });
        }
      } else {
        this.searchSystem = await initializeSearchSystem({
          rootPath,
          useMockEmbedder: false,
        });
      }

      // Type assertion for the search system
      const system = this.searchSystem as {
        discoverFiles: () => Promise<unknown[]>;
        indexAll: (opts: { force?: boolean }) => Promise<{
          indexed: number;
          failed: number;
          duration: number;
        }>;
        on: (
          event: string,
          handler: (data: { current: number; total: number }) => void,
        ) => () => void;
        close: () => Promise<void>;
      };

      // Discover files (quick operation)
      const files = await system.discoverFiles();
      this.progress.totalFiles = files.length;
      this.progress.status = 'indexing';

      if (files.length === 0) {
        this.progress.status = 'completed';
        this.progress.completedAt = new Date();
        await this.cleanup();
        return {
          started: true,
          totalFiles: 0,
          message: 'No files to index. Index is up to date.',
        };
      }

      // Subscribe to progress events
      const unsubProgress = system.on(
        'indexing:progress',
        (event: { current: number; total: number }) => {
          // Update based on total processed (success + failed)
          const processed = event.current;
          // We don't know exact split, but we can estimate
          this.progress.indexed = processed;
        },
      );
      this.unsubscribers.push(unsubProgress);

      // Start indexing in background (don't await!)
      system
        .indexAll({ force })
        .then(async (result) => {
          this.progress.status = 'completed';
          this.progress.indexed = result.indexed;
          this.progress.failed = result.failed;
          this.progress.completedAt = new Date();
          await this.cleanup();
        })
        .catch(async (error: Error) => {
          this.progress.status = 'failed';
          this.progress.lastError = error.message;
          this.progress.completedAt = new Date();
          await this.cleanup();
        });

      return {
        started: true,
        totalFiles: files.length,
        message: `Started indexing ${files.length} files in background`,
      };
    } catch (error) {
      this.progress.status = 'failed';
      this.progress.lastError =
        error instanceof Error ? error.message : String(error);
      this.progress.completedAt = new Date();
      await this.cleanup();
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    // Unsubscribe from events
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Close search system
    if (this.searchSystem) {
      const system = this.searchSystem as { close: () => Promise<void> };
      await system.close();
      this.searchSystem = null;
    }
  }
}

/**
 * Get the IndexingManager singleton instance.
 * Exported for use by status checks and other tools.
 */
export function getIndexingManager(): IndexingManager {
  return IndexingManager.getInstance();
}

// ============================================
// Tool Parameters and Description
// ============================================

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
    const manager = IndexingManager.getInstance();

    try {
      updateOutput?.(
        this.params.force
          ? 'Starting full index rebuild...'
          : 'Starting search index initialization...',
      );

      const result = await manager.startBackgroundIndexing(
        rootPath,
        this.params.force,
      );

      if (!result.started) {
        // Indexing already in progress
        const progress = manager.getProgress();
        let llmContent = `**Indexing Already in Progress**\n\n`;
        llmContent += `- Status: ${progress.status}\n`;
        llmContent += `- Progress: ${progress.indexed}/${progress.totalFiles} files\n`;
        if (progress.startedAt) {
          const elapsed = Math.round(
            (Date.now() - progress.startedAt.getTime()) / 1000,
          );
          llmContent += `- Elapsed: ${elapsed}s\n`;
        }
        llmContent += `\nUse action "status" to check progress.`;

        return {
          llmContent,
          returnDisplay: result.message,
        };
      }

      // Indexing started successfully in background
      let llmContent = `**Indexing Started in Background**\n\n`;
      llmContent += `- Files to index: ${result.totalFiles}\n`;
      llmContent += `- Mode: ${this.params.force ? 'Full rebuild' : 'Incremental update'}\n\n`;
      llmContent += `Indexing is running in the background. Use action "status" to check progress.\n`;
      llmContent += `You can continue using search while indexing is in progress (results may be incomplete).`;

      return {
        llmContent,
        returnDisplay: result.message,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        llmContent: `Failed to start indexing: ${errorMessage}`,
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
    const manager = IndexingManager.getInstance();
    const indexingProgress = manager.getProgress();

    // Check if background indexing is active
    const isIndexing = manager.isIndexing();

    try {
      const { loadSearchSystem, searchDatabaseExists } = await import(
        '@thacio/search'
      );

      // If indexing is in progress, show that status first
      if (isIndexing) {
        let llmContent = `**Background Indexing in Progress**\n\n`;
        llmContent += `- Status: ${indexingProgress.status}\n`;
        llmContent += `- Progress: ${indexingProgress.indexed}/${indexingProgress.totalFiles} files\n`;
        if (indexingProgress.startedAt) {
          const elapsed = Math.round(
            (Date.now() - indexingProgress.startedAt.getTime()) / 1000,
          );
          llmContent += `- Elapsed: ${elapsed}s\n`;
        }
        llmContent += `\nSearch is available but results may be incomplete until indexing finishes.`;

        return {
          llmContent,
          returnDisplay: `Indexing: ${indexingProgress.indexed}/${indexingProgress.totalFiles} files (${indexingProgress.status})`,
        };
      }

      // Show recent indexing completion if applicable
      let recentIndexingInfo = '';
      if (
        indexingProgress.status === 'completed' &&
        indexingProgress.completedAt
      ) {
        const completedAgo = Math.round(
          (Date.now() - indexingProgress.completedAt.getTime()) / 1000,
        );
        if (completedAgo < 300) {
          // Show for 5 minutes after completion
          recentIndexingInfo = `**Recent Indexing Completed**\n`;
          recentIndexingInfo += `- Indexed: ${indexingProgress.indexed} files\n`;
          recentIndexingInfo += `- Failed: ${indexingProgress.failed} files\n`;
          recentIndexingInfo += `- Completed: ${completedAgo}s ago\n\n`;
        }
      } else if (
        indexingProgress.status === 'failed' &&
        indexingProgress.lastError
      ) {
        recentIndexingInfo = `**Recent Indexing Failed**\n`;
        recentIndexingInfo += `- Error: ${indexingProgress.lastError}\n\n`;
      }

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

        let llmContent = recentIndexingInfo;
        llmContent += `**Search Index Status**\n\n`;
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
