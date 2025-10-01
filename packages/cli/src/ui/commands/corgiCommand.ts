/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const corgiCommand: SlashCommand = {
  name: 'corgi',
  get description() {
    return t('commands.corgi.description', 'Toggles corgi mode.');
  },
  hidden: true,
  kind: CommandKind.BUILT_IN,
  action: (context, _args) => {
    context.ui.toggleCorgiMode();
  },
};
