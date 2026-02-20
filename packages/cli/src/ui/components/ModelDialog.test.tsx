/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { ModelDialog } from './ModelDialog.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { createMockSettings } from '../../test-utils/settings.js';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_3_1_MODEL,
  PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  AuthType,
} from '@google/gemini-cli-core';
import type {
  Config,
  ModelSlashCommandEvent,
  ProviderConfig,
} from '@google/gemini-cli-core';

const {
  mockGetDisplayString,
  mockLogModelSlashCommand,
  mockModelSlashCommandEvent,
} = vi.hoisted(() => ({
  mockGetDisplayString: vi.fn(),
  mockLogModelSlashCommand: vi.fn(),
  mockModelSlashCommandEvent: vi.fn(),
}));

vi.mock('@google/gemini-cli-core', () => {
  const allEfforts = ['low', 'medium', 'high', 'xhigh'] as const;
  const miniEfforts = ['low', 'medium', 'high'] as const;
  const getSupportedCodexReasoningEfforts = (
    model?: string,
  ): ReadonlyArray<(typeof allEfforts)[number]> =>
    model === 'gpt-5.1-codex-mini' ? miniEfforts : allEfforts;
  const clampCodexReasoningEffortForModel = (
    model: string | undefined,
    effort: (typeof allEfforts)[number],
  ) => {
    const supported = getSupportedCodexReasoningEfforts(model);
    if (supported.includes(effort)) return effort;
    return supported[supported.length - 1];
  };

  return {
    PREVIEW_GEMINI_MODEL: 'gemini-3-pro',
    PREVIEW_GEMINI_FLASH_MODEL: 'gemini-3-flash',
    PREVIEW_GEMINI_MODEL_AUTO: 'auto-gemini-3',
    DEFAULT_GEMINI_MODEL: 'gemini-2.5-pro',
    DEFAULT_GEMINI_FLASH_MODEL: 'gemini-2.5-flash',
    DEFAULT_GEMINI_FLASH_LITE_MODEL: 'gemini-2.5-flash-lite',
    DEFAULT_GEMINI_MODEL_AUTO: 'auto-gemini-2.5',
    CODEX_REASONING_EFFORTS: allEfforts,
    getSupportedCodexReasoningEfforts,
    clampCodexReasoningEffortForModel,
    getDisplayString: (val: string) => mockGetDisplayString(val),
    logModelSlashCommand: (config: Config, event: ModelSlashCommandEvent) =>
      mockLogModelSlashCommand(config, event),
    ModelSlashCommandEvent: class {
      constructor(model: string) {
        mockModelSlashCommandEvent(model);
      }
    },
  };
});

