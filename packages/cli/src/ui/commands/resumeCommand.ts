/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { browseConversations, chatResumeSubCommands } from './chatCommand.js';

export const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Browse auto-saved conversations and manage chat checkpoints',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: browseConversations,
  subCommands: chatResumeSubCommands,
};
