/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Render provider turns the chat did not start.
 *
 * When the user types into the mirrored provider terminal (web client), or
 * the provider CLI auto-continues (background task / sub-agent
 * notification), the ProviderManager publishes the turn on
 * `providerTurnBus` as a ServerGeminiStreamEvent stream — already
 * translated and mirrored exactly like a chat turn. This hook feeds that
 * stream into `useGeminiStream`'s own `processGeminiStreamEvents`, so the
 * CLI chat (and the web chat, which mirrors it) shows the user message,
 * thinking, text, live tool cards, errors and compaction with the same
 * code path, the same order and the same "responding" state as a chat
 * turn. Esc cancels it like a chat turn (the abort controller is the same
 * ref `cancelOngoingRequest` aborts).
 *
 * Notices (a `/clear` typed in the terminal, a dialog waiting for a human,
 * a sub-agent finishing, a model switch) become info/error items; an
 * attention notice also opens the web terminal so the user lands where
 * Claude is waiting.
 */

import { useEffect, useRef } from 'react';
import {
  providerTurnBus,
  describeSystemPrompt,
  type ManagedExternalTurn,
  type ProviderNotice,
  type ServerGeminiStreamEvent,
} from '@google/gemini-cli-core';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { webTerminalBridge } from '../../services/webTerminalBridge.js';

const EXTERNAL_TURNS_DISABLED =
  process.env['AUDITARIA_CLAUDE_EXTERNAL_TURNS'] === '0';

export interface UseProviderExternalTurnsArgs {
  addItem: UseHistoryManagerReturn['addItem'];
  processGeminiStreamEvents: (
    stream: AsyncIterable<ServerGeminiStreamEvent>,
    userMessageTimestamp: number,
    signal: AbortSignal,
  ) => Promise<unknown>;
  setIsResponding: (value: boolean) => void;
  setThought: (value: null) => void;
  pendingHistoryItemRef: React.MutableRefObject<HistoryItemWithoutId | null>;
  setPendingHistoryItem: (item: HistoryItemWithoutId | null) => void;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  isRespondingRef: React.MutableRefObject<boolean>;
}

/** Human-readable line for a notice, or null when nothing should be shown. */
export function describeNotice(
  notice: ProviderNotice,
  webConnected: boolean,
): { type: 'info' | 'error'; text: string } | null {
  switch (notice.kind) {
    case 'attention': {
      if (notice.phase !== 'start') return null;
      const what =
        notice.what === 'permission'
          ? `permission${notice.toolName ? ` to run ${notice.toolName}` : ''}`
          : notice.what === 'question'
            ? 'an answer'
            : notice.what === 'elicitation'
              ? 'input for an MCP server'
              : notice.what === 'trust'
                ? 'the workspace trust decision'
                : 'a choice in a dialog';
      const detail = notice.detail ? ` — ${notice.detail}` : '';
      return {
        type: 'info',
        text: webConnected
          ? `Claude is waiting for ${what} in the provider terminal (opened for you)${detail}.`
          : `Claude is waiting for ${what} in its terminal${detail}. Run /provider terminal to answer here (Ctrl+Q returns to chat), or /web for the browser terminal.`,
      };
    }
    case 'session':
      return {
        type: 'info',
        text:
          notice.source === 'clear'
            ? 'Claude session cleared in the terminal — its context is empty now (the chat log above is history only).'
            : `Claude ${notice.source === 'resume' ? 'resumed' : 'switched to'} session ${notice.sessionId.slice(0, 8)} in the terminal.`,
      };
    case 'local_command':
      return {
        type: 'info',
        text: notice.command
          ? `${notice.command} (terminal): ${notice.output}`
          : `Terminal: ${notice.output}`,
      };
    case 'subagent':
      return {
        type: 'info',
        text:
          notice.phase === 'start'
            ? `Sub-agent ${notice.agentType} started.`
            : `Sub-agent ${notice.agentType} finished${notice.summary ? `: ${notice.summary}` : '.'}`,
      };
    case 'model':
      return {
        type: 'info',
        text: `Claude model switched to ${notice.model} in the terminal.`,
      };
    case 'info':
      return { type: 'info', text: notice.text };
    case 'error':
      return { type: 'error', text: notice.message };
    case 'user_message':
      return null; // rendered as a user item by the caller
    default:
      return null;
  }
}

export function useProviderExternalTurns(
  args: UseProviderExternalTurnsArgs,
): void {
  // Latest callbacks in a ref: the bus subscription is created once.
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (EXTERNAL_TURNS_DISABLED) return;
    // Defensive: a test double of the core package may not carry the bus.
    if (typeof providerTurnBus?.onTurn !== 'function') return;

    const offNotice = providerTurnBus.onNotice((notice) => {
      const { addItem } = argsRef.current;
      if (notice.kind === 'user_message') {
        if (notice.text) {
          // Typed variable: `addItem` takes Omit<HistoryItem,'id'>, whose
          // literal excess-property check only knows the union's common keys.
          const injected: HistoryItemWithoutId = {
            type: 'user',
            text: notice.text,
            providerTurnId: `injected-${Date.now()}`,
          };
          addItem(injected, Date.now());
        }
        return;
      }
      const webConnected = webTerminalBridge.hasConnectedClients();
      const line = describeNotice(notice, webConnected);
      if (!line) return;
      if (notice.kind === 'attention' && webConnected) {
        webTerminalBridge.requestOpenTerminal();
      }
      addItem(
        {
          type: line.type === 'error' ? MessageType.ERROR : MessageType.INFO,
          text: line.text,
        },
        Date.now(),
      );
    });

    const offTurn = providerTurnBus.onTurn((turn: ManagedExternalTurn) => {
      void renderTurn(turn);
    });

    async function renderTurn(turn: ManagedExternalTurn): Promise<void> {
      const a = argsRef.current;
      const timestamp = Date.now();
      if (turn.userText) {
        const userItem: HistoryItemWithoutId =
          turn.source === 'system'
            ? {
                type: 'info',
                text: `${describeSystemPrompt(turn.userText)} · Claude continues on its own.`,
              }
            : {
                type: 'user',
                text: turn.userText,
                providerTurnId: turn.promptId,
              };
        a.addItem(userItem, timestamp);
      }
      // Same abort ref as a chat turn, so Esc / the web interrupt button
      // cancel an external turn the way they cancel a chat turn.
      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => turn.interrupt(), {
        once: true,
      });
      a.abortControllerRef.current = controller;
      a.setThought(null);
      a.setIsResponding(true);
      try {
        await a.processGeminiStreamEvents(
          turn.stream,
          timestamp,
          controller.signal,
        );
      } catch (e) {
        argsRef.current.addItem(
          {
            type: MessageType.ERROR,
            text: `The terminal turn ended with an error: ${e instanceof Error ? e.message : String(e)}`,
          },
          Date.now(),
        );
      } finally {
        const b = argsRef.current;
        if (b.pendingHistoryItemRef.current) {
          b.addItem(b.pendingHistoryItemRef.current, timestamp);
          b.setPendingHistoryItem(null);
        }
        if (b.abortControllerRef.current === controller)
          b.abortControllerRef.current = null;
        b.setIsResponding(false);
      }
    }

    return () => {
      offNotice();
      offTurn();
    };
  }, []);
}
