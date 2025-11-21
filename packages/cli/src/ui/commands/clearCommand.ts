/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { uiTelemetryService, t, clearContextBackups, clearCollaborativeWriting } from '@thacio/auditaria-cli-core'; // AUDITARIA_COLLABORATIVE_WRITING
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

export const clearCommand: SlashCommand = {
  name: 'clear',
  get description() {
    return t('commands.clear.description', 'Clear the screen and conversation history');
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

    // Clear context management backups and hidden content storage
    clearContextBackups(); // Custom Auditaria Feature: context.management.ts tool

    // AUDITARIA_COLLABORATIVE_WRITING - Auditaria Custom Feature
    // Clear collaborative writing registry
    clearCollaborativeWriting();

    uiTelemetryService.setLastPromptTokenCount(0);
    context.ui.clear();
  },
};
