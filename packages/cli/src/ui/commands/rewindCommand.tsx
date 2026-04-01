/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import { RewindViewer } from '../components/RewindViewer.js';
import { type HistoryItem } from '../types.js';
import { convertSessionToHistoryFormats } from '../hooks/useSessionBrowser.js';
import { revertFileChanges } from '../utils/rewindFileOps.js';
import { RewindOutcome } from '../components/RewindConfirmation.js';
import type { Content } from '@google/genai';
import {
  checkExhaustive,
  coreEvents,
  debugLogger,
  logRewind,
  RewindEvent,
  type ChatRecordingService,
  type ConversationRecord,
  type MessageRecord,
  type GeminiClient,
  convertSessionToClientHistory,
} from '@google/gemini-cli-core';

// AUDITARIA_REWIND_START: Build ConversationRecord from mirrored GeminiChat history
// for external providers where ChatRecordingService doesn't capture messages.
function buildConversationFromHistory(
  history: readonly Content[],
  sessionId: string,
): ConversationRecord {
  const messages: MessageRecord[] = [];
  let turnIndex = 0; // Counts user turns (maps to snapshot index)
  const baseTime = Date.now();

  for (const entry of history) {
    const textParts = (entry.parts || [])
      .filter((p): p is { text: string } => 'text' in p && typeof p.text === 'string')
      .map((p) => p.text);
    const content = textParts.join('\n') || '';

    if (entry.role === 'user') {
      // Skip function responses (tool results mirrored as user messages)
      const hasFunctionResponse = (entry.parts || []).some(
        (p) => 'functionResponse' in p,
      );
      if (hasFunctionResponse) continue;

      // Skip the initial env context message (not a real user turn)
      if (content.startsWith('<session_context>')) continue;

      // ID encodes turnIndex for snapshot matching: ext-turn-{index}
      messages.push({
        id: `ext-turn-${turnIndex}`,
        timestamp: new Date(baseTime - (history.length * 1000) + (messages.length * 1000)).toISOString(),
        content,
        type: 'user',
      });
      turnIndex++;
    } else if (entry.role === 'model') {
      messages.push({
        id: `ext-model-${turnIndex}`,
        timestamp: new Date(baseTime - (history.length * 1000) + (messages.length * 1000)).toISOString(),
        content,
        type: 'gemini',
        model: 'external',
      });
    }
  }

  return {
    sessionId,
    projectHash: '',
    startTime: new Date(baseTime - (history.length * 1000)).toISOString(),
    lastUpdated: new Date(baseTime).toISOString(),
    messages,
  };
}
// AUDITARIA_REWIND_END

/**
 * Helper function to handle the core logic of rewinding a conversation.
 * This function encapsulates the steps needed to rewind the conversation,
 * update the client and UI history, and clear the component.
 *
 * @param context The command context.
 * @param client Gemini client
 * @param recordingService The chat recording service.
 * @param messageId The ID of the message to rewind to.
 * @param newText The new text for the input field after rewinding.
 */
async function rewindConversation(
  context: CommandContext,
  client: GeminiClient,
  recordingService: ChatRecordingService,
  messageId: string,
  newText: string,
) {
  try {
    const config = context.services.agentContext?.config;
    const isExternalProvider = config?.isExternalProviderActive() ?? false;

    // AUDITARIA_REWIND_START: For external providers, rewind the mirrored history directly
    if (isExternalProvider) {
      const history = client.getHistory();
      // IDs are "ext-turn-{turnIndex}" — find the Nth user message in history
      const turnMatch = messageId.match(/ext-turn-(\d+)/);
      const targetTurn = turnMatch ? parseInt(turnMatch[1], 10) : 0;

      // Walk through history, count user turns (skipping functionResponse entries)
      let turnCount = 0;
      let cutIndex = 0;
      for (let i = 0; i < history.length; i++) {
        const entry = history[i];
        if (entry.role === 'user') {
          const hasFunctionResponse = (entry.parts || []).some(
            (p) => 'functionResponse' in p,
          );
          if (hasFunctionResponse) continue;
          if (turnCount === targetTurn) {
            cutIndex = i;
            break;
          }
          turnCount++;
        }
      }

      // Truncate mirrored history up to (not including) the target user message
      const newHistory = history.slice(0, cutIndex);
      client.setHistory(newHistory as Content[]);

      // Notify provider manager to reset Claude's session — next turn will
      // start a fresh subprocess with conversation summary from mirrored history
      config?.getProviderManager()?.onHistoryModified();

      // Reset context manager
      await config?.getContextManager()?.refresh();

      // Remove component and feedback
      context.ui.removeComponent();
      coreEvents.emitFeedback('info', 'Conversation rewound.');
      return;
    }
    // AUDITARIA_REWIND_END

    const conversation = recordingService.rewindTo(messageId);
    if (!conversation) {
      const errorMsg = 'Could not fetch conversation file';
      debugLogger.error(errorMsg);
      context.ui.removeComponent();
      coreEvents.emitFeedback('error', errorMsg);
      return;
    }

    // Convert to UI and Client formats
    const { uiHistory } = convertSessionToHistoryFormats(conversation.messages);
    const clientHistory = convertSessionToClientHistory(conversation.messages);

    client.setHistory(clientHistory as Content[]);

    // Reset context manager as we are rewinding history
    await context.services.agentContext?.config.getContextManager()?.refresh();

    // Update UI History
    // We generate IDs based on index for the rewind history
    const startId = 1;
    const historyWithIds = uiHistory.map(
      (item, idx) =>
        ({
          ...item,
          id: startId + idx,
        }) as HistoryItem,
    );

    // 1. Remove component FIRST to avoid flicker and clear the stage
    context.ui.removeComponent();

    // 2. Load the rewound history and set the input
    context.ui.loadHistory(historyWithIds, newText);
  } catch (error) {
    // If an error occurs, we still want to remove the component if possible
    context.ui.removeComponent();
    coreEvents.emitFeedback(
      'error',
      error instanceof Error ? error.message : 'Unknown error during rewind',
    );
  }
}

