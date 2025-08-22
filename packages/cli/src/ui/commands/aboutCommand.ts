/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getCliVersion } from '../../utils/version.js';
import { CommandKind, SlashCommand } from './types.js';
import process from 'node:process';
import { MessageType, type HistoryItemAbout } from '../types.js';
import { t } from '@thacio/auditaria-cli-core';

export const aboutCommand: SlashCommand = {
  name: 'about',
  get description() {
    return t('commands.about.description', 'show version info');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context) => {
    const osVersion = process.platform;
    let sandboxEnv = t('commands.about.no_sandbox', 'no sandbox');
    if (process.env['SANDBOX'] && process.env['SANDBOX'] !== 'sandbox-exec') {
      sandboxEnv = process.env['SANDBOX'];
    } else if (process.env['SANDBOX'] === 'sandbox-exec') {
      sandboxEnv = `sandbox-exec (${
        process.env['SEATBELT_PROFILE'] || t('commands.about.unknown_profile', 'unknown')
      })`;
    }
    const modelVersion = context.services.config?.getModel() || t('commands.about.unknown_model', 'Unknown');
    const cliVersion = await getCliVersion();
    const selectedAuthType =
      context.services.settings.merged.selectedAuthType || '';
    // Only show GCP Project for auth types that actually use it
    const gcpProject =
      selectedAuthType === 'oauth-gca' ||
      selectedAuthType === 'vertex-ai' ||
      selectedAuthType === 'cloud-shell'
        ? process.env['GOOGLE_CLOUD_PROJECT'] || ''
        : '';
    const ideClient =
      (context.services.config?.getIdeMode() &&
        context.services.config?.getIdeClient()?.getDetectedIdeDisplayName()) ||
      '';
    const userTier = context.services.config?.getGeminiClient()?.getUserTier();

    const aboutItem: Omit<HistoryItemAbout, 'id'> = {
      type: MessageType.ABOUT,
      cliVersion,
      osVersion,
      sandboxEnv,
      modelVersion,
      selectedAuthType,
      gcpProject,
      ideClient,
      userTier,
    };

    context.ui.addItem(aboutItem, Date.now());
  },
};
