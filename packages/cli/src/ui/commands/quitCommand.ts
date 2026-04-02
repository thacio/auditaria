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
  action: (context) => {
    const now = Date.now();
    const { sessionStartTime } = context.session.stats;
    const wallDuration = now - sessionStartTime.getTime();

    const messages: HistoryItem[] = [ // AUDITARIA
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

    // AUDITARIA_REWIND_START: Show Claude session ID for resume
    const config = context.services.agentContext?.config;
    if (config?.isExternalProviderActive()) {
      const pm = config.getProviderManager();
      const sessionId = pm?.getDriverSessionId?.();
      if (sessionId) {
        messages.push({
          type: 'info',
          text: `Claude session: ${sessionId}\nResume with: auditaria --resume-claude ${sessionId}`,
          id: now + 1,
        });
      }
    }
    // AUDITARIA_REWIND_END

    return { type: 'quit', messages };
  },
};
