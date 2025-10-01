/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';

export const ShellModeIndicator: React.FC = () => (
  <Box>
    <Text color={theme.ui.symbol}>
      {t('shell_mode.enabled', 'shell mode enabled')}
      <Text color={theme.text.secondary}>{t('shell_mode.esc_to_disable', ' (esc to disable)')}</Text>
    </Text>
  </Box>
);
