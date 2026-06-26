/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Phase-1 UI integration.
 *
 * Bridges the driver-side InteractivePromptStart / InteractivePromptResolved
 * events with the existing AskUserDialog. When Claude calls AskUserQuestion
 * mid-turn:
 *
 *   1. Driver emits InteractivePromptStart with structured questions/options.
 *   2. providerManager forwards via the event stream.
 *   3. useGeminiStream calls back into this hook.
 *   4. We translate to Gemini's Question[] shape and mount AskUserDialog via
 *      setCustomDialog (the existing escape-hatch in AppContainer).
 *   5. On user submit/cancel, translate the answers back and call
 *      providerManager.respondToPrompt() so the driver writes the matching
 *      keystrokes into Claude's PTY picker.
 *
 * Reliability notes (Claude TUI's AskUserQuestion picker affordances):
 *   - Single-question: handled directly.
 *   - Multi-question: AskUserDialog has tab-bar navigation built-in; the
 *     driver replays Down+Enter per question.
 *   - "Type something" / free-form input: when the user picks the dialog's
 *     "Other" option and types text, we send a `customText` answer. The
 *     driver currently doesn't replay text into the picker — it falls
 *     through to a cancel. Wiring text input through the picker is a small
 *     follow-up (would press an extra keystroke for the "Type something"
 *     row, then type the text + Enter).
 *   - "Chat about this": this is a Claude TUI-internal option, never
 *     surfaced via PreToolUse, so it's not in our event payload at all.
 *
 * Disable switch:
 *   Set env var AUDITARIA_CLAUDE_INTERACTIVE_UI=0 to suppress the modal.
 *   When suppressed, we surface an inline chat message hinting the user to
 *   answer from the terminal pane (once Phase 2 lands). Until that, the
 *   prompt hangs in CLI mode the same way it did before this work.
 */

import type React from 'react';
import { useCallback } from 'react';
import { Box } from 'ink';
import { AskUserDialog } from '../components/AskUserDialog.js';
import {
  type Config,
  type InteractivePromptStartEvent,
  type InteractivePromptResponse,
} from '@google/gemini-cli-core';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import {
  toGeminiQuestions,
  buildPromptAnswers,
} from './claudeInteractivePromptTranslators.js'; // AUDITARIA_CLAUDE_PROVIDER
import { webTerminalBridge } from '../../services/webTerminalBridge.js'; // AUDITARIA_CLAUDE_PROVIDER

/**
 * True when the user has opted out of the in-UI prompt modal.
 * Reads env on every call so flipping mid-session takes effect.
 */
function isInteractivePromptUIDisabled(): boolean {
  const v = process.env['AUDITARIA_CLAUDE_INTERACTIVE_UI'];
  return v === '0' || v === 'false' || v === 'off';
}

export interface InteractivePromptDialogControls {
  handleStart(event: InteractivePromptStartEvent): void;
  handleResolved(): void;
}

export interface InteractivePromptDialogDeps {
  config: Config | null | undefined;
  setCustomDialog: (node: React.ReactNode | null) => void;
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
  availableTerminalWidth: number;
}

/**
 * Returns stable callbacks for the InteractivePromptStart/Resolved events.
 * The caller (useGeminiStream) invokes them from inside the per-event
 * switch.
 */
export function useClaudeInteractivePromptDialog(
  deps: InteractivePromptDialogDeps,
): InteractivePromptDialogControls {
  const { config, setCustomDialog, addItem, availableTerminalWidth } = deps;

  const respond = useCallback(
    async (
      promptId: string,
      response: InteractivePromptResponse,
    ): Promise<void> => {
      try {
        const pm = config?.getProviderManager();
        await pm?.respondToPrompt(promptId, response);
      } catch (e) {
        addItem(
          {
            type: MessageType.ERROR,
            text: `Failed to send prompt response: ${e instanceof Error ? e.message : String(e)}`,
          },
          Date.now(),
        );
      } finally {
        setCustomDialog(null);
      }
    },
    [config, setCustomDialog, addItem],
  );

  const handleStart = useCallback(
    (event: InteractivePromptStartEvent): void => {
      // AUDITARIA_CLAUDE_PROVIDER: When the web interface is in use, route the
      // question to the live Claude terminal instead of this modal. The modal
      // auto-drives Claude's picker via respondToPrompt, which collides with
      // the user's manual input in the web terminal (focus/keystroke conflict,
      // orphaned modal on re-ask). So when a web client is connected, suppress
      // the modal (and its auto-driver), open the terminal if it's closed, and
      // let the user answer Claude's picker directly. The driver still resolves
      // the prompt when the tool_result lands. The CLI-only path (no web
      // client) keeps the modal unchanged.
      if (webTerminalBridge.hasConnectedClients()) {
        webTerminalBridge.requestOpenTerminal();
        addItem(
          {
            type: MessageType.INFO,
            text:
              `Claude is asking ${event.questions.length} question${event.questions.length === 1 ? '' : 's'} — ` +
              `answer directly in the Claude terminal (opened for you).`,
          },
          Date.now(),
        );
        return;
      }

      if (isInteractivePromptUIDisabled()) {
        addItem(
          {
            type: MessageType.INFO,
            text:
              `Claude is asking ${event.questions.length} question${event.questions.length === 1 ? '' : 's'}. ` +
              `The interactive-prompt modal is disabled (AUDITARIA_CLAUDE_INTERACTIVE_UI=0). ` +
              `Open the terminal pane to answer, or unset the variable to surface the modal here.`,
          },
          Date.now(),
        );
        return;
      }

      const geminiQuestions = toGeminiQuestions(event);
      setCustomDialog(
        <Box flexDirection="column">
          <AskUserDialog
            questions={geminiQuestions}
            width={availableTerminalWidth}
            onSubmit={(raw) => {
              const answers = buildPromptAnswers(event, raw);
              void respond(event.promptId, { kind: 'answered', answers });
            }}
            onCancel={() => {
              void respond(event.promptId, {
                kind: 'cancelled',
                reason: 'user-cancel',
              });
            }}
          />
        </Box>,
      );
    },
    [addItem, availableTerminalWidth, respond, setCustomDialog],
  );

  const handleResolved = useCallback((): void => {
    // Driver emits Resolved after PostToolUse fires; close any modal we
    // had open in case the user hadn't picked yet (e.g. picker handled
    // externally, or stale state).
    setCustomDialog(null);
  }, [setCustomDialog]);

  return { handleStart, handleResolved };
}
