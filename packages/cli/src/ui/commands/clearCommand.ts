/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { uiTelemetryService } from '@google/gemini-cli-core';
import { CommandKind, SlashCommand } from './types.js';
import { t } from '@google/gemini-cli-core';

export const clearCommand: SlashCommand = {
  name: 'clear',
  get description() {
    return t('commands.clear.description', 'clear the screen and conversation history');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
    const geminiClient = context.services.config?.getGeminiClient();

    if (geminiClient) {
      context.ui.setDebugMessage(t('commands.clear.debug_reset', 'Clearing terminal and resetting chat.'));
      // If resetChat fails, the exception will propagate and halt the command,
      // which is the correct behavior to signal a failure to the user.
      await geminiClient.resetChat();
    } else {
      context.ui.setDebugMessage(t('commands.clear.debug_clear', 'Clearing terminal.'));
    }

    uiTelemetryService.resetLastPromptTokenCount();
    context.ui.clear();
  },
};
