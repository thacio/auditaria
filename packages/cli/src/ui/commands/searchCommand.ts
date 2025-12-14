/**
 * Search Commands - Local document search functionality.
 * Provides commands for initializing, searching, and managing the search index.
 *
 * AUDITARIA_FEATURE: Local Search System
 */

import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import { getSearchService } from '@google/gemini-cli-core';

// ============================================================================
// Lazy Loading
// ============================================================================

// Lazy load the search module to avoid loading it on startup
let searchModule: typeof import('@thacio/search') | null = null;

async function getSearchModule(): Promise<typeof import('@thacio/search')> {
  if (!searchModule) {
    searchModule = await import('@thacio/search');
  }
  return searchModule;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getProjectRoot(context: CommandContext): string {
  return context.services.config?.getProjectRoot() ?? process.cwd();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Get the search system from the singleton if running, otherwise load temporarily.
 * Returns { system, closeAfter } where closeAfter indicates if caller should close.
 */
async function getSearchSystemSafe(rootPath: string): Promise<{
  system: NonNullable<
    Awaited<ReturnType<typeof import('@thacio/search').loadSearchSystem>>
  >;
  closeAfter: boolean;
} | null> {
  const search = await getSearchModule();
  const searchService = getSearchService();

  // Check if index exists
  if (!search.searchDatabaseExists(rootPath)) {
    return null;
  }

  // Use the singleton if running
  const singletonSystem = searchService.getSearchSystem();
  if (singletonSystem) {
    return { system: singletonSystem, closeAfter: false };
  }

  // Load a temporary system
  const loadedSystem = await search.loadSearchSystem(rootPath, {
    useMockEmbedder: false,
  });
  if (!loadedSystem) {
    return null;
  }

  return { system: loadedSystem, closeAfter: true };
}

// ============================================================================
// /search-init Command
// ============================================================================

const searchInitCommand: SlashCommand = {
  name: 'search-init',
  description: 'Initialize or update the local document search index',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args) => {
    const rootPath = getProjectRoot(context);
    const force = args.includes('--force');

    context.ui.setPendingItem({
      type: MessageType.INFO,
      text: 'Initializing search index...',
    });

    try {
      const search = await getSearchModule();
      const searchService = getSearchService();

      // Check if index already exists
      const exists = search.searchDatabaseExists(rootPath);

      // Use the singleton SearchServiceManager instead of creating a new SearchSystem
      // This prevents database lock conflicts when the service is already running
      if (searchService.isRunning()) {
        // Service is already running, just trigger a sync
        context.ui.setPendingItem({
          type: MessageType.INFO,
          text: 'Search service running, syncing files...',
        });

        await searchService.triggerSync({ force });

        const progress = searchService.getIndexingProgress();
        context.ui.setPendingItem(null);

        return {
          type: 'message',
          messageType: 'info',
          content:
            `Search index synced:\n` +
            `  Files processed: ${progress.processedFiles}\n` +
            `  Files failed: ${progress.failedFiles}`,
        };
      }

      // Service not running, start it
      context.ui.setPendingItem({
        type: MessageType.INFO,
        text: exists
          ? 'Loading search service...'
          : 'Initializing new search index...',
      });

      await searchService.start(rootPath, { forceReindex: force });

      // Get the search system from the service
      const system = searchService.getSearchSystem();
      if (!system) {
        context.ui.setPendingItem(null);
        return {
          type: 'message',
          messageType: 'error',
          content: 'Failed to initialize search system',
        };
      }

      // Discover files to show count
      context.ui.setPendingItem({
        type: MessageType.INFO,
        text: 'Discovering files...',
      });

      const files = await system.discoverFiles();

      if (files.length === 0) {
        context.ui.setPendingItem(null);
        return {
          type: 'message',
          messageType: 'info',
          content: 'No indexable files found in the project.',
        };
      }

      context.ui.setPendingItem({
        type: MessageType.INFO,
        text: `Indexing ${files.length} files...`,
      });

      // Trigger sync which handles indexing
      await searchService.triggerSync({ force });

      const progress = searchService.getIndexingProgress();
      context.ui.setPendingItem(null);

      return {
        type: 'message',
        messageType: 'info',
        content:
          `Search index ${exists ? 'updated' : 'created'}:\n` +
          `  Files discovered: ${files.length}\n` +
          `  Files processed: ${progress.processedFiles}\n` +
          `  Files failed: ${progress.failedFiles}`,
      };
    } catch (error) {
      context.ui.setPendingItem(null);
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to initialize search: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================================
// /search Command
// ============================================================================

const searchCommand: SlashCommand = {
  name: 'search',
  description: 'Search indexed documents',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args) => {
    if (!args.trim()) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /search <query> [--type=<pdf|docx|...>] [--limit=<n>]',
      };
    }

    const rootPath = getProjectRoot(context);

    // Parse arguments
    const typeMatch = args.match(/--type=(\S+)/);
    const limitMatch = args.match(/--limit=(\d+)/);
    const strategyMatch = args.match(/--strategy=(keyword|semantic|hybrid)/);

    const fileType = typeMatch?.[1];
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : 10;
    const strategy =
      (strategyMatch?.[1] as 'keyword' | 'semantic' | 'hybrid') ?? 'hybrid';

    // Remove flags from query
    const query = args
      .replace(/--type=\S+/g, '')
      .replace(/--limit=\d+/g, '')
      .replace(/--strategy=\S+/g, '')
      .trim();

    if (!query) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Please provide a search query',
      };
    }

    try {
      const search = await getSearchModule();
      const searchService = getSearchService();

      // Check if index exists
      if (!search.searchDatabaseExists(rootPath)) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Search index not found. Run /search-init first.',
        };
      }

      // Use the singleton if running, otherwise load a temporary system
      let system = searchService.getSearchSystem();
      const closeAfter = !system;

      if (!system) {
        system = await search.loadSearchSystem(rootPath, {
          useMockEmbedder: false,
        });
      }

      if (!system) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Failed to load search system',
        };
      }

      // Build search options
      const response = await system.search({
        query,
        strategy,
        limit,
        filters: fileType ? { fileTypes: [`.${fileType}`] } : undefined,
        highlight: true,
      });

      // Only close if we created a temporary system
      if (closeAfter) {
        await system.close();
      }

      if (response.results.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: `No results found for "${query}"`,
        };
      }

      // Format results
      const lines = [
        `Found ${response.total} results for "${query}" (${response.took}ms):`,
        '',
      ];

      for (let i = 0; i < response.results.length; i++) {
        const r = response.results[i];
        const snippet = r.chunkText.slice(0, 150).replace(/\n/g, ' ');
        lines.push(`${i + 1}. ${r.filePath} (score: ${r.score.toFixed(3)})`);
        lines.push(`   ${snippet}...`);
        if (r.metadata.page) {
          lines.push(`   Page: ${r.metadata.page}`);
        }
        lines.push('');
      }

      return {
        type: 'message',
        messageType: 'info',
        content: lines.join('\n'),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================================
// /search-status Command
// ============================================================================

const searchStatusCommand: SlashCommand = {
  name: 'search-status',
  description: 'Show search index status and statistics',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (context) => {
    const rootPath = getProjectRoot(context);

    try {
      const search = await getSearchModule();
      const searchService = getSearchService();

      // Check if index exists
      if (!search.searchDatabaseExists(rootPath)) {
        return {
          type: 'message',
          messageType: 'info',
          content:
            'Search index not initialized. Run /search-init to create one.',
        };
      }

      // Use the singleton if running, otherwise load a temporary system
      let system = searchService.getSearchSystem();
      const closeAfter = !system;

      if (!system) {
        system = await search.loadSearchSystem(rootPath, {
          useMockEmbedder: false,
        });
      }

      if (!system) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Failed to load search system',
        };
      }

      const stats = await system.getStats();
      const state = system.getState();
      const serviceState = searchService.getState();

      // Only close if we created a temporary system
      if (closeAfter) {
        await system.close();
      }

      const lines = [
        'Search Index Status:',
        '',
        `  Database: ${state.databasePath}`,
        `  Size: ${formatBytes(stats.databaseSize)}`,
        `  Service: ${serviceState.status}`,
        '',
        'Documents:',
        `  Total: ${stats.totalDocuments}`,
        `  Indexed: ${stats.indexedDocuments}`,
        `  Pending: ${stats.pendingDocuments}`,
        `  Failed: ${stats.failedDocuments}`,
        `  OCR Pending: ${stats.ocrPending}`,
        '',
        `Total Chunks: ${stats.totalChunks}`,
        `Tags: ${stats.totalTags}`,
      ];

      return {
        type: 'message',
        messageType: 'info',
        content: lines.join('\n'),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to get status: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================================
// /search-tag Command
// ============================================================================

const searchTagCommand: SlashCommand = {
  name: 'search-tag',
  description: 'Manage document tags',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    {
      name: 'add',
      description:
        'Add tags to a document: /search-tag add <file> <tag1> [tag2...]',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const parts = args.trim().split(/\s+/);
        if (parts.length < 2) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Usage: /search-tag add <file> <tag1> [tag2...]',
          };
        }

        const filePath = parts[0];
        const tags = parts.slice(1);
        const rootPath = getProjectRoot(context);

        try {
          const result = await getSearchSystemSafe(rootPath);
          if (!result) {
            return {
              type: 'message',
              messageType: 'error',
              content: 'Search index not initialized. Run /search-init first.',
            };
          }

          const { system, closeAfter } = result;
          await system.addTags(filePath, tags);

          if (closeAfter) {
            await system.close();
          }

          return {
            type: 'message',
            messageType: 'info',
            content: `Added tags [${tags.join(', ')}] to ${filePath}`,
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: `Failed to add tags: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      name: 'remove',
      description:
        'Remove tags from a document: /search-tag remove <file> <tag1> [tag2...]',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const parts = args.trim().split(/\s+/);
        if (parts.length < 2) {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Usage: /search-tag remove <file> <tag1> [tag2...]',
          };
        }

        const filePath = parts[0];
        const tags = parts.slice(1);
        const rootPath = getProjectRoot(context);

        try {
          const result = await getSearchSystemSafe(rootPath);
          if (!result) {
            return {
              type: 'message',
              messageType: 'error',
              content: 'Search index not initialized.',
            };
          }

          const { system, closeAfter } = result;
          await system.removeTags(filePath, tags);

          if (closeAfter) {
            await system.close();
          }

          return {
            type: 'message',
            messageType: 'info',
            content: `Removed tags [${tags.join(', ')}] from ${filePath}`,
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: `Failed to remove tags: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
    {
      name: 'list',
      description:
        'List all tags or tags for a specific file: /search-tag list [file]',
      kind: CommandKind.BUILT_IN,
      action: async (context, args) => {
        const filePath = args.trim() || null;
        const rootPath = getProjectRoot(context);

        try {
          const result = await getSearchSystemSafe(rootPath);
          if (!result) {
            return {
              type: 'message',
              messageType: 'error',
              content: 'Search index not initialized.',
            };
          }

          const { system, closeAfter } = result;

          if (filePath) {
            // List tags for specific file
            const tags = await system.getFileTags(filePath);

            if (closeAfter) {
              await system.close();
            }

            if (tags.length === 0) {
              return {
                type: 'message',
                messageType: 'info',
                content: `No tags for ${filePath}`,
              };
            }

            return {
              type: 'message',
              messageType: 'info',
              content: `Tags for ${filePath}:\n  ${tags.join(', ')}`,
            };
          } else {
            // List all tags with counts
            const tags = await system.getAllTags();

            if (closeAfter) {
              await system.close();
            }

            if (tags.length === 0) {
              return {
                type: 'message',
                messageType: 'info',
                content: 'No tags found in index',
              };
            }

            const lines = ['All tags:', ''];
            for (const t of tags) {
              lines.push(`  ${t.tag} (${t.count} documents)`);
            }

            return {
              type: 'message',
              messageType: 'info',
              content: lines.join('\n'),
            };
          }
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: `Failed to list tags: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      },
    },
  ],
  action: async () => ({
    type: 'message',
    messageType: 'info',
    content:
      'Available subcommands: /search-tag add, /search-tag remove, /search-tag list',
  }),
};

// ============================================================================
// Export
// ============================================================================

export {
  searchInitCommand,
  searchCommand,
  searchStatusCommand,
  searchTagCommand,
};
