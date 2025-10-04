/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useContext, useMemo } from 'react';
import { Box, Text } from 'ink';
import {
  DEFAULT_GEMINI_FLASH_LITE_MODEL,
  DEFAULT_GEMINI_FLASH_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL_AUTO,
  ModelSlashCommandEvent,
  logModelSlashCommand,
  t,
} from '@thacio/auditaria-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { theme } from '../semantic-colors.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';

interface ModelDialogProps {
  onClose: () => void;
}

const MODEL_OPTIONS = [
  {
    value: DEFAULT_GEMINI_MODEL_AUTO,
    title: t('model_dialog.options.auto.title', 'Auto (recommended)'),
    description: t(
      'model_dialog.options.auto.description',
      'Let the system choose the best model for your task',
    ),
  },
  {
    value: DEFAULT_GEMINI_MODEL,
    title: t('model_dialog.options.pro.title', 'Pro'),
    description: t(
      'model_dialog.options.pro.description',
      'For complex tasks that require deep reasoning and creativity',
    ),
  },
  {
    value: DEFAULT_GEMINI_FLASH_MODEL,
    title: t('model_dialog.options.flash.title', 'Flash'),
    description: t(
      'model_dialog.options.flash.description',
      'For tasks that need a balance of speed and reasoning',
    ),
  },
  {
    value: DEFAULT_GEMINI_FLASH_LITE_MODEL,
    title: t('model_dialog.options.flash_lite.title', 'Flash-Lite'),
    description: t(
      'model_dialog.options.flash_lite.description',
      'For simple tasks that need to be done quickly',
    ),
  },
];

export function ModelDialog({ onClose }: ModelDialogProps): React.JSX.Element {
  const config = useContext(ConfigContext);

  // Determine the Preferred Model (read once when the dialog opens).
  const preferredModel = config?.getModel() || DEFAULT_GEMINI_MODEL_AUTO;

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: true },
  );

  // Calculate the initial index based on the preferred model.
  const initialIndex = useMemo(
    () => MODEL_OPTIONS.findIndex((option) => option.value === preferredModel),
    [preferredModel],
  );

  // Handle selection internally (Autonomous Dialog).
  const handleSelect = useCallback(
    (model: string) => {
      if (config) {
        config.setModel(model);
        const event = new ModelSlashCommandEvent(model);
        logModelSlashCommand(config, event);
      }
      onClose();
    },
    [config, onClose],
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('model_dialog.title', 'Select Model')}</Text>
      <Box marginTop={1}>
        <DescriptiveRadioButtonSelect
          items={MODEL_OPTIONS}
          onSelect={handleSelect}
          initialIndex={initialIndex}
          showNumbers={true}
        />
      </Box>
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t(
            'model_dialog.messages.model_flag_help',
            '> To use a specific Gemini model, use the --model flag.',
          )}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t(
            'model_dialog.messages.press_esc_to_close',
            '(Press Esc to close)',
          )}
        </Text>
      </Box>
    </Box>
  );
}
