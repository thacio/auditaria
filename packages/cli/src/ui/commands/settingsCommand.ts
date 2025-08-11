/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { CommandKind, OpenDialogActionReturn, SlashCommand } from './types.js';

export const settingsCommand: SlashCommand = {
  name: 'settings',
  description: t('commands.settings.description', 'View and edit Gemini CLI settings'),
  kind: CommandKind.BUILT_IN,
  action: (_context, _args): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'settings',
  }),
};
