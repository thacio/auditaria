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
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { ThemedGradient } from './ThemedGradient.js';

interface ModelDialogProps {
  onClose: () => void;
}

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);
  const [view, setView] = useState<'main' | 'manual' | 'claude'>('main'); // AUDITARIA_CLAUDE_PROVIDER: add 'claude' view
  const [persistMode, setPersistMode] = useState(false);

  // Determine the Preferred Model (read once when the dialog opens).
  const preferredModel = config?.getModel() || DEFAULT_GEMINI_MODEL_AUTO;

  const shouldShowPreviewModels =
    config?.getPreviewFeatures() && config.getHasAccessToPreviewModel();

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

  // AUDITARIA_CLAUDE_PROVIDER_START
  const CLAUDE_PREFIX = 'claude:';
  const isClaudeActive = config?.isExternalProviderActive() ?? false;
  // AUDITARIA_CLAUDE_PROVIDER_END

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        if (view === 'manual' || view === 'claude') { // AUDITARIA_CLAUDE_PROVIDER: handle 'claude' view
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

    return list;
  }, [shouldShowPreviewModels, manualModelSelected, isClaudeActive]); // AUDITARIA_CLAUDE_PROVIDER: add isClaudeActive dep

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

  // AUDITARIA_CLAUDE_PROVIDER_START: add 'claude' view to options selection
  const options =
    view === 'claude'
      ? claudeOptions
      : view === 'manual'
        ? manualOptions
        : mainOptions;
  // AUDITARIA_CLAUDE_PROVIDER_END

  // Calculate the initial index based on the preferred model.
  const initialIndex = useMemo(() => {
    // AUDITARIA_CLAUDE_PROVIDER_START: If Claude is active, highlight its entry
    if (isClaudeActive && view === 'main') {
      const claudeIdx = options.findIndex((o) => o.value === 'Claude');
      if (claudeIdx !== -1) return claudeIdx;
    }
    // AUDITARIA_CLAUDE_PROVIDER_END
    const idx = options.findIndex((option) => option.value === preferredModel);
    if (idx !== -1) {
      return idx;
    }
    if (view === 'main') {
      const manualIdx = options.findIndex((o) => o.value === 'Manual');
      return manualIdx !== -1 ? manualIdx : 0;
    }
    return 0;
  }, [preferredModel, options, view, isClaudeActive]); // AUDITARIA_CLAUDE_PROVIDER: add isClaudeActive

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
          const event = new ModelSlashCommandEvent(`claude-code-${claudeModel}`);
          logModelSlashCommand(config, event);
        }
        onClose();
        return;
      }
      // AUDITARIA_CLAUDE_PROVIDER_END

      if (config) {
        config.clearProviderConfig(); // AUDITARIA_CLAUDE_PROVIDER: clear any active Claude provider

        config.setModel(model, persistMode ? false : true);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);
      }
      onClose();
    },
    [config, onClose, persistMode],
  );

  let header;
  let subheader;

  // Do not show any header or subheader since it's already showing preview model
  // options
  if (shouldShowPreviewModels) {
    header = undefined;
    subheader = undefined;
    // When a user has the access but has not enabled the preview features.
  } else if (config?.getHasAccessToPreviewModel()) {
    header = 'Gemini 3 is now available.';
    subheader =
      'Enable "Preview features" in /settings.\nLearn more at https://goo.gle/enable-preview-features';
  } else {
    header = 'Gemini 3 is coming soon.';
    subheader = undefined;
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {/* AUDITARIA_CLAUDE_PROVIDER: conditional title for claude view */}
      <Text bold>
        {view === 'claude' ? 'Select Claude Code Model' : 'Select Model'}
      </Text>

      <Box flexDirection="column">
        {header && view !== 'claude' && ( /* AUDITARIA_CLAUDE_PROVIDER: hide header in claude view */
          <Box marginTop={1}>
            <ThemedGradient>
              <Text>{header}</Text>
            </ThemedGradient>
          </Box>
        )}
        {subheader && view !== 'claude' && <Text>{subheader}</Text>} {/* AUDITARIA_CLAUDE_PROVIDER: hide subheader in claude view */}
      </Box>
      {/* AUDITARIA_CLAUDE_PROVIDER_START */}
      {view === 'claude' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.status.warning}>
            Runs with bypassPermissions — tools execute without confirmation.
          </Text>
        </Box>
      )}
      {/* AUDITARIA_CLAUDE_PROVIDER_END */}
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={options}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          showNumbers={true}
        />
      </Box>
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
      {/* AUDITARIA_CLAUDE_PROVIDER_START: hide Gemini hint in claude view, dynamic Esc text */}
      {view !== 'claude' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            {'> To use a specific Gemini model on startup, use the --model flag.'}
          </Text>
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>(Press Esc to {view === 'main' ? 'close' : 'go back'})</Text>
      </Box>
      {/* AUDITARIA_CLAUDE_PROVIDER_END */}
    </Box>
  );
}
