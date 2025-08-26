/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { t } from '@thacio/auditaria-cli-core';
import { Colors } from '../colors.js';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import * as process from 'node:process';

export enum FolderTrustChoice {
  TRUST_FOLDER = 'trust_folder',
  TRUST_PARENT = 'trust_parent',
  DO_NOT_TRUST = 'do_not_trust',
}

interface FolderTrustDialogProps {
  onSelect: (choice: FolderTrustChoice) => void;
  isRestarting?: boolean;
}

export const FolderTrustDialog: React.FC<FolderTrustDialogProps> = ({
  onSelect,
  isRestarting,
}) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onSelect(FolderTrustChoice.DO_NOT_TRUST);
      }
    },
    { isActive: !isRestarting },
  );

  useKeypress(
    (key) => {
      if (key.name === 'r') {
        process.exit(0);
      }
    },
    { isActive: !!isRestarting },
  );

  const options: Array<RadioSelectItem<FolderTrustChoice>> = [
    {
      label: t('folder_trust_dialog.options.trust_folder', 'Trust folder'),
      value: FolderTrustChoice.TRUST_FOLDER,
    },
    {
      label: t('folder_trust_dialog.options.trust_parent', 'Trust parent folder'),
      value: FolderTrustChoice.TRUST_PARENT,
    },
    {
      label: t('folder_trust_dialog.options.dont_trust', "Don't trust (esc)"),
      value: FolderTrustChoice.DO_NOT_TRUST,
    },
  ];

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={Colors.AccentYellow}
        padding={1}
        width="100%"
        marginLeft={1}
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{t('folder_trust_dialog.title', 'Do you trust this folder?')}</Text>
          <Text>
            {t('folder_trust_dialog.description', 'Trusting a folder allows Auditaria to execute commands it suggests. This is a security feature to prevent accidental execution in untrusted directories.')}
          </Text>
        </Box>

        <RadioButtonSelect
          items={options}
          onSelect={onSelect}
          isFocused={!isRestarting}
        />
      </Box>
      {isRestarting && (
        <Box marginLeft={1} marginTop={1}>
          <Text color={Colors.AccentYellow}>
            {t('settings_dialog.messages.restart_required', 'To see changes, Auditaria CLI must be restarted. Press r to exit and apply changes now.')}
          </Text>
        </Box>
      )}
    </Box>
  );
};
