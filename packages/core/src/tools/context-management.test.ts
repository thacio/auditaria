/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { ContextManagementTool } from './context-management.js';

describe('provider-owned context', () => {
  it('does not expose host context mutations through the external tool bridge', () => {
    expect(ContextManagementTool.Bridgeable).toBe(false);
  });
  it.each(['inspect', 'forget', 'restore'] as const)(
    'does not mutate or inspect the mirror for %s',
    async (action) => {
      const getGeminiClient = vi.fn();
      const getProviderManager = vi.fn();
      const config = {
        getProviderConfig: () => ({ type: 'claude-cli' }),
        getGeminiClient,
        getProviderManager,
      } as unknown as Config;
      const tool = new ContextManagementTool(config, {} as MessageBus);
      const result = await tool
        .build({
          action,
          items: [{ id: 'tool-1', description: 'summary' }],
          ids: ['tool-1'],
        })
        .execute({ abortSignal: new AbortController().signal });
      expect(result.llmContent).toContain(
        'Claude Code manages its own context',
      );
      expect(getGeminiClient).not.toHaveBeenCalled();
      expect(getProviderManager).not.toHaveBeenCalled();
    },
  );
});
