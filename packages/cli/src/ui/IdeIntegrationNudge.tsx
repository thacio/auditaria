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
  ideName?: string;
  onComplete: (result: IdeIntegrationNudgeResult) => void;
}

export function IdeIntegrationNudge({
  ideName,
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
          {t('ide_integration_nudge.question', `Do you want to connect your ${ideName ?? 'your'} editor to Auditaria CLI?`, { ideName: ideName ?? 'your' })}
        </Text>
        <Text
          dimColor
        >{t('ide_integration_nudge.description', `If you select Yes, we'll install an extension that allows the CLI to access your open files and display diffs directly in ${ideName ?? 'your editor'}.`, { ideName: ideName ?? 'your editor' })}</Text>
      </Box>
      <RadioButtonSelect
        items={OPTIONS}
        onSelect={onComplete}
        isFocused={true}
      />
    </Box>
  );
}
