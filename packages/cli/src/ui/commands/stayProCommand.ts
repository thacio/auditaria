/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SlashCommand, CommandKind } from './types.js';

export const stayProCommand: SlashCommand = {
  name: 'stay-pro',
  description: 'toggle whether to stay on Pro model (disable/enable fallback to Flash)',
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
    const { config } = context.services;
    if (!config) return;
    
    const currentState = config.getDisableFallbackForSession();
    const newState = !currentState;
    config.setDisableFallbackForSession(newState);
    
    return {
      type: 'message',
      messageType: 'info',
      content: newState
        ? 'Fallback disabled - will stay on Gemini Pro even if rate limited'
        : 'Fallback enabled - will switch to Flash if Pro is rate limited',
    };
  },
};