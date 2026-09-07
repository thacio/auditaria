/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_COPILOT_PROVIDER: One turn pipeline, any trigger — GitHub Copilot CLI.
 *
 * Copilot's interactive TUI has two live channels (verified on 1.0.83):
 *
 *   - the session EVENTS `~/.copilot/session-state/<id>/events.jsonl`,
 *     created at the first prompt and written live: `user.message{content,
 *     delivery:"idle"|"steering"}`, `assistant.turn_start/turn_end{turnId}`
 *     (per inference step, ids reset per prompt), `assistant.message{content,
 *     reasoning, model, outputTokens, toolRequests[]}`, `tool.execution_start/
 *     complete{toolCallId, toolName, arguments, success, result{content}}`,
 *     `session.compaction_start/complete`, `session.model_change`,
 *     `session.error/warning`, `system.notification`;
 *   - HOOKS from a user-level hooks file whose relay is scoped to our
 *     sessions by an environment variable: `userPromptSubmitted{prompt}`
 *     (~0.3 s after Enter, even before the events file exists),
 *     `sessionStart{sessionId, source}`, `agentStop{stopReason}` (ONCE at the
 *     true end of the agent run), `permissionRequest{toolName, toolInput}`
 *     (also under --allow-all), `sessionEnd{reason}` (`/clear`),
 *     `errorOccurred`, `subagentStart/Stop`.
 *
 * Completion channels: agentStop hook, a settled final `assistant.turn_end`
 * (no tool requests, no open tools), idle PTY, ceiling. A message typed while
 * a turn runs arrives as a `steering` user.message inside the same run —
 * surfaced in place. Esc leaves no witness in either channel (verified), so
 * chat-initiated aborts finalize locally and terminal Escs rely on the idle
 * fallback.
 */

