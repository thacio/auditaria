/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { formatDuration } from '../utils/formatters.js';
import { CommandKind, type SlashCommand } from './types.js';
import type { HistoryItem } from '../types.js'; // AUDITARIA

export const quitCommand: SlashCommand = {
  name: 'quit',
  altNames: ['exit'],
  description: 'Exit the cli',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: (context, args) => {
    const now = Date.now();
    const { sessionStartTime } = context.session.stats;
    const wallDuration = now - sessionStartTime.getTime();

    const deleteSession = args.trim() === '--delete';

    const messages: HistoryItem[] = [
      // AUDITARIA
      {
        type: 'user',
        text: `/quit`, // Keep it consistent, even if /exit was used
        id: now - 1,
      },
      {
        type: 'quit',
        duration: formatDuration(wallDuration),
        id: now,
      },
    ];

    // AUDITARIA_REWIND_START: Show native provider session ID for resume
    const config = context.services.agentContext?.config;
    if (config?.isExternalProviderActive()) {
      const pm = config.getProviderManager();
      const sessionId = pm?.getDriverSessionId?.();
      const provider = config.getProviderConfig()?.type;
      const name =
        provider === 'claude-cli'
          ? 'Claude'
          : provider === 'codex-cli'
            ? 'Codex'
            : undefined;
      if (sessionId && name) {
        messages.push({
          type: 'info',
          text: `${name} session: ${sessionId}\nResume with: auditaria --resume-${name.toLowerCase()} ${sessionId}`,
          id: now + 1,
        });
      }
    }
    // AUDITARIA_REWIND_END

    return { type: 'quit', deleteSession, messages };
  },
};
