/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import {
  getSearchService,
  type SearchServiceManager,
} from '@google/gemini-cli-core';
import type {
  SearchFilters,
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchStats,
} from '@thacio/auditaria-search';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import {
  isRecord,
  readBoolean,
  readNumber,
  readString,
  type ClientMessage,
} from '../protocol.js';

/**
 * The search package is heavy (PGlite, ONNX) and marked external in the
 * bundle, so it is loaded lazily and only when a client actually asks.
 */
type SearchModule = typeof import('@thacio/auditaria-search');
let searchModulePromise: Promise<SearchModule> | null = null;
function loadSearchModule(): Promise<SearchModule> {
  searchModulePromise ??= import('@thacio/auditaria-search');
  return searchModulePromise;
}

/** The subset of a search system the web handlers rely on. */
interface SearchBackend {
  search(options: SearchOptions): Promise<SearchResponse>;
  getStats(): Promise<SearchStats>;
  close(): Promise<void>;
}

/** Storage adapters expose a key/value config; supervisors may not. */
interface ConfigStore {
  getConfigValue(key: string): Promise<unknown>;
  setConfigValue(key: string, value: unknown): Promise<void>;
}

function configStoreOf(system: unknown): ConfigStore | null {
  if (!isRecord(system)) return null;
  const storage = system['storage'];
  if (!isRecord(storage)) return null;
  const getConfigValue = storage['getConfigValue'];
  const setConfigValue = storage['setConfigValue'];
  if (
    typeof getConfigValue !== 'function' ||
    typeof setConfigValue !== 'function'
  ) {
    return null;
  }
  return {
    getConfigValue: (key) =>
      Promise.resolve(getConfigValue.call(storage, key) as unknown),
    setConfigValue: (key, value) =>
      Promise.resolve(setConfigValue.call(storage, key, value)).then(
        () => undefined,
      ),
  };
}

async function readAutoIndexFlag(system: unknown): Promise<boolean> {
  try {
    const value = await configStoreOf(system)?.getConfigValue('autoIndex');
    return value === true;
  } catch {
    return false;
  }
}

/** Stats in the shape the knowledge-base panel renders. */
interface StatsSnapshot {
  totalDocuments: number;
  filesIndexed: number;
  pendingDocuments: number;
  failedDocuments: number;
  ocrPending: number;
  totalPassages: number;
  dbSize: number;
}

function toStatsSnapshot(stats: SearchStats | null | undefined): StatsSnapshot {
  return {
    totalDocuments: stats?.totalDocuments ?? 0,
    filesIndexed: stats?.indexedDocuments ?? 0,
    pendingDocuments: stats?.pendingDocuments ?? 0,
    failedDocuments: stats?.failedDocuments ?? 0,
    ocrPending: stats?.ocrPending ?? 0,
    totalPassages: stats?.totalChunks ?? 0,
    dbSize: stats?.databaseSize ?? 0,
  };
}

async function readStats(
  system: SearchBackend | null,
): Promise<StatsSnapshot | null> {
  if (!system) return null;
  try {
    return toStatsSnapshot(await system.getStats());
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The search engine returns no total count, so a larger batch is fetched
 * and paginated server-side.
 */
const MAX_SEARCH_RESULTS = 200;
const DEFAULT_PAGE_SIZE = 25;

/** Poll cadence for indexing progress while a (re)index is running. */
const PROGRESS_POLL_MS = 5_000;
/** Hard stop for the progress poller, whatever the indexer reports. */
const PROGRESS_POLL_MAX_MS = 30 * 60 * 1000;
/** Delay before the status refresh that follows an init/resume/finish. */
const STATUS_REFRESH_DELAY_MS = 500;

const SEARCH_TYPES = ['keyword', 'semantic', 'hybrid'] as const;
type SearchType = (typeof SEARCH_TYPES)[number];
const DIVERSITY_STRATEGIES = [
  'none',
  'score_penalty',
  'cap_then_fill',
] as const;
type DiversityStrategy = (typeof DIVERSITY_STRATEGIES)[number];

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === 'string',
  );
  return strings.length === value.length ? strings : undefined;
}

