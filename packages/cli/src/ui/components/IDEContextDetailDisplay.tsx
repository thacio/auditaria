/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { type OpenFiles, t } from '@thacio/auditaria-cli-core';
import { Colors } from '../colors.js';
import path from 'node:path';

interface IDEContextDetailDisplayProps {
  openFiles: OpenFiles | undefined;
}

export function IDEContextDetailDisplay({
  openFiles,
}: IDEContextDetailDisplayProps) {
  if (
    !openFiles ||
    !openFiles.recentOpenFiles ||
    openFiles.recentOpenFiles.length === 0
  ) {
    return null;
  }
  const recentFiles = openFiles.recentOpenFiles || [];

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      paddingX={1}
    >
      <Text color={Colors.AccentCyan} bold>
        {t('ide_context.title', 'IDE Context (ctrl+e to toggle)')}
      </Text>
      {recentFiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{t('ide_context.recent_files', 'Recent files:')}</Text>
          {recentFiles.map((file) => (
            <Text key={file.filePath}>
              - {path.basename(file.filePath)}
              {file.filePath === openFiles.activeFile ? t('ide_context.active_file', ' (active)') : ''}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
