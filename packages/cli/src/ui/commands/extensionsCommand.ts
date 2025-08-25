/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '@google/gemini-cli-core';

export const extensionsCommand: SlashCommand = {
  name: 'extensions',
  get description() {
    return t('commands.extensions.description', 'list active extensions');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext): Promise<void> => {
    const activeExtensions = context.services.config
      ?.getExtensions()
      .filter((ext) => ext.isActive);
    if (!activeExtensions || activeExtensions.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('commands.extensions.no_extensions', 'No active extensions.'),
        },
        Date.now(),
      );
      return;
    }

    const extensionLines = activeExtensions.map(
      (ext) => `  - \u001b[36m${ext.name} (v${ext.version})\u001b[0m`,
    );
    const message = `${t('commands.extensions.active_extensions', 'Active extensions:')}\n\n${extensionLines.join('\n')}\n`;

    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: message,
      },
      Date.now(),
    );
  },
};
