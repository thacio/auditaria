/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { OpenDialogActionReturn, SlashCommand } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const themeCommand: SlashCommand = {
  name: 'theme',
  description: t('commands.theme.description', 'change the theme'),
  action: (_context, _args): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'theme',
  }),
};
