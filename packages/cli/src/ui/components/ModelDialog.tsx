/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  PREVIEW_GEMINI_MODEL,
  PREVIEW_GEMINI_FLASH_MODEL,
  PREVIEW_GEMINI_MODEL_AUTO,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  getDisplayString,
  type ProviderConfig, // AUDITARIA_CLAUDE_PROVIDER
  type CodexReasoningEffort, // AUDITARIA_CODEX_PROVIDER
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';

interface ModelDialogProps {
  onClose: () => void;
}

// AUDITARIA_CODEX_PROVIDER_START: Define Codex reasoning effort options and utilities
const CLAUDE_PREFIX = 'claude:';
const CODEX_PREFIX = 'codex:';
const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'medium';
const CODEX_REASONING_OPTIONS: ReadonlyArray<{
  value: CodexReasoningEffort;
  label: string;
}> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

const CODEX_REASONING_BAR_LEVELS: Record<CodexReasoningEffort, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
};
const CODEX_REASONING_BAR_COUNT = 4;

const CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL: Readonly<
  Partial<Record<string, readonly CodexReasoningEffort[]>>
> = {
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.2-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.1-codex-mini': ['low', 'medium', 'high'],
};

function isCodexReasoningEffort(
  value: unknown,
): value is CodexReasoningEffort {
  return CODEX_REASONING_OPTIONS.some((option) => option.value === value);
}

function getSupportedCodexReasoningEfforts(
  model?: string,
): readonly CodexReasoningEffort[] {
  if (!model) return CODEX_REASONING_OPTIONS.map((option) => option.value);
  return (
    CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL[model] ??
    CODEX_REASONING_OPTIONS.map((option) => option.value)
  );
}

function clampCodexReasoningEffortForModel(
  model: string | undefined,
  effort: CodexReasoningEffort,
): CodexReasoningEffort {
  const supported = getSupportedCodexReasoningEfforts(model);
  if (supported.includes(effort)) return effort;

  const reasoningOrder = CODEX_REASONING_OPTIONS.map((option) => option.value);
  const requestedIndex = reasoningOrder.findIndex((value) => value === effort);
  if (requestedIndex === -1) return supported[0] ?? DEFAULT_CODEX_REASONING_EFFORT;

  for (let index = requestedIndex; index >= 0; index--) {
    const candidate = reasoningOrder[index];
    if (supported.includes(candidate)) return candidate;
  }

  for (let index = requestedIndex + 1; index < reasoningOrder.length; index++) {
    const candidate = reasoningOrder[index];
    if (supported.includes(candidate)) return candidate;
  }

  return supported[0] ?? DEFAULT_CODEX_REASONING_EFFORT;
}

function rotateCodexReasoningEffort(
  current: CodexReasoningEffort,
  direction: -1 | 1,
  supportedEfforts: readonly CodexReasoningEffort[],
): CodexReasoningEffort {
  if (supportedEfforts.length === 0) return current;
  const index = supportedEfforts.findIndex((effort) => effort === current);
  const safeIndex = index === -1 ? 0 : index;
  const next =
    (safeIndex + direction + supportedEfforts.length) %
    supportedEfforts.length;
  return supportedEfforts[next];
}

function getCodexReasoningLabel(effort: CodexReasoningEffort): string {
  return (
    CODEX_REASONING_OPTIONS.find((option) => option.value === effort)?.label ??
    CODEX_REASONING_OPTIONS[0].label
  );
}

function CodexReasoningMeter({
  effort,
  maxEffort = 'xhigh',
}: {
  effort: CodexReasoningEffort;
  maxEffort?: CodexReasoningEffort;
}): React.JSX.Element {
  const filledBars = CODEX_REASONING_BAR_LEVELS[effort];
  const maxBars = CODEX_REASONING_BAR_LEVELS[maxEffort];
  return (
    <Text>
      <Text color={theme.status.success}>
        {'|'.repeat(Math.min(filledBars, maxBars))}
      </Text>
      <Text color={theme.text.secondary}>
        {'|'.repeat(Math.max(0, maxBars - filledBars))}
      </Text>
    </Text>
  );
}

