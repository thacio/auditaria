/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text, useInput } from 'ink';
import { t } from '@thacio/auditaria-cli-core';
import {
  RadioButtonSelect,
  RadioSelectItem,
} from './components/shared/RadioButtonSelect.js';

export type IdeIntegrationNudgeResult = 'yes' | 'no' | 'dismiss';

interface IdeIntegrationNudgeProps {
  question: string;
  description?: string;
  onComplete: (result: IdeIntegrationNudgeResult) => void;
}

export function IdeIntegrationNudge({
  question,
  description,
  onComplete,
}: IdeIntegrationNudgeProps) {
  useInput((_input, key) => {
    if (key.escape) {
      onComplete('no');
    }
  });

  const OPTIONS: Array<RadioSelectItem<IdeIntegrationNudgeResult>> = [
    {
      label: t('ide_integration_nudge.yes', 'Yes'),
      value: 'yes',
    },
    {
      label: t('ide_integration_nudge.no_esc', 'No (esc)'),
      value: 'no',
    },
    {
      label: t('ide_integration_nudge.no_dont_ask', "No, don't ask again"),
      value: 'dismiss',
    },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      padding={1}
      width="100%"
      marginLeft={1}
    >
      <Box marginBottom={1} flexDirection="column">
        <Text>
          <Text color="yellow">{'> '}</Text>
          {question}
        </Text>
        {description && <Text dimColor>{description}</Text>}
      </Box>
      <RadioButtonSelect
        items={OPTIONS}
        onSelect={onComplete}
        isFocused={true}
      />
    </Box>
  );
}
