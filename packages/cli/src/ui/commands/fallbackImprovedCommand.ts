/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '@google/gemini-cli-core';
import { type SlashCommand, CommandKind } from './types.js';

export const fallbackImprovedCommand: SlashCommand = {
  name: 'fallback-improved',
  get description() {
    return t('commands.fallback_improved.description', 'toggle between improved fallback strategy (7 attempts, 2s delays, reset to Pro) and original Google behavior (2 attempts, exponential backoff)');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
    const { config } = context.services;
    if (!config) return;
    
    const currentStrategy = config.getUseImprovedFallbackStrategy();
    const newStrategy = !currentStrategy;
    config.setUseImprovedFallbackStrategy(newStrategy);
    
    const currentMode = currentStrategy ? 'improved' : 'original';
    const newMode = newStrategy ? 'improved' : 'original';
    const description = newMode === 'improved' 
      ? t('commands.fallback_improved.improved_description', 'Improved strategy: 7 attempts with 2s delays, reset to Pro on each message')
      : t('commands.fallback_improved.original_description', 'Original strategy: 2 attempts with exponential backoff, stay on Flash once switched');
    
    return {
      type: 'message',
      messageType: 'info',
      content: t('commands.fallback_improved.switched', 'Fallback strategy switched from {currentMode} to {newMode}.\n\n{description}', { currentMode, newMode, description }),
    };
  },
};