export const rewindCommand: SlashCommand = {
  name: 'rewind',
  description: 'Jump back to a specific message and restart the conversation',
  kind: CommandKind.BUILT_IN,
  action: (context) => {
    const agentContext = context.services.agentContext;
    const config = agentContext?.config;
    if (!config)
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not found',
      };

    const client = agentContext.geminiClient;
    if (!client)
      return {
        type: 'message',
        messageType: 'error',
        content: 'Client not initialized',
      };

    const recordingService = client.getChatRecordingService();
    if (!recordingService)
      return {
        type: 'message',
        messageType: 'error',
        content: 'Recording service unavailable',
      };

    // AUDITARIA_REWIND_START: For external providers, the recording service has no data
    // because GeminiChat.sendMessageStream() is bypassed. Build conversation from mirrored history.
    let conversation = recordingService.getConversation();
    const isExternalProvider = config.isExternalProviderActive();
    const fcm = config.getFileCheckpointManager(); // AUDITARIA_REWIND

    if (isExternalProvider) {
      const history = client.getHistory();
      if (history.length > 0) {
        conversation = buildConversationFromHistory(
          history,
          config.getSessionId(),
        );
      }
    }
    // AUDITARIA_REWIND_END

    if (!conversation)
      return {
        type: 'message',
        messageType: 'info',
        content: 'No conversation found.',
      };

    const hasUserInteractions = conversation.messages.some(
      (msg) => msg.type === 'user',
    );
    if (!hasUserInteractions) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Nothing to rewind to.',
      };
    }

    return {
      type: 'custom_dialog',
      component: (
        <RewindViewer
          conversation={conversation}
          forceShowRevert={isExternalProvider && !!fcm?.hasSnapshots()} // AUDITARIA_REWIND
          fileCheckpointManager={isExternalProvider ? fcm : undefined} // AUDITARIA_REWIND
          onExit={() => {
            context.ui.removeComponent();
          }}
          onRewind={async (messageId, newText, outcome) => {
            if (outcome !== RewindOutcome.Cancel) {
              logRewind(config, new RewindEvent(outcome));
            }
            // AUDITARIA_REWIND_START: File checkpoint revert for external providers
            const revertFiles = async () => {
              if (isExternalProvider && fcm?.hasSnapshots()) {
                // External provider: use our file checkpoint system
                // messageId is "ext-turn-{index}" — extract the turn index
                // Rewind to turnIndex: snapshot[N] has the pre-turn-N state (what files
                // looked like before this turn's edits = what user saw when typing this message)
                const turnMatch = messageId.match(/ext-turn-(\d+)/);
                const turnIndex = turnMatch ? parseInt(turnMatch[1], 10) : 0;
                const changed = await fcm.rewindTo(turnIndex);
                if (changed.length > 0) {
                  coreEvents.emitFeedback('info', `Reverted ${changed.length} file(s).`);
                } else {
                  coreEvents.emitFeedback('info', 'No file changes to revert.');
                }
              } else if (conversation) {
                // Gemini: use upstream's diff-based revert
                await revertFileChanges(conversation, messageId);
                coreEvents.emitFeedback('info', 'File changes reverted.');
              }
            };
            // AUDITARIA_REWIND_END
            switch (outcome) {
              case RewindOutcome.Cancel:
                context.ui.removeComponent();
                return;

              case RewindOutcome.RevertOnly:
                await revertFiles(); // AUDITARIA_REWIND
                context.ui.removeComponent();
                return;

              case RewindOutcome.RewindAndRevert:
                await revertFiles(); // AUDITARIA_REWIND
                await rewindConversation(
                  context,
                  client,
                  recordingService,
                  messageId,
                  newText,
                );
                return;

              case RewindOutcome.RewindOnly:
                await rewindConversation(
                  context,
                  client,
                  recordingService,
                  messageId,
                  newText,
                );
                return;

              default:
                checkExhaustive(outcome);
            }
          }}
        />
      ),
    };
  },
};
