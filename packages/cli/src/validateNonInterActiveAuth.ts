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

export async function validateNonInteractiveAuth(
  configuredAuthType: AuthType | undefined,
  nonInteractiveConfig: Config,
) {
  const effectiveAuthType =
    configuredAuthType ||
    (process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true'
      ? AuthType.USE_VERTEX_AI
      : process.env.GEMINI_API_KEY
        ? AuthType.USE_GEMINI
        : undefined);

  if (!effectiveAuthType) {
    console.error(
      t('non_interactive.auth_method_required', `Please set an Auth method in your ${USER_SETTINGS_PATH} or specify either the GEMINI_API_KEY or GOOGLE_GENAI_USE_VERTEXAI environment variables before running`, { settingsPath: USER_SETTINGS_PATH }),
    );
    process.exit(1);
  }

  const err = validateAuthMethod(effectiveAuthType);
  if (err != null) {
    console.error(err);
    process.exit(1);
  }

  await nonInteractiveConfig.refreshAuth(effectiveAuthType);
  return nonInteractiveConfig;
}
