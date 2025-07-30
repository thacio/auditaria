/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SlashCommand, CommandKind, type CommandContext } from './types.js';
import { t } from '@thacio/auditaria-cli-core';
import { openBrowserWithDelay } from '../../utils/browserUtils.js';

export const webCommand: SlashCommand = {
  name: 'web',
  get description() {
    return t('commands.web.description', 'open web interface in browser');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args: string) => {
    if (!context.web) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.web.error.not_available', 'Web interface is not available in this configuration'),
      };
    }

    try {
      // Start the web interface
      const result = await context.web.start();
      
      // Get the actual port where the server started
      const actualPort = result.port?.toString() || '8629';
      
      // Don't show the result message here as it's already shown by the web interface startup
      // Just open browser after a short delay
      setTimeout(async () => {
        const url = `http://localhost:${actualPort}`;
        
        context.ui.addItem(
          {
            type: 'info',
            text: t('commands.web.opening_browser', 'Opening web browser...'),
          },
          Date.now(),
        );

        try {
          await openBrowserWithDelay(url, 1000);
          context.ui.addItem(
            {
              type: 'info',
              text: t('commands.web.available_at', '🌐 Web interface available at http://localhost:{port}', { port: actualPort }),
            },
            Date.now(),
          );
        } catch (error) {
          context.ui.addItem(
            {
              type: 'info',
              text: t('commands.web.browser_open_failed', 'Failed to open browser automatically. Please visit http://localhost:{port} manually.', { port: actualPort }),
            },
            Date.now(),
          );
        }
      }, 500);

      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.web.starting_and_opening', '🌐 Opening web interface in browser...'),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.web.start.error', 'Failed to start web interface: {error}', { 
          error: error instanceof Error ? error.message : String(error) 
        }),
      };
    }
  },
};