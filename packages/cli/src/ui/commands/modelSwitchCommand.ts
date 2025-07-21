/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_GEMINI_MODEL, DEFAULT_GEMINI_FLASH_MODEL, t } from '@thacio/auditaria-cli-core';
import { type SlashCommand, CommandKind } from './types.js';

export const modelSwitchCommand: SlashCommand = {
  name: 'model-switch',
  get description() {
    return t('commands.model_switch.description', 'switch between Gemini Pro and Flash models');
  },
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
      content: t('commands.model_switch.switched', 'Model switched to: {model} ({type})', { model: newModel, type: isCurrentlyPro ? 'Flash' : 'Pro' }),
    };
  },
};