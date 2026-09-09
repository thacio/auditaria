/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA: Common native session resume flow for Claude and Codex.
import {
  coreEvents,
  externalSessionProviders,
  type ResumableExternalProvider,
} from '@google/gemini-cli-core';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import { ExternalSessionPicker } from '../components/ExternalSessionPicker.js';
import { buildUIHistoryFromContent } from '../utils/externalHistoryProjection.js';

export function createResumeExternalCommand(
  provider: ResumableExternalProvider,
): SlashCommand {
  const adapter = externalSessionProviders[provider];
  const check = (context: CommandContext): string | undefined => {
    const config = context.services.agentContext?.config;
    if (!config || !context.services.agentContext?.geminiClient)
      return 'Config or client not available.';
    if (config.getProviderConfig()?.type !== adapter.type)
      return `${adapter.name} provider is not active. Switch to ${adapter.name} first via /model.`;
    const pm = config.getProviderManager();
    if (!pm) return 'Provider manager not available.';
    if (pm.isTurnActive())
      return 'Wait for the current turn to finish before resuming a session.';
    return undefined;
  };
  const execute = async (
    context: CommandContext,
    sessionId: string,
    filePath: string,
  ) => {
    try {
      // Load before mutating anything: failed reads must leave the current chat intact.
      const history = await adapter.load(filePath);
      if (!history.length)
        throw new Error(
          'No conversation content could be read from this session.',
        );
      const error = check(context);
      if (error) throw new Error(error);
      const { config, geminiClient } = context.services.agentContext!;
      geminiClient.setHistory(history);
      config.getProviderManager()!.setPendingResumeSessionId(sessionId);
      config.initFileCheckpointManager();
      context.ui.loadHistory(buildUIHistoryFromContent(history));
      coreEvents.emitFeedback(
        'info',
        `Resumed ${adapter.name} session ${sessionId.slice(0, 8)}`,
      );
    } catch (error) {
      coreEvents.emitFeedback(
        'error',
        `Could not resume ${adapter.name} session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  return {
    name: `resume-${provider}`,
    description: `Resume a previous ${adapter.name} provider session`,
    kind: CommandKind.BUILT_IN,
    action: async (context, args) => {
      const error = check(context);
      if (error)
        return { type: 'message', messageType: 'error', content: error };
      const cwd = context.services.agentContext!.config.getTargetDir();
      const id = args?.trim() || '';
      try {
        if (id && id !== 'list') {
          const { valid, filePath } = await adapter.validate(cwd, id);
          if (!valid)
            return {
              type: 'message',
              messageType: 'error',
              content: `${adapter.name} session ${id.slice(0, 8)}... not found for this project.`,
            };
          await execute(context, id, filePath);
          return;
        }
        const sessions = await adapter.list(cwd);
        if (!sessions.length)
          return {
            type: 'message',
            messageType: 'info',
            content: `No ${adapter.name} sessions found for this project.`,
          };
        return {
          type: 'custom_dialog',
          component: (
            <ExternalSessionPicker
              providerName={adapter.name}
              sessions={sessions}
              onSelect={async (session) => {
                context.ui.removeComponent();
                await execute(context, session.sessionId, session.filePath);
              }}
              onExit={() => context.ui.removeComponent()}
            />
          ),
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Could not read ${adapter.name} sessions: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  };
}
