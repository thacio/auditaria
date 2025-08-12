/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolConfirmationOutcome, t } from '@thacio/auditaria-cli-core';
import { Box, Text } from 'ink';
import React from 'react';
import { Colors } from '../colors.js';
import {
  RadioButtonSelect,
  RadioSelectItem,
} from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';

export interface ShellConfirmationRequest {
  commands: string[];
  onConfirm: (
    outcome: ToolConfirmationOutcome,
    approvedCommands?: string[],
  ) => void;
}

export interface ShellConfirmationDialogProps {
  request: ShellConfirmationRequest;
}

export const ShellConfirmationDialog: React.FC<
  ShellConfirmationDialogProps
> = ({ request }) => {
  const { commands, onConfirm } = request;

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onConfirm(ToolConfirmationOutcome.Cancel);
      }
    },
    { isActive: true },
  );

  const handleSelect = (item: ToolConfirmationOutcome) => {
    if (item === ToolConfirmationOutcome.Cancel) {
      onConfirm(item);
    } else {
      // For both ProceedOnce and ProceedAlways, we approve all the
      // commands that were requested.
      onConfirm(item, commands);
    }
  };

  const options: Array<RadioSelectItem<ToolConfirmationOutcome>> = [
    {
      label: t('tool_confirmation.shell_confirmation.options.yes_once', 'Yes, allow once'),
      value: ToolConfirmationOutcome.ProceedOnce,
    },
    {
      label: t('tool_confirmation.shell_confirmation.options.yes_always_session', 'Yes, allow always for this session'),
      value: ToolConfirmationOutcome.ProceedAlways,
    },
    {
      label: t('tool_confirmation.shell_confirmation.options.no_esc', 'No (esc)'),
      value: ToolConfirmationOutcome.Cancel,
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentYellow}
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{t('tool_confirmation.shell_confirmation.title', 'Shell Command Execution')}</Text>
        <Text>{t('tool_confirmation.shell_confirmation.description', 'A custom command wants to run the following shell commands:')}</Text>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={Colors.Gray}
          paddingX={1}
          marginTop={1}
        >
          {commands.map((cmd) => (
            <Text key={cmd} color={Colors.AccentCyan}>
              {cmd}
            </Text>
          ))}
        </Box>
      </Box>

      <Box marginBottom={1}>
        <Text>{t('tool_confirmation.shell_confirmation.question', 'Do you want to proceed?')}</Text>
      </Box>

      <RadioButtonSelect items={options} onSelect={handleSelect} isFocused />
    </Box>
  );
};
