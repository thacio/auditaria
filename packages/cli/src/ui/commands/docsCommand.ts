/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import open from 'open';
import process from 'node:process';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '@thacio/auditaria-cli-core';

export const docsCommand: SlashCommand = {
  name: 'docs',
  get description() {
    return t('commands.docs.description', 'open full Gemini CLI documentation in your browser');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext): Promise<void> => {
    const docsUrl = 'https://goo.gle/gemini-cli-docs';

    if (process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec') {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('commands.docs.sandbox_message', 'Please open the following URL in your browser to view the documentation:\n{url}', { url: docsUrl }),
        },
        Date.now(),
      );
    } else {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('commands.docs.opening', 'Opening documentation in your browser: {url}', { url: docsUrl }),
        },
        Date.now(),
      );
      await open(docsUrl);
    }
  },
};
