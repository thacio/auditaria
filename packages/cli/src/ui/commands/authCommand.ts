/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { OpenDialogActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const authCommand: SlashCommand = {
  name: 'auth',
  get description() {
    return t('commands.auth.description', 'Change the auth method');
  },
  kind: CommandKind.BUILT_IN,
  action: (_context, _args): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'auth',
  }),
};
