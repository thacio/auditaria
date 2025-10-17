/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useCallback } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { AuthType, type Config } from '@thacio/auditaria-cli-core';
import { getErrorMessage, t } from '@thacio/auditaria-cli-core';
import { AuthState } from '../types.js';
import { validateAuthMethod } from '../../config/auth.js';

export function validateAuthMethodWithSettings(
  authType: AuthType,
  settings: LoadedSettings,
): string | null {
  const enforcedType = settings.merged.security?.auth?.enforcedType;
  if (enforcedType && enforcedType !== authType) {
    return t(
      'auth_errors.enforced_auth_mismatch',
      `Authentication is enforced to be ${enforcedType}, but you are currently using ${authType}.`,
      { enforcedType: String(enforcedType), currentType: String(authType) },
    );
  }
  if (settings.merged.security?.auth?.useExternal) {
    return null;
  }
  return validateAuthMethod(authType);
}

export const useAuthCommand = (settings: LoadedSettings, config: Config) => {
  const [authState, setAuthState] = useState<AuthState>(
    AuthState.Unauthenticated,
  );

  const [authError, setAuthError] = useState<string | null>(null);

  const onAuthError = useCallback(
    (error: string | null) => {
      setAuthError(error);
      if (error) {
        setAuthState(AuthState.Updating);
      }
    },
    [setAuthError, setAuthState],
  );

  useEffect(() => {
    (async () => {
      if (authState !== AuthState.Unauthenticated) {
        return;
      }

      const authType = settings.merged.security?.auth?.selectedType;
      if (!authType) {
        if (process.env['GEMINI_API_KEY']) {
          onAuthError(
            t(
              'auth_dialog.messages.api_key_detected',
              'Existing API key detected (GEMINI_API_KEY). Select "Gemini API Key" option to use it.',
            ),
          );
        } else {
          onAuthError(
            t(
              'auth_dialog.messages.no_auth_selected',
              'No authentication method selected.',
            ),
          );
        }
        return;
      }
      const error = validateAuthMethodWithSettings(authType, settings);
      if (error) {
        onAuthError(error);
        return;
      }

      const defaultAuthType = process.env['GEMINI_DEFAULT_AUTH_TYPE'];
      if (
        defaultAuthType &&
        !Object.values(AuthType).includes(defaultAuthType as AuthType)
      ) {
        onAuthError(
          t(
            'auth_dialog.messages.invalid_default_auth_type',
            `Invalid value for GEMINI_DEFAULT_AUTH_TYPE: "${defaultAuthType}". Valid values are: ${Object.values(AuthType).join(', ')}.`,
            {
              defaultAuthType,
              validValues: Object.values(AuthType).join(', '),
            },
          ),
        );
        return;
      }

      try {
        await config.refreshAuth(authType);

        console.log(
          t(
            'auth_dialog.messages.authenticated_via',
            `Authenticated via "${authType}".`,
            { authType: String(authType) },
          ),
        );
        setAuthError(null);
        setAuthState(AuthState.Authenticated);
      } catch (e) {
        onAuthError(
          t(
            'auth_dialog.messages.failed_login',
            'Failed to login. Message: {error}',
            { error: getErrorMessage(e) },
          ),
        );
      }
    })();
  }, [settings, config, authState, setAuthState, setAuthError, onAuthError]);

  return {
    authState,
    setAuthState,
    authError,
    onAuthError,
  };
};
