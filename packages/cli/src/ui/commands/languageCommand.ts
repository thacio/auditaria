/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SlashCommand, CommandKind } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const languageCommand: SlashCommand = {
  name: 'language',
  get description() {
    return t('commands.language.description', 'change language preference');
  },
  kind: CommandKind.BUILT_IN,
  action: (_context, _args) => ({
    type: 'dialog',
    dialog: 'language',
  }),
};