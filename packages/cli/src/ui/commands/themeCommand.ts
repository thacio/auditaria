/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, OpenDialogActionReturn, SlashCommand } from './types.js';
import { t } from '@google/gemini-cli-core';

export const themeCommand: SlashCommand = {
  name: 'theme',
  get description() {
    return t('commands.theme.description', 'change the theme');
  },
  kind: CommandKind.BUILT_IN,
  action: (_context, _args): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'theme',
  }),
};
