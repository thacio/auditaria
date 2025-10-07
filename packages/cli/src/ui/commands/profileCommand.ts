/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDevelopment } from '../../utils/installationInfo.js';
import { CommandKind, type SlashCommand } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const profileCommand: SlashCommand | null = isDevelopment
  ? {
      name: 'profile',
      kind: CommandKind.BUILT_IN,
      description: t('commands.profile.description', 'Toggle the debug profile display'),
      action: async (context) => {
        context.ui.toggleDebugProfiler();
        return {
          type: 'message',
          messageType: 'info',
          content: t('commands.profile.toggled', 'Toggled profile display.'),
        };
      },
    }
  : null;
