/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';

interface ConsoleSummaryDisplayProps {
  errorCount: number;
  // logCount is not currently in the plan to be displayed in summary
}

export const ConsoleSummaryDisplay: React.FC<ConsoleSummaryDisplayProps> = ({
  errorCount,
}) => {
  if (errorCount === 0) {
    return null;
  }

  const errorIcon = '\u2716'; // Heavy multiplication x (✖)

  return (
    <Box>
      {errorCount > 0 && (
        <Text color={theme.status.error}>
          {errorIcon} {t('console_summary.error_count', '{count} error{plural}', { count: errorCount, plural: errorCount > 1 ? 's' : '' })}{' '}
          <Text color={theme.text.secondary}>{t('console_summary.ctrl_o_details', '(ctrl+o for details)')}</Text>
        </Text>
      )}
    </Box>
  );
};
