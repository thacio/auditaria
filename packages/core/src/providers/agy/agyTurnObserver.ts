/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: One turn pipeline, any trigger — Google Antigravity
 * CLI (`agy`) interactive TUI.
 *
 * Read channels (verified on agy 1.1.27, Windows):
 *   - the conversation TRANSCRIPT
 *     `~/.gemini/antigravity-cli/brain/<cascadeId>/.system_generated/logs/transcript_full.jsonl`,
 *     created at the first prompt and written live, one JSON object per step:
 *     `{step_index, source: USER_EXPLICIT|MODEL|SYSTEM, type: USER_INPUT|
 *     PLANNER_RESPONSE|GENERIC|…, status: DONE|RUNNING, created_at, content,
 *     thinking?, tool_calls?: [{name, args}]}`. A user prompt is a USER_INPUT
 *     whose content wraps the text in `<USER_REQUEST>…</USER_REQUEST>` (plus
 *     `<ADDITIONAL_METADATA>`); the model answers with PLANNER_RESPONSE steps
 *     (text, thinking, tool calls); every other MODEL step is the result of
 *     the preceding tool call (type GENERIC for shell commands on 1.1.27,
 *     LIST_DIRECTORY / VIEW_FILE / … on older builds), RUNNING until DONE.
 *   - agy HOOKS (`hooks.json`, `type: command`, run through cmd.exe on
 *     Windows): SessionStart, PreInvocation, PostInvocation, PreToolUse,
 *     PostToolUse, Stop — observational, fail-open. They are the fast lane
 *     (Stop = definitive completion, SessionStart binds the conversation);
 *     the transcript is the content channel and works without them.
 *
 * Completion channels: Stop hook, a settled final PLANNER_RESPONSE without
 * tool calls (all results in), idle PTY, ceiling.
 */

import { ProviderEventType } from '../types.js';
import {
  ProviderTurnObserver,
  isPlainObject,
  pickString,
  promptMatches,
  slashName,
  type HookEvent,
  type TurnObserverHost,
  type TurnState,
} from '../terminal/turnObserver.js';

export type { HookEvent, TurnObserverHost } from '../terminal/turnObserver.js';

/** A final PLANNER_RESPONSE may be followed by more steps within this window. */
export const AGY_TURN_SETTLE_MS = 1_500;

/**
 * agy's input box drops every non-ASCII character (verified: an em dash and
 * a non-breaking hyphen vanished from a typed prompt), so a claim is matched
 * against the transcript with both sides folded to ASCII. Exported for tests.
 */
export function foldAscii(text: string): string {
  let out = '';
  for (const ch of text) if (ch.charCodeAt(0) < 128) out += ch;
  return out;
}

/** The prompt text inside agy's USER_INPUT wrapper. Exported for tests. */
export function extractUserRequest(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  if (m) return m[1].trim();
  return content.replace(/<ADDITIONAL_METADATA>[\s\S]*$/, '').trim();
}

export class AgyTurnObserver extends ProviderTurnObserver {
  /** Conversation (cascade) id — learned from the hook or the driver. */
  conversationId: string | undefined;
  private pendingToolIds: string[] = [];
  private stepsSeen = new Set<number>();

  constructor(host: TurnObserverHost) {
    super(host, 'Antigravity', { settleMs: AGY_TURN_SETTLE_MS });
  }

  /** Forget per-conversation bookkeeping (new conversation / restart). */
  resetConversation(id?: string): void {
    this.conversationId = id;
    this.pendingToolIds = [];
    this.stepsSeen = new Set();
  }

  protected override turnLooksFinished(t: TurnState): boolean {
    return t.stopHookSeen || t.completionSeenAt !== undefined;
  }

  protected override claimMatches(text: string): boolean {
    return (
      !!this.claim &&
      promptMatches(foldAscii(this.claim.prompt), foldAscii(text))
    );
  }

  // ── Hook channel ───────────────────────────────────────────────────────────

