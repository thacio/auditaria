/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, OpenDialogActionReturn, SlashCommand } from './types.js';
import { t } from '@google/gemini-cli-core';

export const privacyCommand: SlashCommand = {
  name: 'privacy',
  get description() {
    return t('commands.privacy.description', 'display the privacy notice');
  },
  kind: CommandKind.BUILT_IN,
  action: (): OpenDialogActionReturn => ({
    type: 'dialog',
    dialog: 'privacy',
  }),
};
