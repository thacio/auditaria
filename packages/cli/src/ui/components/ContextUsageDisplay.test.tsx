/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { describe, it, expect, vi } from 'vitest';
import { makeFakeConfig } from '@google/gemini-cli-core';

vi.mock('@google/gemini-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/gemini-cli-core')>();
  return {
    ...actual,
    tokenLimit: () => 10000,
  };
});

describe('ContextUsageDisplay', () => {
  it.each(['estimated', 'unknown', 'reported'] as const)(
    'labels provider usage as %s',
    async (source) => {
      const config = makeFakeConfig();
      vi.spyOn(config, 'getProviderConfig').mockReturnValue({
        type: 'codex-cli',
      });
      vi.spyOn(config, 'getProviderManager').mockReturnValue({
        getContextUsageSource: () => source,
      } as unknown as ReturnType<typeof config.getProviderManager>);
      const { lastFrame, unmount } = await renderWithProviders(
        <ContextUsageDisplay
          promptTokenCount={5000}
          model="codex"
          terminalWidth={120}
        />,
        { config },
      );
      expect(lastFrame()).toContain(
        source === 'estimated'
          ? '~50% used (estimate)'
          : source === 'unknown'
            ? 'provider managed'
            : '50% used',
      );
      unmount();
    },
  );
  it('renders correct percentage used', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={5000}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('50% used');
    unmount();
  });

  it('renders correctly when usage is 0%', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={0}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('0% used');
    unmount();
  });

  it('renders abbreviated label when terminal width is small', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={2000}
        model="gemini-pro"
        terminalWidth={80}
      />,
      { width: 80 },
    );
    const output = lastFrame();
    expect(output).toContain('20%');
    expect(output).not.toContain('context used');
    unmount();
  });

  it('renders 80% correctly', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={8000}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('80% used');
    unmount();
  });

  it('renders 100% when full', async () => {
    const { lastFrame, unmount } = await renderWithProviders(
      <ContextUsageDisplay
        promptTokenCount={10000}
        model="gemini-pro"
        terminalWidth={120}
      />,
    );
    const output = lastFrame();
    expect(output).toContain('100% used');
    unmount();
  });
});
