/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: `/provider terminal|status|cancel|restart` —
 * local recovery for a PTY-driven provider (Claude). Slash commands are
 * admitted while a turn is responding, so these work exactly when they are
 * needed: a dialog waiting inside the TUI, a stuck turn, a dead process.
 * `terminal` opens the web terminal when a web client is attached, otherwise
 * an in-CLI hand-off that shows the TUI screen and forwards keystrokes
 * (Ctrl+Q returns to chat).
 */

import { createElement } from 'react';
import type { Config } from '@google/gemini-cli-core';
import { CommandKind, type SlashCommand } from './types.js';
import { ProviderTerminalHandoff } from '../components/ProviderTerminalHandoff.js';
import { webTerminalBridge } from '../../services/webTerminalBridge.js';

export function providerCommand(config?: Config | null): SlashCommand {
  return {
    name: 'provider',
    description:
      'Provider terminal recovery: terminal | status | cancel | restart',
    kind: CommandKind.BUILT_IN,
    isSafeConcurrent: true,
    action: async (context, args) => {
      const manager = config?.getProviderManager();
      if (!manager || !manager.supportsRecovery()) {
        return {
          type: 'message',
          messageType: 'info',
          content:
            'No live provider terminal. Select a PTY provider (e.g. Claude Code) with /model and send a message first.',
        };
      }
      const action = args.trim().split(/\s+/)[0]?.toLowerCase() || 'status';
      switch (action) {
        case 'cancel':
          manager.interruptActiveTurn();
          return {
            type: 'message',
            messageType: 'info',
            content: 'Sent Esc to the provider terminal.',
          };
        case 'restart':
          manager.restartProvider();
          return;
        case 'terminal':
          if (webTerminalBridge.hasConnectedClients()) {
            webTerminalBridge.requestOpenTerminal();
            return {
              type: 'message',
              messageType: 'info',
              content: 'Opened the provider terminal in the web interface.',
            };
          }
          return {
            type: 'custom_dialog',
            component: createElement(ProviderTerminalHandoff, {
              getScreen: () =>
                manager.getProviderScreen() ?? Promise.resolve(''),
              sendInput: (bytes: string) => manager.writeProviderInput(bytes),
              onClose: context.ui.removeComponent,
            }),
          };
        case 'status': {
          const status = manager.getProviderStatus();
          const lines = [
            `Provider: ${manager.getModel()}`,
            `Process: ${status?.ptyAlive ? 'running' : 'not running'}`,
            `Session: ${status?.sessionId ?? 'none yet'}`,
            `Turn: ${status?.turn ? `${status.turn.source} (${status.turn.promptId.slice(0, 8)})` : 'idle'}`,
            status?.pendingPrompts
              ? 'Waiting: an interactive prompt needs an answer in the terminal.'
              : '',
            'Commands: /provider terminal · /provider cancel · /provider restart',
          ].filter(Boolean);
          return {
            type: 'message',
            messageType: 'info',
            content: lines.join('\n'),
          };
        }
        default:
          return {
            type: 'message',
            messageType: 'error',
            content: 'Usage: /provider [terminal | status | cancel | restart]',
          };
      }
    },
  };
}