import type {
  InteractivePromptOption,
  InteractivePromptStartEvent,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import {
  ProviderTurnObserver,
  isPlainObject,
  pickString,
  slashName,
  summariseInput,
  type HookEvent,
  type TurnObserverHost,
  type TurnState,
} from '../terminal/turnObserver.js';

export type { HookEvent, TurnObserverHost } from '../terminal/turnObserver.js';

/** Final turn_end settle (per-inference-step turn_ends follow within ms). */
export const COPILOT_TURN_SETTLE_MS = 1_200;
/** A permission request still unanswered after this long is a real dialog. */
export const PERMISSION_ATTENTION_DELAY_MS = 1_500;

export class CopilotTurnObserver extends ProviderTurnObserver {
  sessionId: string | undefined;
  private lastHadToolRequests = false;
  private outputTokens = 0;
  private pendingPermission:
    | { name: string; detail: string; at: number }
    | undefined;

  constructor(host: TurnObserverHost) {
    super(host, 'Copilot', { settleMs: COPILOT_TURN_SETTLE_MS });
  }

  protected override turnLooksFinished(t: TurnState): boolean {
    return t.stopHookSeen || t.completionSeenAt !== undefined;
  }

  protected override interactivePromptFor(
    toolId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): InteractivePromptStartEvent | null {
    if (toolName !== 'ask_user') return null;
    return buildAskUserPromptEvent(toolId, input);
  }

  protected override checkCompletion(): void {
    const p = this.pendingPermission;
    if (p && this.turn && this.now() - p.at >= PERMISSION_ATTENTION_DELAY_MS) {
      this.pendingPermission = undefined;
      this.attentionStart(
        this.turn,
        `permission:${p.name}`,
        'permission',
        p.name,
        p.detail,
      );
    }
    super.checkCompletion();
  }

  // ── Hook channel ───────────────────────────────────────────────────────────

  protected override applyHook(ev: HookEvent): void {
    const p = ev.payload ?? {};
    const turn = this.turn;
    if (turn && ev.event !== 'sessionStart') turn.lastProgressAt = this.now();
    switch (ev.event) {
      case 'sessionStart': {
        const id = pickString(p, 'sessionId') ?? pickString(p, 'session_id');
        if (!id) break;
        if (this.sessionId && this.sessionId !== id) {
          this.host.onSessionChange(id, pickString(p, 'source') ?? 'new');
        }
        this.sessionId = id;
        break;
      }
      case 'sessionEnd': {
        // `/clear`: the TUI abandons the session; the next prompt opens a new one.
        if (turn) this.finalize('aborted');
        this.host.onSessionChange(this.sessionId ?? '', 'clear');
        this.sessionId = undefined;
        break;
      }
      case 'userPromptSubmitted': {
        const prompt = pickString(p, 'prompt') ?? '';
        this.acceptPrompt(prompt);
        break;
      }
      case 'permissionRequest': {
        const name =
          pickString(p, 'toolName') ?? pickString(p, 'tool_name') ?? 'a tool';
        this.pendingPermission = {
          name,
          detail: summariseInput(p['toolInput'] ?? p['tool_input']),
          at: this.now(),
        };
        break;
      }
      case 'postToolUse':
      case 'postToolUseFailure':
        this.pendingPermission = undefined; // the tool ran: no dialog is pending
        break;
      case 'agentStop': {
        if (!turn) break;
        turn.stopHookSeen = true;
        this.finalize('hook');
        break;
      }
      case 'errorOccurred': {
        const err = isPlainObject(p['error']) ? p['error'] : {};
        const message =
          pickString(err, 'message') ??
          pickString(p, 'error') ??
          'Copilot reported an error.';
        this.host.onNotice({ kind: 'error', message: `Copilot: ${message}` });
        break;
      }
      case 'subagentStart':
      case 'subagentStop': {
        const agentId =
          pickString(p, 'agentId') ?? pickString(p, 'agentName') ?? 'agent';
        const agentType =
          pickString(p, 'agentDisplayName') ??
          pickString(p, 'agentName') ??
          'sub-agent';
        this.host.onNotice({
          kind: 'subagent',
          phase: ev.event === 'subagentStart' ? 'start' : 'stop',
          agentId,
          agentType,
          summary: pickString(p, 'response')?.slice(0, 400),
        });
        break;
      }
      default:
        break; // notification (the <system_notification> prompt follows), preCompact, …
    }
  }

  /** A prompt the TUI accepted (hook) or logged (events). */
  private acceptPrompt(prompt: string): void {
    const turn = this.turn;
    if (turn && !this.turnLooksFinished(turn) && !this.claimMatches(prompt)) {
      this.noteInjectedMessage(turn, prompt);
      return;
    }
    this.lastHadToolRequests = false;
    this.outputTokens = 0;
    this.startTurnFromPrompt(
      this.nextSyntheticId('prompt'),
      prompt,
      slashName(prompt),
    );
  }

  // ── Events channel ────────────────────────────────────────────────────────

  protected override applyTranscript(entry: unknown): void {
    if (!isPlainObject(entry)) return;
    const type = pickString(entry, 'type');
    const d = isPlainObject(entry['data']) ? entry['data'] : {};
    switch (type) {
      case 'user.message': {
        const text = (pickString(d, 'content') ?? '').trim();
        if (!text) break;
        const turn = this.turn;
        if (pickString(d, 'delivery') === 'steering' && turn) {
          this.noteInjectedMessage(turn, text);
          break;
        }
        this.acceptPrompt(text);
        break;
      }
      case 'assistant.turn_start': {
        const t = this.ensureTurn();
        t.completionSeenAt = undefined; // another inference step is running
        break;
      }
      case 'assistant.message': {
        const t = this.ensureTurn();
        const model = pickString(d, 'model');
        if (model && !t.modelEmitted) {
          t.modelEmitted = true;
          t.queue.push({ type: ProviderEventType.ModelInfo, model });
        }
        const reasoning =
          pickString(d, 'reasoningText') ?? pickString(d, 'reasoning');
        if (reasoning)
          t.queue.push({ type: ProviderEventType.Thinking, text: reasoning });
        const content = pickString(d, 'content');
        if (content) this.emitCanonicalText(t, content);
        const toolRequests = d['toolRequests'];
        this.lastHadToolRequests =
          Array.isArray(toolRequests) && toolRequests.length > 0;
        const out = d['outputTokens'];
        if (typeof out === 'number') {
          this.outputTokens += out;
          t.usage = { outputTokens: this.outputTokens };
        }
        break;
      }
      case 'tool.execution_start': {
        const id = pickString(d, 'toolCallId');
        const name = pickString(d, 'toolName');
        if (!id || !name || this.isStaleToolEvent(id)) break;
        this.pendingPermission = undefined; // it is running: no dialog pending
        this.emitToolUse(
          this.ensureTurn(),
          id,
          name,
          isPlainObject(d['arguments']) ? d['arguments'] : {},
        );
        break;
      }
      case 'tool.execution_complete': {
        const id = pickString(d, 'toolCallId');
        if (!id || this.isStaleToolEvent(id)) break;
        const result = isPlainObject(d['result']) ? d['result'] : {};
        const raw = result['content'];
        const output =
          typeof raw === 'string'
            ? raw
            : raw === undefined
              ? ''
              : safeJson(raw);
        this.emitToolResult(
          this.ensureTurn(),
          id,
          output,
          d['success'] === false,
        );
        break;
      }
      case 'assistant.turn_end': {
        const t = this.turn;
        if (!t) break;
        if (!this.lastHadToolRequests && t.openTools.size === 0) {
          this.markCompletionSeen(t);
        } else {
          t.completionSeenAt = undefined;
        }
        break;
      }
      case 'session.compaction_start':
        break;
      case 'session.compaction_complete': {
        if (d['success'] === false) break;
        const t =
          this.turn ??
          this.startTurn(
            this.nextSyntheticId('compact'),
            '/compact',
            'compact',
            true,
          );
        if (t.compactedAt === undefined) {
          const pre = d['preCompactionTokens'];
          t.queue.push({
            type: ProviderEventType.Compacted,
            preTokens: typeof pre === 'number' ? pre : 0,
            trigger: t.slash === 'compact' ? 'manual' : 'auto',
          });
          t.compactedAt = this.now();
        }
        // 1.0.83 stores the summary in `summaryContent` (older: `summary`).
        const summary =
          pickString(d, 'summaryContent') ?? pickString(d, 'summary');
        if (!t.summarySeen) {
          t.summarySeen = true;
          if (summary) {
            t.queue.push({
              type: ProviderEventType.CompactionSummary,
              summary,
            });
          }
        }
        break;
      }
      case 'session.model_change': {
        const model =
          pickString(d, 'newModel') ??
          pickString(d, 'model') ??
          pickString(d, 'selectedModel');
        if (model) this.host.onNotice({ kind: 'model', model });
        break;
      }
      case 'session.error': {
        const t = this.ensureTurn();
        t.failed = `Copilot session error: ${pickString(d, 'message') ?? pickString(d, 'error') ?? 'unknown'}`;
        this.finalize('failed');
        break;
      }
      case 'abort': {
        // Esc while a permission dialog waits: `abort{reason:"user_initiated"}`.
        if (this.turn) this.finalize('aborted');
        break;
      }
      case 'permission.requested':
      case 'permission.request': {
        const name =
          pickString(d, 'toolName') ?? pickString(d, 'kind') ?? 'a tool';
        this.pendingPermission = {
          name,
          detail: summariseInput(d['toolInput'] ?? d),
          at: this.now(),
        };
        break;
      }
      case 'permission.completed': {
        this.pendingPermission = undefined;
        for (const id of [...(this.turn?.attention ?? [])])
          this.attentionEnd(id);
        break;
      }
      case 'session.warning': {
        const message = pickString(d, 'message') ?? pickString(d, 'error');
        if (message)
          this.host.onNotice({ kind: 'info', text: `Copilot: ${message}` });
        break;
      }
      default:
        break; // session.start, hook.start/end, system.message, system.notification, usage checkpoints, …
    }
  }
}

/**
 * Copilot's `ask_user` arguments → picker. Two shapes exist:
 * `{question, choices[], allow_freeform}` (older) and, on 1.0.83,
 * `{message, requestedSchema: {properties: {<field>: {enum: [...]}}}}`.
 */
export function buildAskUserPromptEvent(
  toolId: string,
  input: Record<string, unknown>,
): InteractivePromptStartEvent {
  const question =
    pickString(input, 'question') ??
    pickString(input, 'message') ??
    'Copilot is asking a question';
  let rawChoices: unknown = input['choices'];
  if (!Array.isArray(rawChoices)) {
    const schema = isPlainObject(input['requestedSchema'])
      ? input['requestedSchema']
      : {};
    const props = isPlainObject(schema['properties'])
      ? schema['properties']
      : {};
    for (const field of Object.values(props)) {
      if (isPlainObject(field) && Array.isArray(field['enum'])) {
        rawChoices = field['enum'];
        break;
      }
    }
  }
  const options: InteractivePromptOption[] = Array.isArray(rawChoices)
    ? rawChoices
        .filter((c): c is string => typeof c === 'string')
        .map((c) => ({ id: c, label: c }))
    : [];
  return {
    type: ProviderEventType.InteractivePromptStart,
    promptId: toolId,
    kind: 'ask-user',
    title: question,
    questions: [{ id: 'q-0', question, options, multiSelect: false }],
    toolName: 'ask_user',
    timeoutMs: 60 * 60_000,
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