/**
 * Knowledge-base panel backend: status, init/resume/reindex controls, the
 * auto-index toggle, and searches (with server-side pagination). Talks to
 * the shared `SearchServiceManager`; when the service is not running but a
 * database exists on disk, a temporary system is opened just for the call.
 */
export class KnowledgeBaseFeature extends WebFeature {
  readonly name = 'knowledge-base';
  private progressPoller: NodeJS.Timeout | null = null;
  private progressPollerDeadline: NodeJS.Timeout | null = null;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();

  protected onAttach(ctx: WebFeatureContext): void {
    const { inbound } = ctx;
    inbound.on('knowledge_base_status_request', () => this.sendStatus());
    inbound.on('knowledge_base_init_request', () => this.init());
    inbound.on('knowledge_base_resume_request', () => this.resume());
    inbound.on('knowledge_base_reindex_request', (message) =>
      this.reindex(readBoolean(message, 'force')),
    );
    inbound.on('knowledge_base_autoindex_request', (message) =>
      this.setAutoIndex(readBoolean(message, 'enabled') === true),
    );
    inbound.on('knowledge_base_search_request', (message) =>
      this.search(message),
    );
  }

  protected onDetach(): void {
    this.stopProgressPolling();
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
  }

  private get workspaceRoot(): string {
    return this.ctx?.workspaceRoot ?? process.cwd();
  }

