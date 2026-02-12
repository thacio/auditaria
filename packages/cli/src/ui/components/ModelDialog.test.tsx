/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModelDialog } from './ModelDialog.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
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
  ): readonly (typeof allEfforts)[number][] =>
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
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetModel.mockReturnValue(DEFAULT_GEMINI_MODEL_AUTO);
    mockGetHasAccessToPreviewModel.mockReturnValue(false);
    mockGetDisplayModel.mockReturnValue('gemini-2.5-pro');
    mockGetProviderConfig.mockReturnValue(undefined);
    mockGetWorkingDir.mockReturnValue('C:/projects/auditaria');

    // Default implementation for getDisplayString
    mockGetDisplayString.mockImplementation((val: string) => {
      if (val === 'auto-gemini-2.5') return 'Auto (Gemini 2.5)';
      if (val === 'auto-gemini-3') return 'Auto (Preview)';
      return val;
    });
  });

  const renderComponent = (contextValue = mockConfig as Config) =>
    render(
      <KeypressProvider>
        <ConfigContext.Provider value={contextValue}>
          <ModelDialog onClose={mockOnClose} />
        </ConfigContext.Provider>
      </KeypressProvider>,
    );

  const waitForUpdate = () =>
    new Promise((resolve) => setTimeout(resolve, 150));
  const downArrow = '\u001B[B';
  const rightArrow = '\u001B[C';

  const openCodexView = async (
    stdin: ReturnType<typeof renderComponent>['stdin'],
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

  it('renders the initial "main" view correctly', () => {
    const { lastFrame } = renderComponent();
    expect(lastFrame()).toContain('Select Model');
    expect(lastFrame()).toContain('Remember model for future sessions: true');
    expect(lastFrame()).toContain('Auto');
    expect(lastFrame()).toContain('Manual');
  });

  it('switches to "manual" view when "Manual" is selected', async () => {
    const { lastFrame, stdin } = renderComponent();

    // Select "Manual" (index 1)
    // Press down arrow to move to "Manual"
    stdin.write(downArrow); // Arrow Down
    await waitForUpdate();

    // Press enter to select
    stdin.write('\r');
    await waitForUpdate();

    // Should now show manual options
    expect(lastFrame()).toContain(DEFAULT_GEMINI_MODEL);
    expect(lastFrame()).toContain(DEFAULT_GEMINI_FLASH_MODEL);
    expect(lastFrame()).toContain(DEFAULT_GEMINI_FLASH_LITE_MODEL);
  });

  it('sets model and closes when a model is selected in "main" view', async () => {
    const { stdin } = renderComponent();

    // Select "Auto" (index 0)
    stdin.write('\r');
    await waitForUpdate();

    expect(mockSetModel).toHaveBeenCalledWith(
      DEFAULT_GEMINI_MODEL_AUTO,
      true, // Session only by default
    );
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('sets model and closes when a model is selected in "manual" view', async () => {
    const { stdin } = renderComponent();

    // Navigate to Manual (index 1) and select
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write('\r');
    await waitForUpdate();

    // Now in manual view. Default selection is first item (DEFAULT_GEMINI_MODEL)
    stdin.write('\r');
    await waitForUpdate();

    expect(mockSetModel).toHaveBeenCalledWith(DEFAULT_GEMINI_MODEL, true);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('toggles persist mode with Tab key', async () => {
    const { lastFrame, stdin } = renderComponent();

    expect(lastFrame()).toContain('Remember model for future sessions: true');

    // Press Tab to toggle persist mode
    stdin.write('\t');
    await waitForUpdate();

    expect(lastFrame()).toContain('Remember model for future sessions: false');

    // Select "Auto" (index 0)
    stdin.write('\r');
    await waitForUpdate();

    expect(mockSetModel).toHaveBeenCalledWith(
      DEFAULT_GEMINI_MODEL_AUTO,
      false, // Persist enabled
    );
    expect(mockClearProviderConfig).toHaveBeenCalledWith(false);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('closes dialog on escape in "main" view', async () => {
    const { stdin } = renderComponent();

    stdin.write('\u001B'); // Escape
    await waitForUpdate();

    expect(mockOnClose).toHaveBeenCalled();
  });

  it('goes back to "main" view on escape in "manual" view', async () => {
    const { lastFrame, stdin } = renderComponent();

    // Go to manual view
    stdin.write(downArrow);
    await waitForUpdate();
    stdin.write('\r');
    await waitForUpdate();

    expect(lastFrame()).toContain(DEFAULT_GEMINI_MODEL);

    // Press Escape
    stdin.write('\u001B');
    await waitForUpdate();

    expect(mockOnClose).not.toHaveBeenCalled();
    // Should be back to main view (Manual option visible)
    expect(lastFrame()).toContain('Manual');
  });

  it('shows Codex thinking bars inline and updates intensity with arrows', async () => {
    const { lastFrame, stdin } = renderComponent();

    await openCodexView(stdin);

    expect(lastFrame()).toContain('Select OpenAI Codex Model');
    expect(lastFrame()).toContain('||||');
    expect(lastFrame()).toContain('Thinking intensity: Extra High');

    stdin.write(rightArrow);
    await waitForUpdate();

    expect(lastFrame()).toContain('Thinking intensity: Low');
  });

  it('clamps Codex thinking to model-supported max for gpt-5.1-codex-mini', async () => {
    const { lastFrame, stdin } = renderComponent();

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

    expect(mockSetProviderConfig).toHaveBeenCalledWith({
      type: 'codex-cli',
      model: 'gpt-5.1-codex-mini',
      cwd: 'C:/projects/auditaria',
      options: {
        reasoningEffort: 'high',
      },
    }, true);
  });

  it('applies selected Codex thinking intensity to provider config', async () => {
    const { stdin } = renderComponent();

    await openCodexView(stdin);

    stdin.write(rightArrow); // Medium -> High
    await waitForUpdate();

    stdin.write('\r'); // Select "Auto"
    await waitForUpdate();

    expect(mockSetProviderConfig).toHaveBeenCalledWith({
      type: 'codex-cli',
      model: undefined,
      cwd: 'C:/projects/auditaria',
      options: {
        reasoningEffort: 'low',
      },
    }, true);
    expect(mockOnClose).toHaveBeenCalled();
  });

  it('persists Codex provider selection when persist mode is enabled', async () => {
    const { stdin } = renderComponent();

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
});
