/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@thacio/auditaria-cli-core';
import { AuthType, OutputFormat, t } from '@thacio/auditaria-cli-core';
import { USER_SETTINGS_PATH } from './config/settings.js';
import { validateAuthMethod } from './config/auth.js';
import { type LoadedSettings } from './config/settings.js';
import { handleError } from './utils/errors.js';

export interface NonInteractiveConfig {
  refreshAuth: (authType: AuthType) => Promise<unknown>;
}

function getAuthTypeFromEnv(): AuthType | undefined {
  if (process.env['GOOGLE_GENAI_USE_GCA'] === 'true') {
    return AuthType.LOGIN_WITH_GOOGLE;
  }
  if (process.env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') {
    return AuthType.USE_VERTEX_AI;
  }
  if (process.env['GEMINI_API_KEY']) {
    return AuthType.USE_GEMINI;
  }
  return undefined;
}

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
  settings: LoadedSettings,
) {
  try {
    const enforcedType = settings.merged.security?.auth?.enforcedType;
    if (enforcedType) {
      const currentAuthType = getAuthTypeFromEnv();
      if (currentAuthType !== enforcedType) {
        const message = t('auth_errors.enforced_auth_type_mismatch_env', `The configured auth type is ${enforcedType}, but the current auth type is ${currentAuthType}. Please re-authenticate with the correct type.`, {
          enforcedType: String(enforcedType),
          currentType: String(currentAuthType),
        });
        throw new Error(message);
      }
    }

    const effectiveAuthType =
      enforcedType || getAuthTypeFromEnv() || configuredAuthType;

    if (!effectiveAuthType) {
      const message = t('non_interactive.auth_method_required', `Please set an Auth method in your ${USER_SETTINGS_PATH} or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA`, { settingsPath: USER_SETTINGS_PATH });
      throw new Error(message);
    }

    const authType: AuthType = effectiveAuthType as AuthType;

    if (!useExternalAuth) {
      const err = validateAuthMethod(String(authType));
      if (err != null) {
        throw new Error(err);
      }
    }

    await nonInteractiveConfig.refreshAuth(authType);
    return nonInteractiveConfig;
  } catch (error) {
    if (nonInteractiveConfig.getOutputFormat() === OutputFormat.JSON) {
      handleError(
        error instanceof Error ? error : new Error(String(error)),
        nonInteractiveConfig,
        1,
      );
    } else {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }
}
