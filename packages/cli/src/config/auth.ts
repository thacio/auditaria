/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, t } from '@thacio/auditaria-cli-core';
import { loadEnvironment, loadSettings } from './settings.js';

export function validateAuthMethod(authMethod: string): string | null {
  loadEnvironment(loadSettings().merged);
  if (
    authMethod === AuthType.LOGIN_WITH_GOOGLE ||
    authMethod === AuthType.CLOUD_SHELL
  ) {
    return null;
  }

  if (authMethod === AuthType.LOGIN_WITH_GOOGLE_GCA) {
    if (!process.env['GOOGLE_CLOUD_PROJECT']) {
      return t(
        'auth_errors.gca_project_not_set',
        '[Error] GOOGLE_CLOUD_PROJECT is not set.\n' +
          'Please set it using:\n' +
          '  export GOOGLE_CLOUD_PROJECT=<your-project-id>\n' +
          'and try again.',
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_GEMINI) {
    if (!process.env['GEMINI_API_KEY']) {
      return t(
        'auth_errors.gemini_api_key_not_found',
        'GEMINI_API_KEY not found. Find your existing key or generate a new one at: https://aistudio.google.com/apikey\n' +
          '\n' +
          'To continue, please set the GEMINI_API_KEY environment variable or add it to a .env file.',
      );
    }
    return null;
  }

  if (authMethod === AuthType.USE_VERTEX_AI) {
    const hasVertexProjectLocationConfig =
      !!process.env['GOOGLE_CLOUD_PROJECT'] &&
      !!process.env['GOOGLE_CLOUD_LOCATION'];
    const hasGoogleApiKey = !!process.env['GOOGLE_API_KEY'];
    if (!hasVertexProjectLocationConfig && !hasGoogleApiKey) {
      return t(
        'auth_errors.vertex_ai_env_vars_missing',
        'When using Vertex AI, you must specify either:\n• GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION environment variables.\n• GOOGLE_API_KEY environment variable (if using express mode).\nUpdate your environment and try again (no reload needed if using .env)!',
      );
    }
    return null;
  }

  return t('auth_errors.invalid_method', 'Invalid auth method selected.');
}
