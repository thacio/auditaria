/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_FLASH_MODEL } from '@google/gemini-cli-core';
import { type SlashCommand, CommandKind } from './types.js';

export const modelSwitchCommand: SlashCommand = {
  name: 'model-switch',
  description: 'switch between Gemini Pro and Flash models',
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
    const { config } = context.services;
    if (!config) return;

    const currentModel = config.getModel();

    // Toggle between Pro and Flash using existing constants
    const isCurrentlyPro = currentModel === DEFAULT_GEMINI_MODEL || !currentModel;
    const newModel = isCurrentlyPro ? DEFAULT_GEMINI_FLASH_MODEL : DEFAULT_GEMINI_MODEL;

    config.setModel(newModel);

    return {
      type: 'message',
      messageType: 'info',
      content: `Model switched to: ${newModel} (${isCurrentlyPro ? 'Flash' : 'Pro'})`,
    };
  },
};