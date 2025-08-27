/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text, useInput } from 'ink';
import {
  type Extension,
  performWorkspaceExtensionMigration,
} from '../../config/extension.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { Colors } from '../colors.js';
import { useState } from 'react';
import { t } from '@thacio/auditaria-cli-core';

export function WorkspaceMigrationDialog(props: {
  workspaceExtensions: Extension[];
  onOpen: () => void;
  onClose: () => void;
}) {
  const { workspaceExtensions, onOpen, onClose } = props;
  const [migrationComplete, setMigrationComplete] = useState(false);
  const [failedExtensions, setFailedExtensions] = useState<string[]>([]);
  onOpen();
  const onMigrate = async () => {
    const failed =
      await performWorkspaceExtensionMigration(workspaceExtensions);
    setFailedExtensions(failed);
    setMigrationComplete(true);
  };

  useInput((input) => {
    if (migrationComplete && input === 'q') {
      process.exit(0);
    }
  });

  if (migrationComplete) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={Colors.Gray}
        padding={1}
      >
        {failedExtensions.length > 0 ? (
          <>
            <Text>
              {t('workspace_migration.failed_with_errors',
                "The following extensions failed to migrate. Please try installing them manually. To see other changes, Auditaria CLI must be restarted. Press 'q' to quit.")}
            </Text>
            <Box flexDirection="column" marginTop={1} marginLeft={2}>
              {failedExtensions.map((failed) => (
                <Text key={failed}>- {failed}</Text>
              ))}
            </Box>
          </>
        ) : (
          <Text>
            {t('workspace_migration.complete',
              "Migration complete. To see changes, Auditaria CLI must be restarted. Press 'q' to quit.")}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.Gray}
      padding={1}
    >
      <Text bold>{t('workspace_migration.deprecated', 'Workspace-level extensions are deprecated')}{'\n'}</Text>
      <Text>{t('workspace_migration.prompt', 'Would you like to install them at the user level?')}</Text>
      <Text>
        {t('workspace_migration.definition_note', 'The extension definition will remain in your workspace directory.')}
      </Text>
      <Text>
        {t('workspace_migration.skip_note', 'If you opt to skip, you can install them manually using the extensions install command.')}
      </Text>

      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        {workspaceExtensions.map((extension) => (
          <Text key={extension.config.name}>- {extension.config.name}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={[
            { label: t('workspace_migration.install_all', 'Install all'), value: 'migrate' },
            { label: t('workspace_migration.skip', 'Skip'), value: 'skip' },
          ]}
          onSelect={(value: string) => {
            if (value === 'migrate') {
              onMigrate();
            } else {
              onClose();
            }
          }}
        />
      </Box>
    </Box>
  );
}
