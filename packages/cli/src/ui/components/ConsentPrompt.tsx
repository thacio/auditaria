/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import { type ReactNode } from 'react';
import { theme } from '../semantic-colors.js';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { t } from '@thacio/auditaria-cli-core';

type ConsentPromptProps = {
  // If a simple string is given, it will render using markdown by default.
  prompt: ReactNode;
  onConfirm: (value: boolean) => void;
  terminalWidth: number;
};

export const ConsentPrompt = (props: ConsentPromptProps) => {
  const { prompt, onConfirm, terminalWidth } = props;

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      paddingY={1}
      paddingX={2}
    >
      {typeof prompt === 'string' ? (
        <MarkdownDisplay
          isPending={true}
          text={prompt}
          terminalWidth={terminalWidth}
        />
      ) : (
        prompt
      )}
      <Box marginTop={1}>
        <RadioButtonSelect
          items={[
            {
              label: t('tool_confirmation.options.yes', 'Yes'),
              value: true,
              key: 'Yes',
            },
            {
              label: t('tool_confirmation.options.no', 'No'),
              value: false,
              key: 'No',
            },
          ]}
          onSelect={onConfirm}
        />
      </Box>
    </Box>
  );
};