  private later(fn: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (this.isAttached) fn();
    }, delayMs);
    this.pendingTimers.add(timer);
  }

  // ---------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------

  private async sendStatus(): Promise<void> {
    const service = getSearchService();
    const progress = service.getIndexingProgress();
    // "Running" means the indexing queue processor is online, which is the
    // case after `/knowledge-base init` or when auto-index is enabled.
    const running = service.isIndexingEnabled();
    const system = service.getSearchSystem();

    if (system) {
      this.broadcast('knowledge_base_status', {
        initialized: true,
        running,
        autoIndex: await readAutoIndexFlag(system),
        lastSync: service.getState().lastSyncAt?.toISOString() ?? null,
        stats: await readStats(system),
        indexingProgress: progress,
      });
      return;
    }

    // Service not running: a database on disk still allows searching
    // without an explicit "initialize".
    let databaseExists = false;
    let stats: StatsSnapshot | null = null;
    let autoIndex = false;
    try {
      const search = await loadSearchModule();
      databaseExists = search.searchDatabaseExists(this.workspaceRoot);
      if (databaseExists) {
        const temp = await search.loadSearchSystem(this.workspaceRoot, {
          useMockEmbedder: true, // status only — no embeddings needed
        });
        if (temp) {
          try {
            stats = await readStats(temp);
            autoIndex = await readAutoIndexFlag(temp);
          } finally {
            await temp.close();
          }
        }
      }
    } catch {
      // Module unavailable or database unreadable — report what we know.
    }

    this.broadcast('knowledge_base_status', {
      initialized: databaseExists,
      // Re-check: the service may have started while we were loading.
      running: service.isIndexingEnabled(),
      autoIndex,
      lastSync: null,
      stats,
      indexingProgress: progress,
      databaseExists,
    });
  }

  // ---------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------

  private async init(): Promise<void> {
    const service = getSearchService();
    try {
      await service.start(this.workspaceRoot, { startIndexing: true });
      this.broadcast('knowledge_base_init_response', { success: true });
      this.startProgressPolling(service);
      this.later(() => void this.sendStatus(), STATUS_REFRESH_DELAY_MS);
    } catch (error) {
      this.broadcast('knowledge_base_init_response', {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  /** Same semantics as `/knowledge-base init`: start or enable, then sync. */
  private async resume(): Promise<void> {
    const service = getSearchService();
    try {
      if (!service.isRunning()) {
        await service.start(this.workspaceRoot, { startIndexing: true });
      } else if (!service.isIndexingEnabled()) {
        service.enableIndexing();
      }
      // Background sync — deliberately not awaited.
      service.triggerSync({ force: false }).catch((error: unknown) => {
        this.ctx?.logger.warn('[KB Resume] Sync failed:', errorMessage(error));
      });
      this.broadcast('knowledge_base_resume_response', {
        success: true,
        running: true,
      });
      this.startProgressPolling(service);
      this.later(() => void this.sendStatus(), STATUS_REFRESH_DELAY_MS);
    } catch (error) {
      this.broadcast('knowledge_base_resume_response', {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  private async reindex(force?: boolean): Promise<void> {
    const service = getSearchService();
    try {
      if (!service.isRunning()) {
        await service.start(this.workspaceRoot, { startIndexing: false });
      }
      this.startProgressPolling(service);
      await service.triggerSync({ force: force ?? true });
    } catch (error) {
      this.broadcast('knowledge_base_reindex_progress', {
        status: 'failed',
        error: errorMessage(error),
      });
    }
  }

  private async setAutoIndex(enabled: boolean): Promise<void> {
    const store = configStoreOf(getSearchService().getSearchSystem());
    const fail = (error: string) =>
      this.broadcast('knowledge_base_autoindex_response', {
        success: false,
        error,
      });
    if (!getSearchService().getSearchSystem()) {
      fail('Knowledge base not initialized');
      return;
    }
    if (!store) {
      fail('Storage not available');
      return;
    }
    try {
      await store.setConfigValue('autoIndex', enabled);
      this.broadcast('knowledge_base_autoindex_response', {
        success: true,
        enabled,
      });
    } catch (error) {
      fail(errorMessage(error));
    }
  }

  // ---------------------------------------------------------------------
  // Search
  // ---------------------------------------------------------------------

  private async search(message: ClientMessage): Promise<void> {
    const query = readString(message, 'query') ?? '';
    const respondWithError = (error: string) =>
      this.broadcast('knowledge_base_search_response', {
        error,
        results: [],
        total: 0,
        page: 1,
        totalPages: 0,
      });

    let backend: SearchBackend | null = getSearchService().getSearchSystem();
    let temporary: SearchBackend | null = null;

    if (!backend) {
      try {
        const search = await loadSearchModule();
        if (!search.searchDatabaseExists(this.workspaceRoot)) {
          respondWithError(
            'Knowledge base not found. Please initialize it first.',
          );
          return;
        }
        temporary = await search.loadSearchSystem(this.workspaceRoot, {
          useMockEmbedder: false, // semantic search needs real embeddings
        });
        backend = temporary;
      } catch (error) {
        respondWithError(
          `Failed to load knowledge base: ${errorMessage(error)}`,
        );
        return;
      }
    }
    if (!backend) {
      respondWithError('Knowledge base not available');
      return;
    }

    try {
      const page = Math.max(1, readNumber(message, 'page') ?? 1);
      const limit = Math.max(
        1,
        readNumber(message, 'limit') ?? DEFAULT_PAGE_SIZE,
      );
      const response = await backend.search(
        this.buildSearchOptions(message, query),
      );

      const total = response.results.length;
      const totalPages = Math.ceil(total / limit);
      const startIndex = (page - 1) * limit;
      const endIndex = Math.min(startIndex + limit, total);

      this.broadcast('knowledge_base_search_response', {
        results: response.results
          .slice(startIndex, endIndex)
          .map(formatSearchResult),
        total,
        page,
        totalPages,
        hasMore: endIndex < total,
        query,
      });
    } catch (error) {
      respondWithError(errorMessage(error));
    } finally {
      if (temporary) {
        try {
          await temporary.close();
        } catch {
          // Ignore close errors on the throwaway system.
        }
      }
    }
  }

  private buildSearchOptions(
    message: ClientMessage,
    query: string,
  ): SearchOptions {
    const options: SearchOptions = {
      query,
      strategy:
        oneOf<SearchType>(readString(message, 'searchType'), SEARCH_TYPES) ??
        'hybrid',
      limit: MAX_SEARCH_RESULTS,
      offset: 0, // paginate after fetching
      highlight: true, // <mark> highlighting of matches
      // Google-style syntax for user-facing searches ("phrases", OR, -not).
      useWebSearchSyntax: true,
      diversity: {
        strategy:
          oneOf<DiversityStrategy>(
            readString(message, 'diversityStrategy'),
            DIVERSITY_STRATEGIES,
          ) ?? 'score_penalty',
        decayFactor: readNumber(message, 'diversityDecay') ?? 0.85,
        maxPerDocument: readNumber(message, 'maxPerDocument') ?? 5,
        semanticDedup: readBoolean(message, 'semanticDedup') ?? true,
        semanticDedupThreshold:
          readNumber(message, 'semanticDedupThreshold') ?? 0.97,
      },
    };

    const rawFilters = message['filters'];
    if (isRecord(rawFilters)) {
      const filters: SearchFilters = {};
      const folders = stringList(rawFilters['folders']);
      if (folders && folders.length > 0) filters.folders = folders;
      const extensions = stringList(rawFilters['extensions']);
      if (extensions && extensions.length > 0) {
        filters.fileTypes = extensions.map((ext) =>
          ext.startsWith('.') ? ext : `.${ext}`,
        );
      }
      if (Object.keys(filters).length > 0) options.filters = filters;
    }
    return options;
  }

  // ---------------------------------------------------------------------
  // Progress polling
  // ---------------------------------------------------------------------

  /** One poller at a time; stops on completion, failure, idle, or timeout. */
  private startProgressPolling(service: SearchServiceManager): void {
    if (this.progressPoller) return;

    this.progressPoller = setInterval(() => {
      void this.pollProgress(service);
    }, PROGRESS_POLL_MS);
    this.progressPollerDeadline = setTimeout(() => {
      this.stopProgressPolling();
    }, PROGRESS_POLL_MAX_MS);
  }

  private stopProgressPolling(): void {
    if (this.progressPoller) {
      clearInterval(this.progressPoller);
      this.progressPoller = null;
    }
    if (this.progressPollerDeadline) {
      clearTimeout(this.progressPollerDeadline);
      this.progressPollerDeadline = null;
    }
  }

  private async pollProgress(service: SearchServiceManager): Promise<void> {
    const progress = service.getIndexingProgress();
    const stats = await readStats(service.getSearchSystem());

    this.broadcast('knowledge_base_reindex_progress', {
      status: progress.status,
      totalFiles: progress.totalFiles,
      processedFiles: progress.processedFiles,
      failedFiles: progress.failedFiles,
      currentFile: progress.currentFile,
      stats,
    });

    if (
      progress.status === 'completed' ||
      progress.status === 'failed' ||
      progress.status === 'idle'
    ) {
      this.stopProgressPolling();
      this.later(() => void this.sendStatus(), STATUS_REFRESH_DELAY_MS);
    }
  }
}

function formatSearchResult(result: SearchResult) {
  return {
    filePath: result.filePath || '',
    fileName: result.fileName || '',
    score: result.score || 0,
    chunkText: result.chunkText || '',
    passages: [
      {
        content: result.chunkText || '',
        lineNumber: result.metadata?.page ?? null,
      },
    ],
    // Extra sources merged in by semantic deduplication.
    additionalSources: (result.additionalSources ?? []).map((source) => ({
      filePath: source.filePath,
      fileName: source.fileName,
      documentId: source.documentId,
      score: source.score,
    })),
  };
}