describe('<ModelDialog />', () => {
  const mockSetModel = vi.fn();
  const mockGetModel = vi.fn();
  const mockOnClose = vi.fn();
  const mockGetHasAccessToPreviewModel = vi.fn();
  const mockSetProviderConfig = vi.fn();
  const mockClearProviderConfig = vi.fn();
  const mockGetDisplayModel = vi.fn();
  const mockGetProviderConfig = vi.fn();
  const mockGetWorkingDir = vi.fn();
  const mockGetGemini31LaunchedSync = vi.fn();

  interface MockConfig extends Partial<Config> {
    setModel: (model: string, isTemporary?: boolean) => void;
    getModel: () => string;
    getHasAccessToPreviewModel: () => boolean;
    setProviderConfig: (
      providerConfig: ProviderConfig,
      isTemporary?: boolean,
    ) => void;
    clearProviderConfig: (isTemporary?: boolean) => void;
    getDisplayModel: () => string;
    getProviderConfig: () => ProviderConfig | undefined;
    getWorkingDir: () => string;
    getIdeMode: () => boolean;
    getGemini31LaunchedSync: () => boolean;
  }

  const mockConfig: MockConfig = {
    setModel: mockSetModel,
    getModel: mockGetModel,
    getHasAccessToPreviewModel: mockGetHasAccessToPreviewModel,
    setProviderConfig: mockSetProviderConfig,
    clearProviderConfig: mockClearProviderConfig,
    getDisplayModel: mockGetDisplayModel,
    getProviderConfig: mockGetProviderConfig,
    getWorkingDir: mockGetWorkingDir,
    getIdeMode: () => false,
    getGemini31LaunchedSync: mockGetGemini31LaunchedSync,
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetModel.mockReturnValue(DEFAULT_GEMINI_MODEL_AUTO);
    mockGetHasAccessToPreviewModel.mockReturnValue(false);
    mockGetDisplayModel.mockReturnValue('gemini-2.5-pro');
    mockGetProviderConfig.mockReturnValue(undefined);
    mockGetWorkingDir.mockReturnValue('C:/projects/auditaria');
    mockGetGemini31LaunchedSync.mockReturnValue(false);

    // Default implementation for getDisplayString
    mockGetDisplayString.mockImplementation((val: string) => {
      if (val === 'auto-gemini-2.5') return 'Auto (Gemini 2.5)';
      if (val === 'auto-gemini-3') return 'Auto (Preview)';
      return val;
    });
  });

  const renderComponent = async (
    configValue = mockConfig as Config,
    authType = AuthType.LOGIN_WITH_GOOGLE,
  ) => {
    const settings = createMockSettings({
      security: {
        auth: {
          selectedType: authType,
        },
      },
    });

    const result = renderWithProviders(<ModelDialog onClose={mockOnClose} />, {
      config: configValue,
      settings,
    });
    await result.waitUntilReady();
    return result;
  };

  const waitForUpdate = () =>
    new Promise((resolve) => setTimeout(resolve, 150));
  const downArrow = '\u001B[B';
  const rightArrow = '\u001B[C';

  const openCodexView = async (
    stdin: Awaited<ReturnType<typeof renderComponent>>['stdin'],
  ) => {
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write('\r');
    await waitForUpdate();
  };

  it('renders the initial "main" view correctly', async () => {
    const { lastFrame, unmount } = await renderComponent();
    expect(lastFrame()).toContain('Select Model');
    expect(lastFrame()).toContain('Remember model for future sessions: true');
    expect(lastFrame()).toContain('Auto');
    expect(lastFrame()).toContain('Manual');
    unmount();
  });

  it('switches to "manual" view when "Manual" is selected and uses getDisplayString for models', async () => {
    mockGetDisplayString.mockImplementation((val: string) => {
      if (val === DEFAULT_GEMINI_MODEL) return 'Formatted Pro Model';
      if (val === DEFAULT_GEMINI_FLASH_MODEL) return 'Formatted Flash Model';
      if (val === DEFAULT_GEMINI_FLASH_LITE_MODEL)
        return 'Formatted Lite Model';
      return val;
    });

    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderComponent();

    // Select "Manual" (index 1)
    // Press down arrow to move to "Manual"
    await act(async () => {
      stdin.write('\u001B[B'); // Arrow Down
    });
    await waitUntilReady();

    // Press enter to select
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    // Should now show manual options
    await waitFor(() => {
      const output = lastFrame();
      expect(output).toContain('Formatted Pro Model');
      expect(output).toContain('Formatted Flash Model');
      expect(output).toContain('Formatted Lite Model');
    });
    unmount();
  });

  it('sets model and closes when a model is selected in "main" view', async () => {
    const { stdin, waitUntilReady, unmount } = await renderComponent();

    // Select "Auto" (index 0)
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(mockSetModel).toHaveBeenCalledWith(
        DEFAULT_GEMINI_MODEL_AUTO,
        true, // Session only by default
      );
      expect(mockOnClose).toHaveBeenCalled();
    });
    unmount();
  });

  it('sets model and closes when a model is selected in "manual" view', async () => {
    const { stdin, waitUntilReady, unmount } = await renderComponent();

    // Navigate to Manual (index 1) and select
    await act(async () => {
      stdin.write('\u001B[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    // Now in manual view. Default selection is first item (DEFAULT_GEMINI_MODEL)
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(mockSetModel).toHaveBeenCalledWith(DEFAULT_GEMINI_MODEL, true);
      expect(mockOnClose).toHaveBeenCalled();
    });
    unmount();
  });

  it('toggles persist mode with Tab key', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderComponent();

    expect(lastFrame()).toContain('Remember model for future sessions: true');

    // Press Tab to toggle persist mode
    await act(async () => {
      stdin.write('\t');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(lastFrame()).toContain(
        'Remember model for future sessions: false',
      );
    });

    // Select "Auto" (index 0)
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(mockSetModel).toHaveBeenCalledWith(
        DEFAULT_GEMINI_MODEL_AUTO,
        false, // Persist enabled
      );
      expect(mockClearProviderConfig).toHaveBeenCalledWith(false);
      expect(mockOnClose).toHaveBeenCalled();
    });
    unmount();
  });

  it('closes dialog on escape in "main" view', async () => {
    const { stdin, waitUntilReady, unmount } = await renderComponent();

    await act(async () => {
      stdin.write('\u001B'); // Escape
    });
    // Escape key has a 50ms timeout in KeypressContext, so we need to wrap waitUntilReady in act
    await act(async () => {
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(mockOnClose).toHaveBeenCalled();
    });
    unmount();
  });

  it('goes back to "main" view on escape in "manual" view', async () => {
    const { lastFrame, stdin, waitUntilReady, unmount } =
      await renderComponent();

    // Go to manual view
    await act(async () => {
      stdin.write('\u001B[B');
    });
    await waitUntilReady();
    await act(async () => {
      stdin.write('\r');
    });
    await waitUntilReady();

    await waitFor(() => {
      expect(lastFrame()).toContain(DEFAULT_GEMINI_MODEL);
    });

    // Press Escape
    await act(async () => {
      stdin.write('\u001B');
    });
    await act(async () => {
      await waitUntilReady();
    });

    await waitFor(() => {
      expect(mockOnClose).not.toHaveBeenCalled();
      // Should be back to main view (Manual option visible)
      expect(lastFrame()).toContain('Manual');
    });
    unmount();
  });

  it('shows Codex thinking bars inline and updates intensity with arrows', async () => {
    const { lastFrame, stdin } = await renderComponent();

    await openCodexView(stdin);

    expect(lastFrame()).toContain('Select OpenAI Codex Model');
    expect(lastFrame()).toContain('||||');
    expect(lastFrame()).toContain('Thinking intensity: Extra High');

    stdin.write(rightArrow);
    await waitForUpdate();

    expect(lastFrame()).toContain('Thinking intensity: Low');
  });

  it('clamps Codex thinking to model-supported max for gpt-5.1-codex-mini', async () => {
    const { lastFrame, stdin } = await renderComponent();

    await openCodexView(stdin);
    expect(lastFrame()).toContain('Thinking intensity: Extra High');

    // Move highlight to GPT-5.1 Codex Mini (index 4 in codex submenu).
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write(downArrow);
    await waitForUpdate();

    expect(lastFrame()).toContain('Thinking intensity: High');
    expect(lastFrame()).toContain('Supported range: Low - High');

    stdin.write('\r');
    await waitForUpdate();

    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      {
        type: 'codex-cli',
        model: 'gpt-5.1-codex-mini',
        cwd: 'C:/projects/auditaria',
        options: {
          reasoningEffort: 'high',
        },
      },
      true,
    );
  });

  it('applies selected Codex thinking intensity to provider config', async () => {
    const { stdin } = await renderComponent();

    await openCodexView(stdin);

    stdin.write(rightArrow); // Medium -> High
    await waitForUpdate();

    stdin.write('\r'); // Select "Auto"
    await waitForUpdate();

    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      {
        type: 'codex-cli',
        model: undefined,
        cwd: 'C:/projects/auditaria',
        options: {
          reasoningEffort: 'low',
        },
      },
      true,
    );
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('persists Codex provider selection when persist mode is enabled', async () => {
    const { stdin } = await renderComponent();

    await openCodexView(stdin);
    stdin.write('\t'); // Enable persist mode
    await waitForUpdate();
    stdin.write('\r'); // Select "Auto"
    await waitForUpdate();

    expect(mockSetProviderConfig).toHaveBeenCalledWith(
      {
        type: 'codex-cli',
        model: undefined,
        cwd: 'C:/projects/auditaria',
        options: {
          reasoningEffort: 'xhigh',
        },
      },
      false,
    );
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('shows the preferred manual model in the main view option using getDisplayString', async () => {
    mockGetModel.mockReturnValue(DEFAULT_GEMINI_MODEL);
    mockGetDisplayString.mockImplementation((val: string) => {
      if (val === DEFAULT_GEMINI_MODEL) return 'My Custom Model Display';
      if (val === 'auto-gemini-2.5') return 'Auto (Gemini 2.5)';
      return val;
    });
    const { lastFrame, unmount } = await renderComponent();

    expect(lastFrame()).toContain('Manual (My Custom Model Display)');
    unmount();
  });

  describe('Preview Models', () => {
    beforeEach(() => {
      mockGetHasAccessToPreviewModel.mockReturnValue(true);
    });

    it('shows Auto (Preview) in main view when access is granted', async () => {
      const { lastFrame, unmount } = await renderComponent();
      expect(lastFrame()).toContain('Auto (Preview)');
      unmount();
    });

    it('shows Gemini 3 models in manual view when Gemini 3.1 is NOT launched', async () => {
      mockGetGemini31LaunchedSync.mockReturnValue(false);
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderComponent();

      // Go to manual view
      await act(async () => {
        stdin.write('\u001B[B'); // Manual
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('\r');
      });
      await waitUntilReady();

      const output = lastFrame();
      expect(output).toContain(PREVIEW_GEMINI_MODEL);
      expect(output).toContain(PREVIEW_GEMINI_FLASH_MODEL);
      unmount();
    });

    it('shows Gemini 3.1 models in manual view when Gemini 3.1 IS launched', async () => {
      mockGetGemini31LaunchedSync.mockReturnValue(true);
      const { lastFrame, stdin, waitUntilReady, unmount } =
        await renderComponent(mockConfig as Config, AuthType.USE_VERTEX_AI);

      // Go to manual view
      await act(async () => {
        stdin.write('\u001B[B'); // Manual
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('\r');
      });
      await waitUntilReady();

      const output = lastFrame();
      expect(output).toContain(PREVIEW_GEMINI_3_1_MODEL);
      expect(output).toContain(PREVIEW_GEMINI_FLASH_MODEL);
      unmount();
    });

    it('uses custom tools model when Gemini 3.1 IS launched and auth is Gemini API Key', async () => {
      mockGetGemini31LaunchedSync.mockReturnValue(true);
      const { stdin, waitUntilReady, unmount } = await renderComponent(
        mockConfig as Config,
        AuthType.USE_GEMINI,
      );

      // Go to manual view
      await act(async () => {
        stdin.write('\u001B[B'); // Manual
      });
      await waitUntilReady();
      await act(async () => {
        stdin.write('\r');
      });
      await waitUntilReady();

      // Select Gemini 3.1 (first item in preview section)
      await act(async () => {
        stdin.write('\r');
      });
      await waitUntilReady();

      await waitFor(() => {
        expect(mockSetModel).toHaveBeenCalledWith(
          PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL,
          true,
        );
      });
      unmount();
    });
  });
});
