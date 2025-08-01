/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@thacio/auditaria-cli-core';
import { copyToClipboard } from '../utils/commandUtils.js';
import {
  CommandKind,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';

export const copyCommand: SlashCommand = {
  name: 'copy',
  get description() {
    return t('commands.copy.description', 'Copy the last result or code snippet to clipboard');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, _args): Promise<SlashCommandActionReturn | void> => {
    const chat = await context.services.config?.getGeminiClient()?.getChat();
    const history = chat?.getHistory();

    // Get the last message from the AI (model role)
    const lastAiMessage = history
      ? history.filter((item) => item.role === 'model').pop()
      : undefined;

    if (!lastAiMessage) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.copy.no_output', 'No output in history'),
      };
    }
    // Extract text from the parts
    const lastAiOutput = lastAiMessage.parts
      ?.filter((part) => part.text)
      .map((part) => part.text)
      .join('');

    if (lastAiOutput) {
      try {
        await copyToClipboard(lastAiOutput);

        return {
          type: 'message',
          messageType: 'info',
          content: t('commands.copy.success', 'Last output copied to the clipboard'),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.debug(message);

        return {
          type: 'message',
          messageType: 'error',
          content: t('commands.copy.error', 'Failed to copy to the clipboard.'),
        };
      }
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.copy.no_text', 'Last AI output contains no text to copy.'),
      };
    }
  },
};
