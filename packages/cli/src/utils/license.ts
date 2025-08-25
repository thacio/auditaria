/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType, UserTierId, t } from '@google/gemini-cli-core';

/**
 * Get human-readable license display text based on auth type and user tier.
 * @param selectedAuthType - The authentication type selected by the user
 * @param userTier - Optional user tier information from the server
 * @returns Human-readable license information
 */
export function getLicenseDisplay(
  selectedAuthType: string,
  userTier?: UserTierId,
): string {
  switch (selectedAuthType) {
    case AuthType.LOGIN_WITH_GOOGLE:
      return t('license.free_tier', 'Free Tier (Login with Google)');

    case AuthType.LOGIN_WITH_GOOGLE_GCA:
      if (userTier === UserTierId.STANDARD) {
        return t('license.gca_standard', 'Gemini Code Assist Standard (Google Workspace)');
      } else if (userTier === UserTierId.LEGACY) {
        return t('license.gca_enterprise', 'Gemini Code Assist Enterprise (Google Workspace)');
      }
      return t('license.gca_generic', 'Gemini Code Assist (Google Workspace)');

    case AuthType.USE_GEMINI:
      return t('license.gemini_api_key', 'Gemini API Key');

    case AuthType.USE_VERTEX_AI:
      return t('license.vertex_ai', 'Vertex AI');

    case AuthType.CLOUD_SHELL:
      return t('license.cloud_shell', 'Cloud Shell');

    default:
      return selectedAuthType;
  }
}
