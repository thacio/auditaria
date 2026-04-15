/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: /resume-claude slash command for resuming Claude provider sessions

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import { ClaudeSessionPicker } from '../components/ClaudeSessionPicker.js';
import {
  coreEvents,
  listClaudeSessions,
  validateClaudeSessionId,
  loadClaudeSessionAsContent,
  type ClaudeSessionInfo,
} from '@google/gemini-cli-core';
import { buildUIHistoryFromContent } from '../utils/claudeHistoryProjection.js';

/**
 * Executes the resume: sets session ID on provider, populates the mirrored
 * history and the UI from a single full-fidelity parse of the JSONL file.
 *
 * The same parsed Content[] feeds:
 *   - `client.setHistory()` — the mirrored conversation used by rewind, token
 *     estimation, and any later buildConversationSummary calls.
 *   - `context.ui.loadHistory()` — the visible chat log.
 * Parsing once and projecting to both keeps them from drifting apart.
 */
async function executeResume(
  context: CommandContext,
  sessionId: string,
  filePath: string,
): Promise<void> {
  const config = context.services.agentContext?.config;
  const client = context.services.agentContext?.geminiClient;
  if (!config || !client) {
    coreEvents.emitFeedback('error', 'Config or client not available.');
    return;
  }

  const pm = config.getProviderManager();
  if (!pm) {
    coreEvents.emitFeedback('error', 'Provider manager not available.');
    return;
  }

  // Ensure Claude is active
  if (!config.isExternalProviderActive()) {
    coreEvents.emitFeedback(
      'error',
      'Claude provider is not active. Switch to Claude first via /model.',
    );
    return;
  }

  // Queue the session ID for the next turn. Internally this sets the provider
  // manager's nextTurn to 'resume', overriding any stale 'resetWithSummary'
  // intent (e.g. from a prior /model switch that found non-empty history), so
  // the next call uses `claude --resume <id>` cleanly instead of dumping the
  // conversation summary as a prompt.
  pm.setPendingResumeSessionId(sessionId);

  // Parse the JSONL once into full-fidelity Content[] (text, tool calls, tool
  // results, images, compaction markers). This becomes the mirrored history.
  const mirroredHistory = await loadClaudeSessionAsContent(filePath);
  if (mirroredHistory.length > 0) {
    client.setHistory(mirroredHistory);
  }

  // Init file checkpoint manager for the resumed session
  config.initFileCheckpointManager();

  // Derive UI history from the same Content[] — one parse, two projections.
  const uiHistory = buildUIHistoryFromContent(mirroredHistory);
  if (uiHistory.length > 0) {
    context.ui.loadHistory(uiHistory);
  }

  const shortId = sessionId.slice(0, 8);
  coreEvents.emitFeedback('info', `Resumed Claude session ${shortId}`);
}

export const resumeClaudeCommand: SlashCommand = {
  name: 'resume-claude',
  description: 'Resume a previous Claude provider session',
  kind: CommandKind.BUILT_IN,
  action: async (context, args) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not found.',
      };
    }

    const trimmedArgs = args?.trim() || '';

    // /resume-claude {session-id} — resume specific session
    if (trimmedArgs && trimmedArgs !== 'list' && trimmedArgs.length > 8) {
      const { valid, filePath } = await validateClaudeSessionId(
        config.getTargetDir(),
        trimmedArgs,
      );
      if (!valid) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Claude session ${trimmedArgs.slice(0, 8)}... not found for this project.`,
        };
      }

      await executeResume(context, trimmedArgs, filePath);
      return;
    }

    // /resume-claude or /resume-claude list — show session picker
    const sessions = await listClaudeSessions(config.getTargetDir());

    if (sessions.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No Claude sessions found for this project.',
      };
    }

    return {
      type: 'custom_dialog',
      component: (
        <ClaudeSessionPicker
          sessions={sessions}
          onSelect={async (session: ClaudeSessionInfo) => {
            context.ui.removeComponent();
            await executeResume(context, session.sessionId, session.filePath);
          }}
          onExit={() => {
            context.ui.removeComponent();
          }}
        />
      ),
    };
  },
};
