/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';
import { t } from '@thacio/auditaria-cli-core';

export const ExitWarning: React.FC = () => {
  const uiState = useUIState();
  return (
    <>
      {uiState.dialogsVisible && uiState.ctrlCPressedOnce && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            {t('ui.press_ctrl_c_exit', 'Press Ctrl+C again to exit.')}
          </Text>
        </Box>
      )}

      {uiState.dialogsVisible && uiState.ctrlDPressedOnce && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            {t('ui.press_ctrl_d_exit', 'Press Ctrl+D again to exit.')}
          </Text>
        </Box>
      )}
    </>
  );
};
