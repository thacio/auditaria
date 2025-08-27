/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '@thacio/auditaria-cli-core';

export const toolsCommand: SlashCommand = {
  name: 'tools',
  get description() {
    return t('commands.tools.description_with_usage', 'list available Gemini CLI tools. Usage: /tools [desc]');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args?: string): Promise<void> => {
    const subCommand = args?.trim();

    // Default to NOT showing descriptions. The user must opt in with an argument.
    let useShowDescriptions = false;
    if (subCommand === 'desc' || subCommand === 'descriptions') {
      useShowDescriptions = true;
    }

    const toolRegistry = context.services.config?.getToolRegistry();
    if (!toolRegistry) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('commands.tools.error_retrieve', 'Could not retrieve tools.'),
        },
        Date.now(),
      );
      return;
    }

    const tools = toolRegistry.getAllTools();
    // Filter out MCP tools by checking for the absence of a serverName property
    const geminiTools = tools.filter((tool) => !('serverName' in tool));

    let message = t('commands.tools.available_tools', 'Available Gemini CLI tools:') + '\n\n';

    if (geminiTools.length > 0) {
      geminiTools.forEach((tool) => {
        if (useShowDescriptions && tool.description) {
          message += `  - \u001b[36m${tool.displayName} (${tool.name})\u001b[0m:\n`;

          const greenColor = '\u001b[32m';
          const resetColor = '\u001b[0m';

          // Handle multi-line descriptions
          const descLines = tool.description.trim().split('\n');
          for (const descLine of descLines) {
            message += `      ${greenColor}${descLine}${resetColor}\n`;
          }
        } else {
          message += `  - \u001b[36m${tool.displayName}\u001b[0m\n`;
        }
      });
    } else {
      message += '  ' + t('commands.tools.no_tools', 'No tools available') + '\n';
    }
    message += '\n';

    message += '\u001b[0m';

    context.ui.addItem({ type: MessageType.INFO, text: message }, Date.now());
  },
};
