/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SlashCommand } from './types.js';

export const languageCommand: SlashCommand = {
  name: 'language',
  description: 'change language preference',
  action: (context, _args) => {
    return {
      type: 'dialog',
      dialog: 'language',
    };
  },
};