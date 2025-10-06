/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import type React from 'react';
import { TrustLevel } from '../../config/trustedFolders.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { usePermissionsModifyTrust } from '../hooks/usePermissionsModifyTrust.js';
import { theme } from '../semantic-colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { relaunchApp } from '../../utils/processUtils.js';
import { type UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import { t } from '@thacio/auditaria-cli-core';

interface PermissionsModifyTrustDialogProps {
  onExit: () => void;
  addItem: UseHistoryManagerReturn['addItem'];
}

const getTrustLevelItems = () => [
  {
    label: t(
      'permissions_dialog.trust_options.trust_folder',
      'Trust this folder',
    ),
    value: TrustLevel.TRUST_FOLDER,
    key: TrustLevel.TRUST_FOLDER,
  },
  {
    label: t(
      'permissions_dialog.trust_options.trust_parent',
      'Trust parent folder',
    ),
    value: TrustLevel.TRUST_PARENT,
    key: TrustLevel.TRUST_PARENT,
  },
  {
    label: t('permissions_dialog.trust_options.dont_trust', "Don't trust"),
    value: TrustLevel.DO_NOT_TRUST,
    key: TrustLevel.DO_NOT_TRUST,
  },
];

export function PermissionsModifyTrustDialog({
  onExit,
  addItem,
}: PermissionsModifyTrustDialogProps): React.JSX.Element {
  const {
    cwd,
    currentTrustLevel,
    isInheritedTrustFromParent,
    isInheritedTrustFromIde,
    needsRestart,
    updateTrustLevel,
    commitTrustLevelChange,
  } = usePermissionsModifyTrust(onExit, addItem);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onExit();
      }
      if (needsRestart && key.name === 'r') {
        commitTrustLevelChange();
        relaunchApp();
        onExit();
      }
    },
    { isActive: true },
  );

  const TRUST_LEVEL_ITEMS = getTrustLevelItems();
  const index = TRUST_LEVEL_ITEMS.findIndex(
    (item) => item.value === currentTrustLevel,
  );
  const initialIndex = index === -1 ? 0 : index;

  return (
    <>
      <Box
        borderStyle="round"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
      >
        <Box flexDirection="column" paddingBottom={1}>
          <Text bold>
            {'> '}
            {t('permissions_dialog.title', 'Modify Trust Level')}
          </Text>
          <Box marginTop={1} />
          <Text>
            {t('permissions_dialog.folder_label', 'Folder:')} {cwd}
          </Text>
          <Text>
            {t('permissions_dialog.current_level_label', 'Current Level:')}{' '}
            <Text bold>
              {currentTrustLevel || t('permissions_dialog.not_set', 'Not Set')}
            </Text>
          </Text>
          {isInheritedTrustFromParent && (
            <Text color={theme.text.secondary}>
              {t(
                'permissions_dialog.notes.inherited_from_parent',
                'Note: This folder behaves as a trusted folder because one of the parent folders is trusted. It will remain trusted even if you set a different trust level here. To change this, you need to modify the trust setting in the parent folder.',
              )}
            </Text>
          )}
          {isInheritedTrustFromIde && (
            <Text color={theme.text.secondary}>
              {t(
                'permissions_dialog.notes.inherited_from_ide',
                'Note: This folder behaves as a trusted folder because the connected IDE workspace is trusted. It will remain trusted even if you set a different trust level here.',
              )}
            </Text>
          )}
        </Box>

        <RadioButtonSelect
          items={TRUST_LEVEL_ITEMS}
          onSelect={updateTrustLevel}
          isFocused={true}
          initialIndex={initialIndex}
        />
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t(
              'permissions_dialog.instructions.use_enter_select',
              '(Use Enter to select)',
            )}
          </Text>
        </Box>
      </Box>
      {needsRestart && (
        <Box marginLeft={1} marginTop={1}>
          <Text color={theme.status.warning}>
            {t(
              'permissions_dialog.restart.message',
              "To apply the trust changes, Auditaria CLI must be restarted. Press 'r' to restart CLI now.",
            )}
          </Text>
        </Box>
      )}
    </>
  );
}
