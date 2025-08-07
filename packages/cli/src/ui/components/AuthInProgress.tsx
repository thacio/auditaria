/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { Colors } from '../colors.js';
import { t } from '@thacio/auditaria-cli-core';

interface AuthInProgressProps {
  onTimeout: () => void;
}

export function AuthInProgress({
  onTimeout,
}: AuthInProgressProps): React.JSX.Element {
  const [timedOut, setTimedOut] = useState(false);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && (input === 'c' || input === 'C'))) {
      onTimeout();
    }
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setTimedOut(true);
      onTimeout();
    }, 180000);

    return () => clearTimeout(timer);
  }, [onTimeout]);

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      {timedOut ? (
        <Text color={Colors.AccentRed}>
          {t('auth_dialog.messages.auth_timeout', 'Authentication timed out. Please try again.')}
        </Text>
      ) : (
        <Box>
          <Text>
            <Spinner type="dots" /> {t('auth_dialog.messages.waiting_for_auth', 'Waiting for auth... (Press ESC or CTRL+C to cancel)')}
          </Text>
        </Box>
      )}
    </Box>
  );
}
