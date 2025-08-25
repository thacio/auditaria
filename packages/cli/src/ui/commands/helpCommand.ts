/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, SlashCommand } from './types.js';
import { MessageType, type HistoryItemHelp } from '../types.js';
import { t } from '@google/gemini-cli-core';

export const helpCommand: SlashCommand = {
  name: 'help',
  altNames: ['?'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('commands.help.description', 'for help on gemini-cli');
  },
  action: async (context) => {
    const helpItem: Omit<HistoryItemHelp, 'id'> = {
      type: MessageType.HELP,
      timestamp: new Date(),
    };

    context.ui.addItem(helpItem, Date.now());
  },
};
