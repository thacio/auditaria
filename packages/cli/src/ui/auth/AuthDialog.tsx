/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import {
  AuthType,
  clearCachedCredentialFile,
  debugLogger,
  type Config,
} from '@thacio/auditaria-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { AuthState } from '../types.js';
import { runExitCleanup } from '../../utils/cleanup.js';
import { validateAuthMethodWithSettings } from './useAuth.js';

interface AuthDialogProps {
  config: Config;
  settings: LoadedSettings;
  setAuthState: (state: AuthState) => void;
  authError: string | null;
  onAuthError: (error: string | null) => void;
}

export function AuthDialog({
  config,
  settings,
  setAuthState,
  authError,
  onAuthError,
}: AuthDialogProps): React.JSX.Element {
  let items = [
    {
      label: t(
        'auth_dialog.options.login_google_free',
        'Login with Google - Free Tier',
      ),
      value: AuthType.LOGIN_WITH_GOOGLE,
      key: AuthType.LOGIN_WITH_GOOGLE,
    },
    {
      label: t(
        'auth_dialog.options.login_google_gca',
        'Login with Google - Gemini Code Assist (Requires GOOGLE_CLOUD_PROJECT)',
      ),
      value: AuthType.LOGIN_WITH_GOOGLE_GCA,
      key: AuthType.LOGIN_WITH_GOOGLE_GCA,
    },
    ...(process.env['CLOUD_SHELL'] === 'true'
      ? [
          {
            label: t(
              'auth_dialog.options.cloud_shell',
              'Use Cloud Shell user credentials',
            ),
            value: AuthType.CLOUD_SHELL,
            key: AuthType.CLOUD_SHELL,
          },
        ]
      : []),
    {
      label: t('auth_dialog.options.gemini_api', 'Use Gemini API Key'),
      value: AuthType.USE_GEMINI,
      key: AuthType.USE_GEMINI,
    },
    {
      label: t('auth_dialog.options.vertex_ai', 'Vertex AI'),
      value: AuthType.USE_VERTEX_AI,
      key: AuthType.USE_VERTEX_AI,
    },
  ];

  if (settings.merged.security?.auth?.enforcedType) {
    items = items.filter(
      (item) => item.value === settings.merged.security?.auth?.enforcedType,
    );
  }

  let defaultAuthType = null;
  const defaultAuthTypeEnv = process.env['GEMINI_DEFAULT_AUTH_TYPE'];
  if (
    defaultAuthTypeEnv &&
    Object.values(AuthType).includes(defaultAuthTypeEnv as AuthType)
  ) {
    defaultAuthType = defaultAuthTypeEnv as AuthType;
  }

  let initialAuthIndex = items.findIndex((item) => {
    if (settings.merged.security?.auth?.selectedType) {
      return item.value === settings.merged.security.auth.selectedType;
    }

    if (defaultAuthType) {
      return item.value === defaultAuthType;
    }

    if (process.env['GEMINI_API_KEY']) {
      return item.value === AuthType.USE_GEMINI;
    }

    return item.value === AuthType.LOGIN_WITH_GOOGLE;
  });
  if (settings.merged.security?.auth?.enforcedType) {
    initialAuthIndex = 0;
  }

  const onSelect = useCallback(
    async (authType: AuthType | undefined, scope: SettingScope) => {
      if (authType) {
        await clearCachedCredentialFile();

        settings.setValue(scope, 'security.auth.selectedType', authType);
        if (
          authType === AuthType.LOGIN_WITH_GOOGLE &&
          config.isBrowserLaunchSuppressed()
        ) {
          runExitCleanup();
          debugLogger.log(
            `
----------------------------------------------------------------
${t('oauth.restart_cli_message', 'Logging in with Google... Please restart Auditaria CLI to continue.')}
----------------------------------------------------------------
            `,
          );
          process.exit(0);
        }
      }
      if (authType === AuthType.USE_GEMINI) {
        setAuthState(AuthState.AwaitingApiKeyInput);
        return;
      }
      setAuthState(AuthState.Unauthenticated);
    },
    [settings, config, setAuthState],
  );

  const handleAuthSelect = (authMethod: AuthType) => {
    const error = validateAuthMethodWithSettings(authMethod, settings);
    if (error) {
      onAuthError(error);
    } else {
      onSelect(authMethod, SettingScope.User);
    }
  };

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Prevent exit if there is an error message.
        // This means they user is not authenticated yet.
        if (authError) {
          return;
        }
        if (settings.merged.security?.auth?.selectedType === undefined) {
          // Prevent exiting if no auth method is set
          onAuthError(
            t(
              'auth_dialog.messages.must_select_auth',
              'You must select an auth method to proceed. Press Ctrl+C twice to exit.',
            ),
          );
          return;
        }
        onSelect(undefined, SettingScope.User);
      }
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.focused}
      flexDirection="row"
      padding={1}
      width="100%"
      alignItems="flex-start"
    >
      <Text color={theme.text.accent}>? </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={theme.text.primary}>
          {t('auth_dialog.dialog_title', 'Get started')}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t(
              'auth_dialog.dialog_question',
              'How would you like to authenticate for this project?',
            )}
          </Text>
        </Box>
        <Box marginTop={1}>
          <RadioButtonSelect
            items={items}
            initialIndex={initialAuthIndex}
            onSelect={handleAuthSelect}
            onHighlight={() => {
              onAuthError(null);
            }}
          />
        </Box>
        {authError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{authError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {t('auth_dialog.messages.use_enter', '(Use Enter to select)')}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            {t(
              'auth_dialog.messages.terms_privacy',
              'Terms of Services and Privacy Notice for Auditaria CLI',
            )}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.link}>
            {
              'https://github.com/google-gemini/gemini-cli/blob/main/docs/tos-privacy.md'
            }
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
