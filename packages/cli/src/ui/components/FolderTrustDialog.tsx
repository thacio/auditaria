/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { useEffect, useState } from 'react';
import { t } from '@thacio/auditaria-cli-core';
import { theme } from '../semantic-colors.js';
import type { RadioSelectItem } from './shared/RadioButtonSelect.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { useKeypress } from '../hooks/useKeypress.js';
import * as process from 'node:process';
import * as path from 'node:path';
import { relaunchApp } from '../../utils/processUtils.js';

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
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    const doRelaunch = async () => {
      if (isRestarting) {
        setTimeout(async () => {
          await relaunchApp();
        }, 250);
      }
    };
    doRelaunch();
  }, [isRestarting]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        setExiting(true);
        setTimeout(() => {
          process.exit(1);
        }, 100);
      }
    },
    { isActive: !isRestarting },
  );

  const dirName = path.basename(process.cwd());
  const parentFolder = path.basename(path.dirname(process.cwd()));

  const options: Array<RadioSelectItem<FolderTrustChoice>> = [
    {
      label: t(
        'folder_trust_dialog.options.trust_folder',
        'Trust folder ({dirName})',
        { dirName },
      ),
      value: FolderTrustChoice.TRUST_FOLDER,
      key: `Trust folder (${dirName})`,
    },
    {
      label: t(
        'folder_trust_dialog.options.trust_parent',
        `Trust parent folder (${parentFolder})`,
        { parentFolder },
      ),
      value: FolderTrustChoice.TRUST_PARENT,
      key: `Trust parent folder (${parentFolder})`,
    },
    {
      label: t('folder_trust_dialog.options.dont_trust', "Don't trust"),
      value: FolderTrustChoice.DO_NOT_TRUST,
      key: "Don't trust",
    },
  ];

  return (
    <Box flexDirection="column">
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.status.warning}
        padding={1}
        width="100%"
        marginLeft={1}
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={theme.text.primary}>
            {t('folder_trust_dialog.title', 'Do you trust this folder?')}
          </Text>
          <Text color={theme.text.primary}>
            {t(
              'folder_trust_dialog.description',
              'Trusting a folder allows Auditaria to execute commands it suggests. This is a security feature to prevent accidental execution in untrusted directories.',
            )}
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
          <Text color={theme.status.warning}>
            {t(
              'folder_trust_dialog.restarting',
              'Auditaria CLI is restarting to apply the trust changes...',
            )}
          </Text>
        </Box>
      )}
      {exiting && (
        <Box marginLeft={1} marginTop={1}>
          <Text color={theme.status.warning}>
            {t(
              'folder_trust_dialog.exiting',
              'A folder trust level must be selected to continue. Exiting since escape was pressed.',
            )}
          </Text>
        </Box>
      )}
    </Box>
  );
};
