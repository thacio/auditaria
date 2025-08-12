/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DetectedIde, getIdeInfo, t } from '@thacio/auditaria-cli-core';
import { Box, Text } from 'ink';
import {
  RadioButtonSelect,
  RadioSelectItem,
} from './components/shared/RadioButtonSelect.js';
import { useKeypress } from './hooks/useKeypress.js';

export type IdeIntegrationNudgeResult = {
  userSelection: 'yes' | 'no' | 'dismiss';
  isExtensionPreInstalled: boolean;
};

interface IdeIntegrationNudgeProps {
  ide: DetectedIde;
  onComplete: (result: IdeIntegrationNudgeResult) => void;
}

export function IdeIntegrationNudge({
  ide,
  onComplete,
}: IdeIntegrationNudgeProps) {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onComplete({
          userSelection: 'no',
          isExtensionPreInstalled: false,
        });
      }
    },
    { isActive: true },
  );

  const { displayName: ideName } = getIdeInfo(ide);
  // Assume extension is already installed if the env variables are set.
  const isExtensionPreInstalled =
    !!process.env.GEMINI_CLI_IDE_SERVER_PORT &&
    !!process.env.GEMINI_CLI_IDE_WORKSPACE_PATH;

  const OPTIONS: Array<RadioSelectItem<IdeIntegrationNudgeResult>> = [
    {
      label: t('ide_integration_nudge.yes', 'Yes'),
      value: {
        userSelection: 'yes',
        isExtensionPreInstalled,
      },
    },
    {
      label: t('ide_integration_nudge.no_esc', 'No (esc)'),
      value: {
        userSelection: 'no',
        isExtensionPreInstalled,
      },
    },
    {
      label: t('ide_integration_nudge.no_dont_ask', "No, don't ask again"),
      value: {
        userSelection: 'dismiss',
        isExtensionPreInstalled,
      },
    },
  ];

  const installText = isExtensionPreInstalled
    ? t('ide_integration_nudge.description_installed', 
        `If you select Yes, the CLI will have access to your open files and display diffs directly in ${ideName ?? 'your editor'}.`, 
        { ideName: ideName ?? 'your editor' })
    : t('ide_integration_nudge.description', 
        `If you select Yes, we'll install an extension that allows the CLI to access your open files and display diffs directly in ${ideName ?? 'your editor'}.`, 
        { ideName: ideName ?? 'your editor' });

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
          {t('ide_integration_nudge.question', `Do you want to connect ${ideName ?? 'your'} editor to Auditaria CLI?`, { ideName: ideName ?? 'your' })}
        </Text>
        <Text dimColor>{installText}</Text>
      </Box>
      <RadioButtonSelect
        items={OPTIONS}
        onSelect={onComplete}
        isFocused={true}
      />
    </Box>
  );
}