function getCodexModelFromSelection(value: string): string | undefined {
  if (!value.startsWith(CODEX_PREFIX)) return undefined;
  const codexModel = value.slice(CODEX_PREFIX.length);
  return codexModel === 'auto' ? undefined : codexModel;
}
// AUDITARIA_CODEX_PROVIDER_END

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const [view, setView] = useState<'main' | 'manual' | 'claude' | 'codex'>('main'); // AUDITARIA_CLAUDE_PROVIDER + AUDITARIA_CODEX_PROVIDER
  const [persistMode, setPersistMode] = useState(false);
  const [codexHighlightedModel, setCodexHighlightedModel] = useState<
    string | undefined
  >(() => {
    const providerConfig = config?.getProviderConfig();
    if (providerConfig?.type !== 'codex-cli') return undefined;
    return providerConfig.model;
  });
  const [codexReasoningEffort, setCodexReasoningEffort] =
    useState<CodexReasoningEffort>(() => {
      const providerConfig = config?.getProviderConfig();
      const effort = providerConfig?.options?.['reasoningEffort'];
      const initialEffort = isCodexReasoningEffort(effort)
        ? effort
        : DEFAULT_CODEX_REASONING_EFFORT;
      const codexModel =
        providerConfig?.type === 'codex-cli' ? providerConfig.model : undefined;
      return clampCodexReasoningEffortForModel(codexModel, initialEffort);
    });

  // Determine the Preferred Model (read once when the dialog opens).
  const preferredModel = config?.getModel() || DEFAULT_GEMINI_MODEL_AUTO;

  const shouldShowPreviewModels = config?.getHasAccessToPreviewModel();

  const manualModelSelected = useMemo(() => {
    const manualModels = [
      DEFAULT_GEMINI_MODEL,
      DEFAULT_GEMINI_FLASH_MODEL,
      DEFAULT_GEMINI_FLASH_LITE_MODEL,
      PREVIEW_GEMINI_MODEL,
      PREVIEW_GEMINI_FLASH_MODEL,
    ];
    if (manualModels.includes(preferredModel)) {
      return preferredModel;
    }
    return '';
  }, [preferredModel]);

  // AUDITARIA_CLAUDE_PROVIDER_START + AUDITARIA_CODEX_PROVIDER
  const displayModel = config?.getDisplayModel() ?? '';
  const isClaudeActive = displayModel.startsWith('claude-code:');
  const isCodexActive = displayModel.startsWith('codex-code:');
  const codexDisplayEffort = clampCodexReasoningEffortForModel(
    codexHighlightedModel,
    codexReasoningEffort,
  );
  const codexSupportedEfforts = getSupportedCodexReasoningEfforts(
    codexHighlightedModel,
  );
  const codexMinSupportedEffort = codexSupportedEfforts[0] ?? codexDisplayEffort;
  const codexMaxSupportedEffort =
    codexSupportedEfforts[codexSupportedEfforts.length - 1] ??
    codexDisplayEffort;
  const codexDisplayMeterMaxEffort = codexMaxSupportedEffort;
  // AUDITARIA_CODEX_PROVIDER_END

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (view === 'manual' || view === 'claude' || view === 'codex') {
          // AUDITARIA_CLAUDE_PROVIDER + AUDITARIA_CODEX_PROVIDER: handle submenu views
          setView('main');
        } else {
          onClose();
        }
        return true;
      }
      if (key.name === 'tab') {
        setPersistMode((prev) => !prev);
        return true;
      }
      // AUDITARIA_CODEX_PROVIDER_START
      if (
        view === 'codex' &&
        (key.name === 'left' || key.name === 'right')
      ) {
        const supportedEfforts = getSupportedCodexReasoningEfforts(
          codexHighlightedModel,
        );
        setCodexReasoningEffort((prev) =>
          rotateCodexReasoningEffort(
            clampCodexReasoningEffortForModel(codexHighlightedModel, prev),
            key.name === 'right' ? 1 : -1,
            supportedEfforts,
          ),
        );
        return true;
      }
      // AUDITARIA_CODEX_PROVIDER_END
      return false;
    },
    { isActive: true },
  );

  const mainOptions = useMemo(() => {
    const list = [
      {
        value: DEFAULT_GEMINI_MODEL_AUTO,
        title: getDisplayString(DEFAULT_GEMINI_MODEL_AUTO),
        description:
          'Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-2.5-flash',
        key: DEFAULT_GEMINI_MODEL_AUTO,
      },
      {
        value: 'Manual',
        title: manualModelSelected
          ? `Manual (${manualModelSelected})`
          : 'Manual',
        description: 'Manually select a model',
        key: 'Manual',
      },
    ];

    if (shouldShowPreviewModels) {
      list.unshift({
        value: PREVIEW_GEMINI_MODEL_AUTO,
        title: getDisplayString(PREVIEW_GEMINI_MODEL_AUTO),
        description:
          'Let Gemini CLI decide the best model for the task: gemini-3-pro, gemini-3-flash',
        key: PREVIEW_GEMINI_MODEL_AUTO,
      });
    }

    // AUDITARIA_CLAUDE_PROVIDER: Single entry that opens the Claude submenu
    list.push({
      value: 'Claude',
      title: isClaudeActive ? 'Claude Code (active)' : 'Claude Code',
      description: 'Use Claude Code as the LLM backend',
      key: 'Claude',
    });

    // AUDITARIA_CODEX_PROVIDER: Single entry that opens the Codex submenu
    list.push({
      value: 'Codex',
      title: isCodexActive ? 'OpenAI Codex (active)' : 'OpenAI Codex',
      description: 'Use OpenAI Codex as the LLM backend',
      key: 'Codex',
    });

    return list;
  }, [shouldShowPreviewModels, manualModelSelected, isClaudeActive, isCodexActive]); // AUDITARIA_CLAUDE_PROVIDER + AUDITARIA_CODEX_PROVIDER

  const manualOptions = useMemo(() => {
    const list = [
      {
        value: DEFAULT_GEMINI_MODEL,
        title: DEFAULT_GEMINI_MODEL,
        key: DEFAULT_GEMINI_MODEL,
      },
      {
        value: DEFAULT_GEMINI_FLASH_MODEL,
        title: DEFAULT_GEMINI_FLASH_MODEL,
        key: DEFAULT_GEMINI_FLASH_MODEL,
      },
      {
        value: DEFAULT_GEMINI_FLASH_LITE_MODEL,
        title: DEFAULT_GEMINI_FLASH_LITE_MODEL,
        key: DEFAULT_GEMINI_FLASH_LITE_MODEL,
      },
    ];

    if (shouldShowPreviewModels) {
      list.unshift(
        {
          value: PREVIEW_GEMINI_MODEL,
          title: PREVIEW_GEMINI_MODEL,
          key: PREVIEW_GEMINI_MODEL,
        },
        {
          value: PREVIEW_GEMINI_FLASH_MODEL,
          title: PREVIEW_GEMINI_FLASH_MODEL,
          key: PREVIEW_GEMINI_FLASH_MODEL,
        },
      );
    }
    return list;
  }, [shouldShowPreviewModels]);

  // AUDITARIA_CLAUDE_PROVIDER_START: Claude submenu options
  const claudeOptions = useMemo(
    () => [
      {
        value: `${CLAUDE_PREFIX}auto`,
        title: 'Auto',
        description: "Uses Claude Code's default model",
        key: 'claude-auto',
      },
      {
        value: `${CLAUDE_PREFIX}opus`,
        title: 'Opus',
        description: 'Most capable model',
        key: 'claude-opus',
      },
      {
        value: `${CLAUDE_PREFIX}sonnet`,
        title: 'Sonnet',
        description: 'Best balance of speed and capability',
        key: 'claude-sonnet',
      },
      {
        value: `${CLAUDE_PREFIX}haiku`,
        title: 'Haiku',
        description: 'Fastest and most compact',
        key: 'claude-haiku',
      },
    ],
    [],
  );
  // AUDITARIA_CLAUDE_PROVIDER_END

  // AUDITARIA_CODEX_PROVIDER_START: Codex submenu options
  const codexOptions = useMemo(
    () => {
      const effortForModel = (model?: string) =>
        clampCodexReasoningEffortForModel(model, codexReasoningEffort);
      const maxEffortForModel = (model?: string) => {
        const supported = getSupportedCodexReasoningEfforts(model);
        return supported[supported.length - 1] ?? 'xhigh';
      };

      return [
        {
          value: `${CODEX_PREFIX}auto`,
          title: 'Auto',
          description: "Uses Codex's default model",
          rightElement: (
            <CodexReasoningMeter
              effort={effortForModel()}
              maxEffort={maxEffortForModel()}
            />
          ),
          key: 'codex-auto',
        },
        {
          value: `${CODEX_PREFIX}gpt-5.3-codex`,
          title: 'GPT-5.3 Codex',
          description: 'Most capable, 258K context',
          rightElement: (
            <CodexReasoningMeter
              effort={effortForModel('gpt-5.3-codex')}
              maxEffort={maxEffortForModel('gpt-5.3-codex')}
            />
          ),
          key: 'codex-gpt53',
        },
        {
          value: `${CODEX_PREFIX}gpt-5.2-codex`,
          title: 'GPT-5.2 Codex',
          description: 'Advanced, 258K context',
          rightElement: (
            <CodexReasoningMeter
              effort={effortForModel('gpt-5.2-codex')}
              maxEffort={maxEffortForModel('gpt-5.2-codex')}
            />
          ),
          key: 'codex-gpt52',
        },
        {
          value: `${CODEX_PREFIX}gpt-5.1-codex-mini`,
          title: 'GPT-5.1 Codex Mini',
          description: 'Fast and compact, 258K context',
          rightElement: (
            <CodexReasoningMeter
              effort={effortForModel('gpt-5.1-codex-mini')}
              maxEffort={maxEffortForModel('gpt-5.1-codex-mini')}
            />
          ),
          key: 'codex-gpt51mini',
        },
      ];
    },
    [codexReasoningEffort],
  );
  // AUDITARIA_CODEX_PROVIDER_END

  // AUDITARIA_CLAUDE_PROVIDER_START + AUDITARIA_CODEX_PROVIDER: add submenu views to options selection
  const options =
    view === 'codex'
      ? codexOptions
      : view === 'claude'
        ? claudeOptions
        : view === 'manual'
          ? manualOptions
          : mainOptions;
  // AUDITARIA_CODEX_PROVIDER_END

  // Calculate the initial index based on the preferred model.
  const initialIndex = useMemo(() => {
    // AUDITARIA_CLAUDE_PROVIDER_START: If Claude is active, highlight its entry
    if (isClaudeActive && view === 'main') {
      const claudeIdx = options.findIndex((o) => o.value === 'Claude');
      if (claudeIdx !== -1) return claudeIdx;
    }
    // AUDITARIA_CLAUDE_PROVIDER_END
    // AUDITARIA_CODEX_PROVIDER: If Codex is active, highlight its entry
    if (isCodexActive && view === 'main') {
      const codexIdx = options.findIndex((o) => o.value === 'Codex');
      if (codexIdx !== -1) return codexIdx;
    }
    const idx = options.findIndex((option) => option.value === preferredModel);
    if (idx !== -1) {
      return idx;
    }
    if (view === 'main') {
      const manualIdx = options.findIndex((o) => o.value === 'Manual');
      return manualIdx !== -1 ? manualIdx : 0;
    }
    return 0;
  }, [preferredModel, options, view, isClaudeActive, isCodexActive]); // AUDITARIA_CLAUDE_PROVIDER + AUDITARIA_CODEX_PROVIDER

  // Handle selection internally (Autonomous Dialog).
  const handleSelect = useCallback(
    (model: string) => {
      if (model === 'Manual') {
        setView('manual');
        return;
      }

      // AUDITARIA_CLAUDE_PROVIDER_START
      if (model === 'Claude') {
        setView('claude');
        return;
      }

      if (model.startsWith(CLAUDE_PREFIX)) {
        if (config) {
          const claudeModel = model.slice(CLAUDE_PREFIX.length);
          const providerConfig: ProviderConfig = {
            type: 'claude-cli',
            model: claudeModel === 'auto' ? undefined : claudeModel,
            cwd: config.getWorkingDir(),
          };
          config.setProviderConfig(providerConfig);
          const event = new ModelSlashCommandEvent(
            `claude-code-${claudeModel}`,
          );
          logModelSlashCommand(config, event);
        }
        onClose();
        return;
      }
      // AUDITARIA_CLAUDE_PROVIDER_END

      // AUDITARIA_CODEX_PROVIDER_START
      if (model === 'Codex') {
        setView('codex');
        return;
      }

      if (model.startsWith(CODEX_PREFIX)) {
        if (config) {
          const codexModel = getCodexModelFromSelection(model);
          const providerConfig: ProviderConfig = {
            type: 'codex-cli',
            model: codexModel,
            cwd: config.getWorkingDir(),
            options: {
              reasoningEffort: clampCodexReasoningEffortForModel(
                codexModel,
                codexReasoningEffort,
              ),
            }, // AUDITARIA_CODEX_PROVIDER
          };
          config.setProviderConfig(providerConfig);
          const event = new ModelSlashCommandEvent(
            `codex-code-${codexModel || 'auto'}`,
          );
          logModelSlashCommand(config, event);
        }
        onClose();
        return;
      }
      // AUDITARIA_CODEX_PROVIDER_END

      if (config) {
        config.clearProviderConfig(); // AUDITARIA_CLAUDE_PROVIDER: clear any active external provider

        config.setModel(model, persistMode ? false : true);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);
      }
      onClose();
    },
    [config, codexReasoningEffort /* AUDITARIA_CODEX_PROVIDER */, onClose, persistMode], 
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {/* AUDITARIA_CLAUDE_PROVIDER + AUDITARIA_CODEX_PROVIDER: conditional title for submenu views */}
      <Text bold>
        {view === 'claude'
          ? 'Select Claude Code Model'
          : view === 'codex'
            ? 'Select OpenAI Codex Model'
            : 'Select Model'}
      </Text>

      {/* AUDITARIA_CLAUDE_PROVIDER_START + AUDITARIA_CODEX_PROVIDER */}
      {(view === 'claude' || view === 'codex') && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            Runs with bypassPermissions — tools execute without confirmation.
          </Text>
        </Box>
      )}
      {/* AUDITARIA_CODEX_PROVIDER_END */}
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={options}
          onSelect={handleSelect}
          onHighlight={(value) => {
            if (
              view === 'codex' &&
              typeof value === 'string' &&
              value.startsWith(CODEX_PREFIX)
            ) {
              setCodexHighlightedModel(getCodexModelFromSelection(value));
            }
          }}
          initialIndex={initialIndex}
          showNumbers={true}
        />
      </Box>
      {/* AUDITARIA_CODEX_PROVIDER_START: show compact Codex thinking controls when in Codex view */}
      {view === 'codex' && (
        <Box marginTop={1} flexDirection="column">
          <Box alignItems="center">
            <Text color={theme.text.primary}>
              Thinking intensity: {getCodexReasoningLabel(codexDisplayEffort)}
            </Text>
            <Box marginLeft={1}>
              <CodexReasoningMeter
                effort={codexDisplayEffort}
                maxEffort={codexDisplayMeterMaxEffort}
              />
            </Box>
          </Box>
          <Text color={theme.text.secondary}>
            Supported range: {getCodexReasoningLabel(codexMinSupportedEffort)} -{' '}
            {getCodexReasoningLabel(codexMaxSupportedEffort)}
          </Text>
          <Text color={theme.text.secondary}>(Use Left/Right arrows)</Text>
        </Box>
      )}
      {/* AUDITARIA_CODEX_PROVIDER_END */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={theme.text.primary}>
            Remember model for future sessions:{' '}
          </Text>
          <Text color={theme.status.success}>
            {persistMode ? 'true' : 'false'}
          </Text>
        </Box>
        <Text color={theme.text.secondary}>(Press Tab to toggle)</Text>
      </Box>
      {/* AUDITARIA_CLAUDE_PROVIDER_START + AUDITARIA_CODEX_PROVIDER: hide Gemini hint in submenu views, dynamic Esc text */}
      {view !== 'claude' && view !== 'codex' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {
              '> To use a specific Gemini model on startup, use the --model flag.'
            }
          </Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          (Press Esc to {view === 'main' ? 'close' : 'go back'})
        </Text>
      </Box>
      {/* AUDITARIA_CLAUDE_PROVIDER_END */}
    </Box>
  );
}
