/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, Config, t } from '@thacio/auditaria-cli-core';
import { USER_SETTINGS_PATH } from './config/settings.js';
import { validateAuthMethod } from './config/auth.js';

export interface NonInteractiveConfig {
  refreshAuth: (authType: AuthType) => Promise<unknown>;
}

function getAuthTypeFromEnv(): AuthType | undefined {
  if (process.env.GOOGLE_GENAI_USE_GCA === 'true') {
    return AuthType.LOGIN_WITH_GOOGLE;
  }
  if (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true') {
    return AuthType.USE_VERTEX_AI;
  }
  if (process.env.GEMINI_API_KEY) {
    return AuthType.USE_GEMINI;
  }
  return undefined;
}

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  useExternalAuth: boolean | undefined,
  nonInteractiveConfig: Config,
) {
  const effectiveAuthType = configuredAuthType || getAuthTypeFromEnv();

  if (!effectiveAuthType) {
    console.error(
      t('non_interactive.auth_method_required', `Please set an Auth method in your ${USER_SETTINGS_PATH} or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA`, { settingsPath: USER_SETTINGS_PATH }),
    );
    process.exit(1);
  }

  if (!useExternalAuth) {
    const err = validateAuthMethod(effectiveAuthType);
    if (err != null) {
      console.error(err);
      process.exit(1);
    }
  }

  await nonInteractiveConfig.refreshAuth(effectiveAuthType);
  return nonInteractiveConfig;
}
