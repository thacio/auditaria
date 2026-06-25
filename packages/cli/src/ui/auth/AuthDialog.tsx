/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useState } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { RadioButtonSelect } from '../components/shared/RadioButtonSelect.js';
import {
  SettingScope,
  type LoadableSettingScope,
  type LoadedSettings,
} from '../../config/settings.js';
import {
  AuthType,
  clearCachedCredentialFile,
  // AUDITARIA_PROVIDER_ONLY: provider discovery copy for the no-Google-account path
  getSkipLoginDescription,
  getGoogleOAuthDiscontinuedNote,
  type Config,
} from '@google/gemini-cli-core';
import { useKeypress } from '../hooks/useKeypress.js';
import { AuthState } from '../types.js';
import { validateAuthMethodWithSettings } from './useAuth.js';
import { relaunchApp } from '../../utils/processUtils.js';

interface AuthDialogProps {
  config: Config;
  settings: LoadedSettings;
  setAuthState: (state: AuthState) => void;
  authError: string | null;
  onAuthError: (error: string | null) => void;
  setAuthContext: (context: { requiresRestart?: boolean }) => void;
}

export function AuthDialog({
  config,
  settings,
  setAuthState,
  authError,
  onAuthError,
  setAuthContext,
}: AuthDialogProps): React.JSX.Element {
  const [exiting, setExiting] = useState(false);
  // AUDITARIA_PROVIDER_ONLY: track the highlighted option to show contextual help.
  const [highlighted, setHighlighted] = useState<string | null>(null);

  // AUDITARIA_PROVIDER_ONLY_START: Besides the Google options, the auth dialog
  // offers a single "skip Google sign-in" entry. Selecting it starts Auditaria in
  // provider-only mode (no Google credentials); the user then picks an external
  // provider with /model (the highlighted description points to them).
  type AuthMenuItem = {
    label: string;
    value: string;
    key: string;
    sublabel?: string;
  };
  const SKIP_LOGIN_VALUE = 'skip-google-login';
  const availability = config.getProviderAvailability();

  let googleItems: AuthMenuItem[] = [
    {
      label: 'Sign in with Google',
      value: AuthType.LOGIN_WITH_GOOGLE,
      key: AuthType.LOGIN_WITH_GOOGLE,
      sublabel:
        'No longer serves AI Pro/Ultra/free subscriptions (since 2026-06-18) — highlight to learn more',
    },
    ...(process.env['CLOUD_SHELL'] === 'true'
      ? [
          {
            label: 'Use Cloud Shell user credentials',
            value: AuthType.COMPUTE_ADC,
            key: AuthType.COMPUTE_ADC,
          },
        ]
      : process.env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true'
        ? [
            {
              label: 'Use metadata server application default credentials',
              value: AuthType.COMPUTE_ADC,
              key: AuthType.COMPUTE_ADC,
            },
          ]
        : []),
    {
      label: 'Use Gemini API Key',
      value: AuthType.USE_GEMINI,
      key: AuthType.USE_GEMINI,
    },
    {
      label: 'Vertex AI',
      value: AuthType.USE_VERTEX_AI,
      key: AuthType.USE_VERTEX_AI,
    },
  ];

  // enforcedType restricts only the Google options; the skip-login entry always
  // remains available (provider-only intentionally bypasses the admin lock).
  if (settings.merged.security.auth.enforcedType) {
    googleItems = googleItems.filter(
      (item) => item.value === settings.merged.security.auth.enforcedType,
    );
  }

  const skipLoginItem: AuthMenuItem = {
    label:
      'Skip Google sign-in — use Claude Code, Codex, Copilot or Antigravity',
    sublabel: 'No Google account needed (highlight to learn more)',
    value: SKIP_LOGIN_VALUE,
    key: SKIP_LOGIN_VALUE,
  };

  const items: AuthMenuItem[] = [...googleItems, skipLoginItem];
  // AUDITARIA_PROVIDER_ONLY_END

  let defaultAuthType: AuthType | null = null;
  const defaultAuthTypeEnv = process.env['GEMINI_DEFAULT_AUTH_TYPE'];
  if (
    defaultAuthTypeEnv &&
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    Object.values(AuthType).includes(defaultAuthTypeEnv as AuthType)
  ) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    defaultAuthType = defaultAuthTypeEnv as AuthType;
  }

  let initialAuthIndex = items.findIndex((item) => {
    const selectedType = settings.merged.security.auth.selectedType;
    // AUDITARIA_PROVIDER_ONLY: highlight the skip-login entry in provider-only mode.
    if (selectedType === AuthType.PROVIDER_ONLY) {
      return item.value === SKIP_LOGIN_VALUE;
    }
    if (selectedType) {
      return item.value === selectedType;
    }

    if (defaultAuthType) {
      return item.value === defaultAuthType;
    }

    if (process.env['GEMINI_API_KEY']) {
      return item.value === AuthType.USE_GEMINI;
    }

    return item.value === AuthType.LOGIN_WITH_GOOGLE;
  });
  if (settings.merged.security.auth.enforcedType) {
    initialAuthIndex = 0;
  }
  // AUDITARIA_PROVIDER_ONLY: never leave the list unselected.
  if (initialAuthIndex < 0) {
    initialAuthIndex = 0;
  }

  const onSelect = useCallback(
    async (authType: AuthType | undefined, scope: LoadableSettingScope) => {
      if (exiting) {
        return;
      }
      if (authType) {
        const needsRestart =
          authType === AuthType.LOGIN_WITH_GOOGLE ||
          (authType === AuthType.USE_VERTEX_AI &&
            process.env['CLOUD_SHELL'] === 'true');

        if (needsRestart) {
          setAuthContext({ requiresRestart: true });
        } else {
          setAuthContext({});
        }
        await clearCachedCredentialFile();

        settings.setValue(scope, 'security.auth.selectedType', authType);
        if (
          authType === AuthType.LOGIN_WITH_GOOGLE &&
          config.isBrowserLaunchSuppressed()
        ) {
          setExiting(true);
          setTimeout(relaunchApp, 100);
          return;
        }

        if (authType === AuthType.USE_GEMINI) {
          // Always show the API key input dialog so the user can
          // explicitly enter or confirm their key, regardless of
          // whether GEMINI_API_KEY env var or a stored key exists.
          setAuthState(AuthState.AwaitingApiKeyInput);
          return;
        }
      }
      setAuthState(AuthState.Unauthenticated);
    },
    [settings, config, setAuthState, exiting, setAuthContext],
  );

  // AUDITARIA_PROVIDER_ONLY_START: start Auditaria with no Google account.
  // Persists provider-only auth and resolves through the normal auth effect
  // (refreshAuth is a no-op for provider-only). No provider is chosen here — the
  // user picks one with /model afterwards (a pre-send guard guides them if they
  // send before choosing). The choice then persists for the next launch.
  const handleSkipLogin = useCallback(() => {
    if (exiting) {
      return;
    }
    settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.PROVIDER_ONLY,
    );
    setAuthContext({});
    setAuthState(AuthState.Unauthenticated);
  }, [exiting, settings, setAuthContext, setAuthState]);

  const handleSelect = async (value: string) => {
    if (value === SKIP_LOGIN_VALUE) {
      handleSkipLogin();
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const authMethod = value as AuthType;
    const error = await validateAuthMethodWithSettings(
      authMethod,
      settings,
    ).catch((e) => (e instanceof Error ? e.message : String(e)));
    if (error) {
      onAuthError(error);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      onSelect(authMethod, SettingScope.User);
    }
  };
  // AUDITARIA_PROVIDER_ONLY_END

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        // Prevent exit if there is an error message.
        // This means they user is not authenticated yet.
        if (authError) {
          return true;
        }
        if (settings.merged.security.auth.selectedType === undefined) {
          // Prevent exiting if no auth method is set
          onAuthError(
            'You must select an auth method to proceed. Press Ctrl+C twice to exit.',
          );
          return true;
        }
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        onSelect(undefined, SettingScope.User);
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  if (exiting) {
    return (
      <Box
        borderStyle="round"
        borderColor={theme.ui.focus}
        flexDirection="row"
        padding={1}
        width="100%"
        alignItems="flex-start"
      >
        <Text color={theme.text.primary}>
          Logging in with Google... Restarting Gemini CLI to continue.
        </Text>
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor={theme.ui.focus}
      flexDirection="row"
      padding={1}
      width="100%"
      alignItems="flex-start"
    >
      <Text color={theme.text.accent}>? </Text>
      <Box flexDirection="column" flexGrow={1}>
        <Text bold color={theme.text.primary}>
          Get started
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            How would you like to use Auditaria for this project?
          </Text>
        </Box>
        {/* AUDITARIA_PROVIDER_ONLY: discovery hint for the no-Google path */}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            No Google account? Choose &quot;Skip Google sign-in&quot; below to
            use Claude Code, Codex, Copilot, or Antigravity instead.
          </Text>
        </Box>
        <Box marginTop={1}>
          <RadioButtonSelect
            items={items}
            initialIndex={initialAuthIndex}
            onSelect={handleSelect}
            onHighlight={(value: string) => {
              onAuthError(null);
              setHighlighted(value);
            }}
          />
        </Box>
        {/* AUDITARIA_PROVIDER_ONLY: contextual note for the Google sign-in option */}
        {highlighted === AuthType.LOGIN_WITH_GOOGLE && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {getGoogleOAuthDiscontinuedNote()}
            </Text>
          </Box>
        )}
        {/* AUDITARIA_PROVIDER_ONLY: description for the skip-Google-sign-in option */}
        {highlighted === SKIP_LOGIN_VALUE && (
          <Box marginTop={1}>
            <Text color={theme.text.secondary}>
              {getSkipLoginDescription(availability)}
            </Text>
          </Box>
        )}
        {authError && (
          <Box marginTop={1}>
            <Text color={theme.status.error}>{authError}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>(Use Enter to select)</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.primary}>
            Terms of Services and Privacy Notice for Gemini CLI
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.text.link}>
            {'https://geminicli.com/docs/resources/tos-privacy/'}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
