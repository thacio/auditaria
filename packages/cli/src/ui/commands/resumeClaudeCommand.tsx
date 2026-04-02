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
import type { HistoryItem } from '../types.js';
import { ClaudeSessionPicker } from '../components/ClaudeSessionPicker.js';
import {
  coreEvents,
  listClaudeSessions,
  validateClaudeSessionId,
  buildClaudeSessionSummary,
  type ClaudeSessionInfo,
} from '@google/gemini-cli-core';
import type { Content } from '@google/genai';

/**
 * Executes the resume: sets session ID on provider, builds mirrored history summary.
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

  // Set pending session ID — applied when driver is created/reused
  pm.setPendingResumeSessionId(sessionId);

  // Build conversation summary and set as mirrored history
  const summary = await buildClaudeSessionSummary(filePath);
  if (summary) {
    const mirroredHistory: Content[] = [
      { role: 'user', parts: [{ text: summary }] },
      {
        role: 'model',
        parts: [
          {
            text: 'Got it. I have the context from the previous session.',
          },
        ],
      },
    ];
    client.setHistory(mirroredHistory);
    // DON'T call onHistoryModified — we want to KEEP the session ID for --resume
  }

  // Init file checkpoint manager for the resumed session
  config.initFileCheckpointManager();

  // Load conversation into the UI so user sees the chat history
  const uiHistory = await buildUIHistoryFromClaudeJSONL(filePath);
  if (uiHistory.length > 0) {
    context.ui.loadHistory(uiHistory);
  }

  const shortId = sessionId.slice(0, 8);
  coreEvents.emitFeedback('info', `Resumed Claude session ${shortId}`);
}

/**
 * Parses a Claude JSONL file and builds HistoryItem[] for UI display.
 * Skips system context, tool results, and metadata entries.
 */
export async function buildUIHistoryFromClaudeJSONL(
  jsonlPath: string,
): Promise<HistoryItem[]> {
  let data: string;
  try {
    const { readFile } = await import('node:fs/promises');
    data = await readFile(jsonlPath, 'utf-8');
  } catch {
    return [];
  }

  const items: HistoryItem[] = [];
  let idCounter = 1;
  const lines = data.split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude JSONL format
      const entry = JSON.parse(line) as Record<string, unknown>;

      // Only process user and assistant conversation messages
      const message = entry.message as
        | { role?: string; content?: unknown }
        | undefined;
      if (!message?.role) continue;

      // Extract text content
      let text = '';
      if (typeof message.content === 'string') {
        text = message.content;
      } else if (Array.isArray(message.content)) {
        const blocks = message.content as Array<{
          type?: string;
          text?: string;
        }>;
        // Skip tool_result user messages
        if (blocks.some((b) => b.type === 'tool_result')) continue;
        const textBlocks = blocks
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text || '');
        text = textBlocks.join('\n');
      }

      if (!text) continue;

      // Skip system context injections
      if (
        text.startsWith('<session_context>') ||
        text.startsWith('<auditaria_conversation_history>')
      ) {
        continue;
      }

      if (message.role === 'user') {
        items.push({ type: 'user', text, id: idCounter++ });
      } else if (message.role === 'assistant') {
        items.push({ type: 'gemini', text, id: idCounter++ });
      }
    } catch {
      // Skip malformed lines
    }
  }

  return items;
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
    if (
      trimmedArgs &&
      trimmedArgs !== 'list' &&
      trimmedArgs.length > 8
    ) {
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
