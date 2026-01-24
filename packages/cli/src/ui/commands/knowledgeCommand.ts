/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Knowledge Base Commands - Local document search functionality.
 * Provides commands for initializing, searching, and managing the knowledge base.
 *
 * AUDITARIA_FEATURE: Local Knowledge Base System
 */

import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import {
  getSearchService,
  SearchResponseFormatter,
  type SearchResultInput,
} from '@google/gemini-cli-core';

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

// ============================================================================
// Default Action - Show Usage
// ============================================================================

async function showUsageAction() {
  return {
    type: 'message' as const,
    messageType: 'info' as const,
    content: `Usage: /knowledge-base <command>

Commands:
  init [--force]        Initialize or update the knowledge base
  search <query>        Search the knowledge base
  status                Show knowledge base status and statistics
  set-autoindex on|off  Configure auto-indexing on CLI startup

Alias: /kb`,
  };
}

// ============================================================================
// init Subcommand
// ============================================================================

const initSubCommand: SlashCommand = {
  name: 'init',
  description: 'Initialize or update the knowledge base',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (context, args) => {
    const rootPath = getProjectRoot(context);
    const force = args.includes('--force');

    context.ui.setPendingItem({
      type: MessageType.INFO,
      text: 'Initializing knowledge base...',
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
          text: 'Knowledge base service running, syncing files...',
        });

        await searchService.triggerSync({ force });

        const progress = searchService.getIndexingProgress();
        context.ui.setPendingItem(null);

        return {
          type: 'message',
          messageType: 'info',
          content:
            `Knowledge base synced:\n` +
            `  Files processed: ${progress.processedFiles}\n` +
            `  Files failed: ${progress.failedFiles}`,
        };
      }

      // Service not running, start it with startIndexing: true for session-only indexing
      context.ui.setPendingItem({
        type: MessageType.INFO,
        text: exists
          ? 'Loading knowledge base service...'
          : 'Initializing new knowledge base...',
      });

      await searchService.start(rootPath, {
        forceReindex: force,
        startIndexing: true,
      });

      // Get the search system from the service
      const system = searchService.getSearchSystem();
      if (!system) {
        context.ui.setPendingItem(null);
        return {
          type: 'message',
          messageType: 'error',
          content: 'Failed to initialize knowledge base',
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
          `Knowledge base ${exists ? 'updated' : 'created'}:\n` +
          `  Files discovered: ${files.length}\n` +
          `  Files processed: ${progress.processedFiles}\n` +
          `  Files failed: ${progress.failedFiles}`,
      };
    } catch (error) {
      context.ui.setPendingItem(null);
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to initialize knowledge base: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================================
// search Subcommand
// ============================================================================

const searchSubCommand: SlashCommand = {
  name: 'search',
  description: 'Search the knowledge base',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  completion: (_context, partialArg) => {
    const flags = [
      '--strategy=keyword',
      '--strategy=semantic',
      '--strategy=hybrid',
      '--type=pdf',
      '--type=docx',
      '--type=txt',
      '--type=md',
      '--type=json',
      '--limit=',
    ];
    // If partialArg starts with '--', suggest matching flags
    if (partialArg.startsWith('--')) {
      return flags.filter((f) => f.startsWith(partialArg));
    }
    // If partialArg is empty or doesn't start with '-', suggest all flags
    if (!partialArg || !partialArg.startsWith('-')) {
      return flags;
    }
    return [];
  },
  action: async (context, args) => {
    if (!args.trim()) {
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /knowledge-base search <query> [--strategy=<keyword|semantic|hybrid>] [--type=<pdf|docx|...>] [--limit=<n>]',
      };
    }

    const rootPath = getProjectRoot(context);

    // Parse arguments
    const typeMatch = args.match(/--type=(\S+)/);
    const limitMatch = args.match(/--limit=(\d+)/);
    const strategyMatch = args.match(/--strategy=(keyword|semantic|hybrid)/);

    const fileType = typeMatch?.[1];
    const limit = limitMatch ? parseInt(limitMatch[1], 10) : 20;
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
          content: 'Knowledge base not found. Run /knowledge-base init first.',
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
          content: 'Failed to load knowledge base',
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

      // Transform results to SearchResultInput format for the formatter
      const formatterResults: SearchResultInput[] = response.results.map(
        (r) => ({
          documentId: r.documentId ?? r.filePath,
          chunkId: r.chunkId ?? `${r.filePath}#${r.metadata?.page ?? 0}`,
          filePath: r.filePath,
          fileName: r.filePath.split(/[/\\]/).pop() ?? r.filePath,
          chunkText: r.chunkText,
          score: r.score,
          matchType:
            (r.matchType as 'semantic' | 'keyword' | 'hybrid') ?? 'hybrid',
          highlights: r.highlights ?? [],
          metadata: {
            page: r.metadata?.page ?? null,
            section: r.metadata?.section ?? null,
          },
        }),
      );

      // Use SearchResponseFormatter with markdown format and summary detail
      const formatter = new SearchResponseFormatter({
        format: 'markdown',
        detail: 'summary',
        groupByDocument: true,
      });

      const formatted = formatter.format(
        formatterResults,
        query,
        response.took,
        {
          offset: 0,
          limit,
          totalAvailable: response.total,
        },
      );

      return {
        type: 'message',
        messageType: 'info',
        content: formatted.llmContent,
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
// status Subcommand
// ============================================================================

const statusSubCommand: SlashCommand = {
  name: 'status',
  description: 'Show knowledge base status and statistics',
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
            'Knowledge base not initialized. Run /knowledge-base init to create one.',
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
          content: 'Failed to load knowledge base',
        };
      }

      const stats = await system.getStats();
      const state = system.getState();
      const serviceState = searchService.getState();

      // Get autoIndex config
      let autoIndexEnabled = false;
      try {
        const storage = (
          system as unknown as {
            storage: { getConfigValue: <T>(key: string) => Promise<T | null> };
          }
        ).storage;
        if (storage && typeof storage.getConfigValue === 'function') {
          const value = await storage.getConfigValue<boolean>('autoIndex');
          autoIndexEnabled = value === true;
        }
      } catch {
        // Ignore errors reading config
      }

      // Only close if we created a temporary system
      if (closeAfter) {
        await system.close();
      }

      const lines = [
        'Knowledge Base Status:',
        '',
        `  Database: ${state.databasePath}`,
        `  Size: ${formatBytes(stats.databaseSize)}`,
        `  Service: ${serviceState.status}`,
        `  Auto-index on startup: ${autoIndexEnabled ? 'ON' : 'OFF'}`,
        '',
        'Documents:',
        `  Total: ${stats.totalDocuments}`,
        `  Indexed: ${stats.indexedDocuments}`,
        `  Pending: ${stats.pendingDocuments}`,
        `  Failed: ${stats.failedDocuments}`,
        `  OCR Pending: ${stats.ocrPending}`,
        '',
        `Total Chunks: ${stats.totalChunks}`,
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
// set-autoindex Subcommand
// ============================================================================

const setAutoindexSubCommand: SlashCommand = {
  name: 'set-autoindex',
  description:
    'Configure auto-indexing on CLI startup (does not start indexing now)',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  completion: (_context, _partialArg) => ['on', 'off'],
  action: async (context, args) => {
    const value = args.trim().toLowerCase();
    if (value !== 'on' && value !== 'off') {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Usage: /knowledge-base set-autoindex on|off',
      };
    }

    const rootPath = getProjectRoot(context);

    try {
      const search = await getSearchModule();
      const searchService = getSearchService();

      // Check if database exists
      if (!search.searchDatabaseExists(rootPath)) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Knowledge base not found. Run /knowledge-base init first.',
        };
      }

      // Use the singleton if running, otherwise load a temporary system
      let system = searchService.getSearchSystem();
      const closeAfter = !system;

      if (!system) {
        system = await search.loadSearchSystem(rootPath, {
          useMockEmbedder: true, // Don't need real embeddings just to set config
        });
      }

      if (!system) {
        return {
          type: 'message',
          messageType: 'error',
          content: 'Failed to load knowledge base',
        };
      }

      // Access storage to save config
      const storage = (
        system as unknown as {
          storage: {
            setConfigValue: <T>(key: string, value: T) => Promise<void>;
          };
        }
      ).storage;

      if (storage && typeof storage.setConfigValue === 'function') {
        await storage.setConfigValue('autoIndex', value === 'on');
      } else {
        throw new Error('Storage does not support config values');
      }

      // Only close if we created a temporary system
      if (closeAfter) {
        await system.close();
      }

      return {
        type: 'message',
        messageType: 'info',
        content:
          `Auto-indexing on startup: ${value.toUpperCase()}\n` +
          (value === 'on'
            ? 'Run /knowledge-base init to start indexing now.'
            : 'Use /knowledge-base init to manually start indexing when needed.'),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to set auto-index: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

// ============================================================================
// Main Command with Subcommands
// ============================================================================

export const knowledgeBaseCommand: SlashCommand = {
  name: 'knowledge-base',
  altNames: ['kb'],
  description: 'Manage the local knowledge base for document search',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  subCommands: [
    initSubCommand,
    searchSubCommand,
    statusSubCommand,
    setAutoindexSubCommand,
  ],
  action: showUsageAction,
};
