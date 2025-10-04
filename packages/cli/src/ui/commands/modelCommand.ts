/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import { t } from '@thacio/auditaria-cli-core';

export const modelCommand: SlashCommand = {
  name: 'model',
  description: t('commands.model.description', 'Opens a dialog to configure the model'),
  kind: CommandKind.BUILT_IN,
  action: async () => ({
    type: 'dialog',
    dialog: 'model',
  }),
};
