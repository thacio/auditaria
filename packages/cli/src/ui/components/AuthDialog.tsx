/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Colors } from '../colors.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import { AuthType } from '@thacio/auditaria-cli-core';
import { validateAuthMethod } from '../../config/auth.js';

interface AuthDialogProps {
  onSelect: (authMethod: AuthType | undefined, scope: SettingScope) => void;
  settings: LoadedSettings;
  initialErrorMessage?: string | null;
}

function parseDefaultAuthType(
  defaultAuthType: string | undefined,
): AuthType | null {
  if (
    defaultAuthType &&
    Object.values(AuthType).includes(defaultAuthType as AuthType)
  ) {
    return defaultAuthType as AuthType;
  }
  return null;
}

export function AuthDialog({
  onSelect,
  settings,
  initialErrorMessage,
}: AuthDialogProps): React.JSX.Element {
  const [errorMessage, setErrorMessage] = useState<string | null>(() => {
    if (initialErrorMessage) {
      return initialErrorMessage;
    }

    const defaultAuthType = parseDefaultAuthType(
      process.env.GEMINI_DEFAULT_AUTH_TYPE,
    );

    if (process.env.GEMINI_DEFAULT_AUTH_TYPE && defaultAuthType === null) {
      return t('auth_dialog.messages.invalid_default_auth_type', 
        'Invalid value for GEMINI_DEFAULT_AUTH_TYPE: "{defaultAuthType}". Valid values are: {validValues}.', 
        { 
          defaultAuthType: process.env.GEMINI_DEFAULT_AUTH_TYPE,
          validValues: Object.values(AuthType).join(', ')
        }
      );
    }

    if (
      process.env.GEMINI_API_KEY &&
      (!defaultAuthType || defaultAuthType === AuthType.USE_GEMINI)
    ) {
      return t('auth_dialog.messages.api_key_detected', 'Existing API key detected (GEMINI_API_KEY). Select "Gemini API Key" option to use it.');
    }
    return null;
  });
  const items = [
    {
      label: t('auth_dialog.options.login_google', 'Login with Google'),
      value: AuthType.LOGIN_WITH_GOOGLE,
    },
    ...(process.env.CLOUD_SHELL === 'true'
      ? [
          {
            label: t('auth_dialog.options.cloud_shell', 'Use Cloud Shell user credentials'),
            value: AuthType.CLOUD_SHELL,
          },
        ]
      : []),
    {
      label: t('auth_dialog.options.gemini_api', 'Use Gemini API Key'),
      value: AuthType.USE_GEMINI,
    },
    { label: t('auth_dialog.options.vertex_ai', 'Vertex AI'), value: AuthType.USE_VERTEX_AI },
  ];

  const initialAuthIndex = items.findIndex((item) => {
    if (settings.merged.selectedAuthType) {
      return item.value === settings.merged.selectedAuthType;
    }

    const defaultAuthType = parseDefaultAuthType(
      process.env.GEMINI_DEFAULT_AUTH_TYPE,
    );
    if (defaultAuthType) {
      return item.value === defaultAuthType;
    }

    if (process.env.GEMINI_API_KEY) {
      return item.value === AuthType.USE_GEMINI;
    }

    return item.value === AuthType.LOGIN_WITH_GOOGLE;
  });

  const handleAuthSelect = (authMethod: AuthType) => {
    const error = validateAuthMethod(authMethod);
    if (error) {
      setErrorMessage(error);
    } else {
      setErrorMessage(null);
      onSelect(authMethod, SettingScope.User);
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      // Prevent exit if there is an error message.
      // This means they user is not authenticated yet.
      if (errorMessage) {
        return;
      }
      if (settings.merged.selectedAuthType === undefined) {
        // Prevent exiting if no auth method is set
        setErrorMessage(
          t('auth_dialog.messages.must_select_auth', 'You must select an auth method to proceed. Press Ctrl+C twice to exit.'),
        );
        return;
      }
      onSelect(undefined, SettingScope.User);
    }
  });

  return (
    <Box
      borderStyle="round"
      borderColor={Colors.Gray}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{t('auth_dialog.dialog_title', 'Get started')}</Text>
      <Box marginTop={1}>
        <Text>{t('auth_dialog.dialog_question', 'How would you like to authenticate for this project?')}</Text>
      </Box>
      <Box marginTop={1}>
        <RadioButtonSelect
          items={items}
          initialIndex={initialAuthIndex}
          onSelect={handleAuthSelect}
          isFocused={true}
        />
      </Box>
      {errorMessage && (
        <Box marginTop={1}>
          <Text color={Colors.AccentRed}>{errorMessage}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={Colors.Gray}>{t('auth_dialog.messages.use_enter', '(Use Enter to select)')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>{t('auth_dialog.messages.terms_privacy', 'Terms of Services and Privacy Notice for Gemini CLI')}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={Colors.AccentBlue}>
          {
            'https://github.com/google-gemini/gemini-cli/blob/main/docs/tos-privacy.md'
          }
        </Text>
      </Box>
    </Box>
  );
}
