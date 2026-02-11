/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { knowledgeBaseCommand } from './knowledgeCommand.js';
import type { CommandContext } from './types.js';

const mockGetSearchService = vi.hoisted(() => vi.fn());
const mockSearchDatabaseExists = vi.hoisted(() => vi.fn());
const mockLoadSearchSystem = vi.hoisted(() => vi.fn());

vi.mock('@google/gemini-cli-core', () => ({
  getSearchService: mockGetSearchService,
  SearchResponseFormatter: class MockSearchResponseFormatter {
    format() {
      return { llmContent: '' };
    }
  },
}));

vi.mock('@thacio/auditaria-cli-search', () => ({
  searchDatabaseExists: mockSearchDatabaseExists,
  loadSearchSystem: mockLoadSearchSystem,
}));

describe('knowledgeBaseCommand status', () => {
  const statusSubCommand = knowledgeBaseCommand.subCommands?.find(
    (cmd) => cmd.name === 'status',
  );
  const createStatusContext = (rootPath = '/test/root'): CommandContext =>
    ({
      services: {
        config: {
          getProjectRoot: vi.fn().mockReturnValue(rootPath),
        },
      },
      ui: {
        setPendingItem: vi.fn(),
      },
    }) as unknown as CommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders detailed status with queue precision and deferred reasons', async () => {
    if (!statusSubCommand?.action) {
      throw new Error('status subcommand not found');
    }

    const context = createStatusContext('/test/root');

    const mockSystem = {
      getStats: vi.fn().mockResolvedValue({
        totalDocuments: 20,
        totalChunks: 320,
        indexedDocuments: 15,
        pendingDocuments: 3,
        failedDocuments: 2,
        ocrPending: 1,
        totalTags: 0,
        databaseSize: 123456,
      }),
      getQueueDetailedStatus: vi.fn().mockResolvedValue({
        total: 9,
        pending: 4,
        processing: 1,
        completed: 3,
        failed: 1,
        byPriority: {
          text: 1,
          markup: 1,
          pdf: 0,
          image: 0,
          ocr: 0,
          deferred: 2,
        },
        precision: 'exact',
        deferredByReason: {
          raw_text_oversize: 1,
          raw_markup_oversize: 0,
          parsed_text_oversize: 1,
          unknown: 0,
        },
      }),
      getState: vi.fn().mockReturnValue({
        databasePath: '/test/root/.auditaria/knowledge-base.db',
      }),
      getConfig: vi.fn().mockReturnValue({
        database: { backend: 'libsql' },
      }),
      getOcrQueueStatus: vi.fn().mockReturnValue({
        pendingJobs: 2,
        processingJobs: 1,
        completedJobs: 7,
        failedJobs: 0,
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockSearchDatabaseExists.mockReturnValue(true);
    mockGetSearchService.mockReturnValue({
      getSearchSystem: vi.fn().mockReturnValue(mockSystem),
      getState: vi.fn().mockReturnValue({ status: 'running' }),
    });

    const result = await statusSubCommand.action(context, '');
    if (!result || result.type !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    expect(result.content).toContain('Backend: libsql');
    expect(result.content).toContain('Tracked total: 20');
    expect(result.content).toContain("Pending (documents.status='pending'): 3");
    expect(result.content).toContain('Queue total: 9');
    expect(result.content).toContain('Precision: EXACT');
    expect(result.content).toContain('Deferred by reason: raw_text_oversize=1');
    expect(result.content).toContain('parsed_text_oversize=1');
    expect(result.content).toContain("Fully indexed = documents with status 'indexed'");
  });

  it('loads temporary system when service is not running and closes it after status', async () => {
    if (!statusSubCommand?.action) {
      throw new Error('status subcommand not found');
    }

    const context = createStatusContext('/test/root');

    const tempSystem = {
      getStats: vi.fn().mockResolvedValue({
        totalDocuments: 0,
        totalChunks: 0,
        indexedDocuments: 0,
        pendingDocuments: 0,
        failedDocuments: 0,
        ocrPending: 0,
        totalTags: 0,
        databaseSize: 0,
      }),
      getQueueDetailedStatus: vi.fn().mockResolvedValue({
        total: 0,
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        byPriority: {
          text: 0,
          markup: 0,
          pdf: 0,
          image: 0,
          ocr: 0,
          deferred: 0,
        },
        precision: 'exact',
        deferredByReason: {
          raw_text_oversize: 0,
          raw_markup_oversize: 0,
          parsed_text_oversize: 0,
          unknown: 0,
        },
      }),
      getState: vi.fn().mockReturnValue({
        databasePath: '/test/root/.auditaria/knowledge-base.db',
      }),
      getConfig: vi.fn().mockReturnValue({
        database: { backend: 'sqlite' },
      }),
      getOcrQueueStatus: vi.fn().mockReturnValue(null),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockSearchDatabaseExists.mockReturnValue(true);
    mockLoadSearchSystem.mockResolvedValue(tempSystem);
    mockGetSearchService.mockReturnValue({
      getSearchSystem: vi.fn().mockReturnValue(null),
      getState: vi.fn().mockReturnValue({ status: 'stopped' }),
    });

    const result = await statusSubCommand.action(context, '');
    if (!result || result.type !== 'message') {
      throw new Error('Expected message result');
    }

    expect(result.type).toBe('message');
    expect(result.messageType).toBe('info');
    expect(result.content).toContain('Backend: sqlite');
    expect(mockLoadSearchSystem).toHaveBeenCalledWith('/test/root', {
      useMockEmbedder: false,
    });
    expect(tempSystem.close).toHaveBeenCalledTimes(1);
  });
});