  protected override applyHook(ev: HookEvent): void {
    const p = ev.payload ?? {};
    const turn = this.turn;
    if (turn) turn.lastProgressAt = this.now();
    switch (ev.event) {
      case 'SessionStart': {
        const id =
          pickString(p, 'conversationId') ?? pickString(p, 'conversation_id');
        if (id && id !== this.conversationId) {
          const previous = this.conversationId;
          this.conversationId = id;
          if (previous) this.host.onSessionChange(id, 'new');
        }
        break;
      }
      case 'PreInvocation': {
        // The model is being invoked: a turn is running (typed in the
        // terminal or by us). The transcript's USER_INPUT names the prompt.
        const t = this.ensureTurn();
        t.completionSeenAt = undefined;
        break;
      }
      case 'Stop': {
        if (!turn) break;
        turn.stopHookSeen = true;
        this.finalize('hook');
        break;
      }
      default:
        break; // PostInvocation, PreToolUse, PostToolUse: the transcript carries them
    }
  }

  // ── Transcript channel ────────────────────────────────────────────────────

  protected override applyTranscript(entry: unknown): void {
    if (!isPlainObject(entry)) return;
    const step = entry['step_index'];
    if (typeof step !== 'number') return;
    const status = (pickString(entry, 'status') ?? 'DONE').toUpperCase();
    const source = (pickString(entry, 'source') ?? '').toUpperCase();
    const type = (pickString(entry, 'type') ?? '').toUpperCase();
    if (status === 'RUNNING') return; // partial: wait for DONE
    if (this.stepsSeen.has(step)) return;
    this.stepsSeen.add(step);
    const content = pickString(entry, 'content') ?? '';

    if (type === 'USER_INPUT' || source === 'USER_EXPLICIT') {
      const text = extractUserRequest(content);
      if (!text) return;
      this.acceptPrompt(text);
      return;
    }
    if (
      type === 'CONVERSATION_HISTORY' ||
      type === 'SYSTEM_MESSAGE' ||
      source === 'SYSTEM'
    ) {
      return;
    }
    if (source !== 'MODEL') return;
    const t = this.ensureTurn();
    if (type === 'PLANNER_RESPONSE') {
      const thinking = pickString(entry, 'thinking');
      if (thinking)
        t.queue.push({ type: ProviderEventType.Thinking, text: thinking });
      if (content) this.emitCanonicalText(t, content);
      const calls = entry['tool_calls'];
      if (Array.isArray(calls) && calls.length > 0) {
        t.completionSeenAt = undefined;
        calls.forEach((call, i) => {
          if (!isPlainObject(call)) return;
          const id = `agy-${step}-${i}`;
          this.pendingToolIds.push(id);
          this.emitToolUse(
            t,
            id,
            pickString(call, 'name') ?? 'tool',
            isPlainObject(call['args']) ? call['args'] : {},
          );
        });
      } else {
        this.markCompletionSeen(t);
      }
      return;
    }
    // Any other MODEL step is the result of the oldest open tool call.
    const id = this.pendingToolIds.shift() ?? `agy-${step}`;
    this.emitToolResult(
      t,
      id,
      cleanToolOutput(content),
      looksLikeFailure(content),
    );
    t.completionSeenAt = undefined;
  }

  /** A prompt agy accepted (USER_INPUT): the claimed chat turn or a terminal one. */
  private acceptPrompt(prompt: string): void {
    const turn = this.turn;
    if (turn && !this.turnLooksFinished(turn) && !this.claimMatches(prompt)) {
      this.noteInjectedMessage(turn, prompt);
      return;
    }
    this.pendingToolIds = [];
    this.startTurnFromPrompt(
      this.nextSyntheticId('prompt'),
      prompt,
      slashName(prompt),
    );
  }
}

/** Drop agy's bookkeeping header from shell results. Exported for tests. */
export function cleanToolOutput(content: string): string {
  return content
    .replace(/^Created At: .*\n/m, '')
    .replace(/^Completed At: .*\n/m, '')
    .replace(/^\s*\n/, '')
    .trimEnd();
}

function looksLikeFailure(content: string): boolean {
  return /exited with code (?!0\b)\d+|\berror\b.*\b(failed|denied)\b/i.test(
    content,
  );
}
