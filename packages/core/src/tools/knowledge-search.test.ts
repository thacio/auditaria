/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { KnowledgeSearchTool } from './knowledge-search.js';

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../services/search-service.js', () => ({
  SearchServiceManager: {
    getInstance: () => ({
      isRunning: () => true,
      getSearchSystem: () => ({
        getConfig: () => ({
          search: { defaultLimit: 3, defaultStrategy: 'keyword' },
        }),
        search,
      }),
    }),
  },
}));

beforeEach(() => {
  search.mockReset().mockResolvedValue({ results: [], total: 0, took: 1 });
});

it('uses configured search defaults including pagination', async () => {
  const tool = new KnowledgeSearchTool({} as Config, {} as MessageBus);
  await tool
    .build({ query: 'audit', offset: 2 })
    .execute({ abortSignal: new AbortController().signal });
  expect(search).toHaveBeenCalledWith(
    expect.objectContaining({ query: 'audit', strategy: 'keyword', limit: 5 }),
  );
});

it('lets explicit tool arguments override configured defaults', async () => {
  const tool = new KnowledgeSearchTool({} as Config, {} as MessageBus);
  await tool
    .build({ query: 'audit', strategy: 'semantic', limit: 7 })
    .execute({ abortSignal: new AbortController().signal });
  expect(search).toHaveBeenCalledWith(
    expect.objectContaining({ query: 'audit', strategy: 'semantic', limit: 7 }),
  );
});
