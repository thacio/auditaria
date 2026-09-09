/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { coreEvents, externalSessionProviders } from '@google/gemini-cli-core';
import type { ReactElement } from 'react';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { resumeClaudeCommand } from './resumeClaudeCommand.js';
import { resumeCodexCommand } from './resumeCodexCommand.js';

vi.mock('../components/ExternalSessionPicker.js', () => ({
  ExternalSessionPicker: () => null,
}));

describe.each([
  ['claude', resumeClaudeCommand],
  ['codex', resumeCodexCommand],
] as const)('resume-%s', (provider, command) => {
  const adapter = externalSessionProviders[provider];
  const session = {
    sessionId: '11111111-2222-3333-4444-555555555555',
    filePath: '/session.jsonl',
    firstPrompt: 'Hello',
    timestamp: new Date(),
    fileSize: 1000,
  };
  const history = [
    { role: 'user', parts: [{ text: 'Hello' }] },
    { role: 'model', parts: [{ text: 'Hi' }] },
  ];
  const pm = {
    isTurnActive: vi.fn(() => false),
    setPendingResumeSessionId: vi.fn(),
  };
  const context = () =>
    createMockCommandContext({
      ui: { removeComponent: vi.fn() },
      services: {
        agentContext: {
          config: {
            getProviderConfig: vi.fn(() => ({ type: adapter.type })),
            getProviderManager: vi.fn(() => pm),
            getTargetDir: vi.fn(() => '/project'),
            initFileCheckpointManager: vi.fn(),
          },
          geminiClient: { setHistory: vi.fn() },
        },
      },
    });
  beforeEach(() => {
    pm.isTurnActive.mockReturnValue(false);
    vi.spyOn(adapter, 'validate').mockResolvedValue({
      valid: true,
      filePath: session.filePath,
    });
    vi.spyOn(adapter, 'list').mockResolvedValue([session]);
    vi.spyOn(adapter, 'load').mockResolvedValue(history);
    vi.spyOn(coreEvents, 'emitFeedback').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('restores the same native conversation to client and UI, then queues resume', async () => {
    const ctx = context();
    await command.action!(ctx, session.sessionId);
    expect(
      ctx.services.agentContext!.geminiClient.setHistory,
    ).toHaveBeenCalledWith(history);
    expect(pm.setPendingResumeSessionId).toHaveBeenCalledWith(
      session.sessionId,
    );
    expect(ctx.ui.loadHistory).toHaveBeenCalledWith([
      { type: 'user', id: 1, text: 'Hello' },
      { type: 'gemini', id: 2, text: 'Hi' },
    ]);
  });
  it('rejects a different active provider before looking up a session', async () => {
    const ctx = context();
    vi.mocked(
      ctx.services.agentContext!.config.getProviderConfig,
    ).mockReturnValue({
      type: provider === 'claude' ? 'codex-cli' : 'claude-cli',
    });
    expect(await command.action!(ctx, session.sessionId)).toMatchObject({
      messageType: 'error',
    });
    expect(adapter.validate).not.toHaveBeenCalled();
    expect(pm.setPendingResumeSessionId).not.toHaveBeenCalled();
  });
  it('blocks resume during a turn, including activity from the provider terminal', async () => {
    pm.isTurnActive.mockReturnValue(true);
    expect(await command.action!(context(), '')).toMatchObject({
      messageType: 'error',
    });
    expect(adapter.list).not.toHaveBeenCalled();
  });
  it.each([[], null])(
    'preserves the current chat when history is empty or unreadable: %s',
    async (result) => {
      if (result === null)
        vi.mocked(adapter.load).mockRejectedValue(new Error('Read failed'));
      else vi.mocked(adapter.load).mockResolvedValue(result);
      const ctx = context();
      await command.action!(ctx, session.sessionId);
      expect(pm.setPendingResumeSessionId).not.toHaveBeenCalled();
      expect(
        ctx.services.agentContext!.geminiClient.setHistory,
      ).not.toHaveBeenCalled();
      expect(ctx.ui.loadHistory).not.toHaveBeenCalled();
      expect(coreEvents.emitFeedback).toHaveBeenCalledWith(
        'error',
        expect.any(String),
      );
    },
  );
  it('treats short invalid IDs as lookup errors instead of silently opening the picker', async () => {
    vi.mocked(adapter.validate).mockResolvedValue({
      valid: false,
      filePath: '',
    });
    expect(await command.action!(context(), 'bad-id')).toMatchObject({
      messageType: 'error',
    });
    expect(adapter.list).not.toHaveBeenCalled();
  });
  it('opens a provider-labelled picker and resumes its selected session', async () => {
    const ctx = context();
    const result = await command.action!(ctx, 'list');
    expect(result?.type).toBe('custom_dialog');
    if (result?.type !== 'custom_dialog') throw new Error('Expected picker');
    const element = result.component as ReactElement<{
      providerName: string;
      onSelect: (s: typeof session) => Promise<void>;
    }>;
    expect(element.props.providerName).toBe(adapter.name);
    await element.props.onSelect(session);
    expect(ctx.ui.removeComponent).toHaveBeenCalled();
    expect(pm.setPendingResumeSessionId).toHaveBeenCalledWith(
      session.sessionId,
    );
  });
  it('rechecks the provider after an asynchronous load', async () => {
    const ctx = context();
    vi.mocked(adapter.load).mockImplementation(async () => {
      vi.mocked(
        ctx.services.agentContext!.config.getProviderConfig,
      ).mockReturnValue({ type: 'gemini' });
      return history;
    });
    await command.action!(ctx, session.sessionId);
    expect(pm.setPendingResumeSessionId).not.toHaveBeenCalled();
  });
});
