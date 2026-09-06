/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: One turn pipeline, any trigger — Claude Code.
 *
 * The provider-agnostic machinery (claims, external turns, finalize channels,
 * injected messages, provisional text, tool/attention emission) lives in
 * `terminal/turnObserver.ts`. This subclass knows Claude Code's two live
 * channels — the hook relay JSONL and the session transcript JSONL — and
 * turns both into the shared `ProviderEvent` stream:
 *
 *   - the transcript is the primary source: it is written per content block
 *     as blocks complete (text / thinking / tool_use, in order) and leads the
 *     hooks by seconds, so text and tool calls surface live and in order;
 *   - hooks are the fast/structured complement: prompt acceptance
 *     (UserPromptSubmit), tool results (PostToolUse / PostToolUseFailure),
 *     turn end (Stop), API errors (StopFailure), compaction, dialogs
 *     (PermissionRequest / Notification), session changes (SessionStart),
 *     sub-agents, model switches, provisional live text (MessageDisplay).
 *
 * Turn completion is detected on three redundant channels — Stop hook,
 * settled terminal `stop_reason` in the transcript, idle PTY showing the
 * input prompt — because any single one can be dropped.
 */

import type {
  InteractivePromptQuestion,
  InteractivePromptStartEvent,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import {
  ProviderTurnObserver,
  isPlainObject,
  joinTextBlocks,
  numberOrUndefined,
  pickString,
  slashName,
  summariseInput,
  type HookEvent,
  type TurnState,
} from '../terminal/turnObserver.js';
import { isLocalCommandNoise } from './claudeSessionLoader.js';

// Re-exported so the driver and the tests keep one import site.
export {
  TRANSCRIPT_SETTLE_MS,
  NO_SIGNAL_IDLE_MS,
  SLASH_IDLE_MS,
  TURN_CEILING_MS,
  COMPACT_SUMMARY_GRACE_MS,
  classifyExternalSource,
  slashName,
  promptMatches,
  summariseInput,
} from '../terminal/turnObserver.js';
export type {
  HookEvent,
  TurnSource,
  FinalizeReason,
  ObservedTurn,
  TurnClaim,
  TurnObserverHost,
} from '../terminal/turnObserver.js';

const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
]);
/** Claude writes this user line when Esc / Ctrl+C interrupts a turn. */
const INTERRUPTED_RE = /^\[Request interrupted by user/i;

// ─── Observer ────────────────────────────────────────────────────────────────

export class ClaudeTurnObserver extends ProviderTurnObserver {
  private pendingCommandName: string | undefined;

  constructor(host: ConstructorParameters<typeof ProviderTurnObserver>[0]) {
    super(host, 'Claude');
  }

  protected override turnLooksFinished(t: TurnState): boolean {
    return (
      t.stopHookSeen ||
      (t.lastStopReason !== undefined &&
        TERMINAL_STOP_REASONS.has(t.lastStopReason))
    );
  }

  protected override interactivePromptFor(
    toolId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): InteractivePromptStartEvent | null {
    if (toolName !== 'AskUserQuestion') return null;
    return buildAskUserQuestionPromptEvent(toolId, input);
  }

  // ── Hook channel ───────────────────────────────────────────────────────────

  protected override applyHook(ev: HookEvent): void {
    const p = ev.payload ?? {};
    const agentId = pickString(p, 'agent_id');
    const turn = this.turn;
    if (turn && ev.event !== 'SessionStart' && ev.event !== 'Notification') {
      turn.lastProgressAt = this.now();
    }
    switch (ev.event) {
      case 'SessionStart': {
        // `startup` is consumed by the spawn path; `compact` re-fires with
        // the SAME session id (verified live) and is not a session change.
        const source = pickString(p, 'source');
        const sessionId = pickString(p, 'session_id');
        if (
          sessionId &&
          source &&
          source !== 'startup' &&
          source !== 'compact'
        ) {
          this.host.onSessionChange(sessionId, source); // the host emits the notice
        }
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = pickString(p, 'prompt') ?? '';
        const promptId = pickString(p, 'prompt_id') ?? this.nextSyntheticId();
        // A message typed while the turn runs is queued by Claude and then
        // injected into the SAME turn (verified live: UserPromptSubmit
        // re-fires with the running prompt_id). Surface it in place. A NEW
        // prompt_id that matches the pending chat claim is our own prompt
        // starting its turn — Claude runs one turn at a time, so whatever
        // turn we still hold (a synthetic one, or one whose Stop is late)
        // is over.
        if (
          turn &&
          (turn.promptId === promptId ||
            (!this.turnLooksFinished(turn) && !this.claimMatches(prompt)))
        ) {
          this.noteInjectedMessage(turn, prompt);
          break;
        }
        this.startTurnFromPrompt(promptId, prompt, slashName(prompt));
        break;
      }
      case 'PreToolUse': {
        if (agentId) break; // sub-agent internals — the Agent card carries the result
        const id = pickString(p, 'tool_use_id');
        const name = pickString(p, 'tool_name');
        if (!id || !name) break;
        const t = this.ensureTurn();
        this.emitToolUse(
          t,
          id,
          name,
          isPlainObject(p['tool_input']) ? p['tool_input'] : {},
        );
        break;
      }
      case 'PostToolUse': {
        if (agentId) break;
        const id = pickString(p, 'tool_use_id');
        if (!id || this.isStaleToolEvent(id)) break;
        this.emitToolResult(
          this.ensureTurn(),
          id,
          formatToolResponse(p['tool_response']),
          false,
        );
        break;
      }
      case 'PostToolUseFailure': {
        if (agentId) break;
        const id = pickString(p, 'tool_use_id');
        if (!id || this.isStaleToolEvent(id)) break;
        this.emitToolResult(
          this.ensureTurn(),
          id,
          pickString(p, 'error') ?? 'Tool execution failed.',
          true,
        );
        break;
      }
      case 'PermissionRequest': {
        const name = pickString(p, 'tool_name');
        if (!name || name === 'AskUserQuestion') break; // the picker is surfaced as an interactive prompt
        this.attentionStart(
          this.ensureTurn(),
          `permission:${name}`,
          'permission',
          name,
          summariseInput(p['tool_input']),
        );
        break;
      }
      case 'Notification': {
        const type = pickString(p, 'notification_type');
        const message = pickString(p, 'message');
        if (type === 'permission_prompt') {
          // An open AskUserQuestion picker also raises this notification —
          // the interactive prompt already announced it.
          if (this.turn && this.turn.askIds.size > 0) break;
          this.attentionStart(
            this.ensureTurn(),
            'notification:permission',
            'permission',
            undefined,
            message,
          );
        } else if (
          type === 'elicitation_dialog' ||
          type === 'elicitation_url_dialog'
        ) {
          this.attentionStart(
            this.ensureTurn(),
            'notification:elicitation',
            'elicitation',
            undefined,
            message,
          );
        } else if (type === 'agent_needs_input') {
          this.attentionStart(
            this.ensureTurn(),
            'notification:agent',
            'question',
            undefined,
            message,
          );
        } else if (
          type === 'elicitation_complete' ||
          type === 'elicitation_response'
        ) {
          this.attentionEnd('notification:elicitation');
        }
        break;
      }
      case 'Elicitation': {
        this.attentionStart(
          this.ensureTurn(),
          'elicitation',
          'elicitation',
          pickString(p, 'mcp_server'),
        );
        break;
      }
      case 'ElicitationResult':
        this.attentionEnd('elicitation');
        break;
      case 'PreCompact':
        break; // the boundary/summary lines and PostCompact carry the facts
      case 'PostCompact': {
        const trigger = pickString(p, 'trigger') === 'auto' ? 'auto' : 'manual';
        const t =
          this.turn ??
          this.startTurn(
            this.nextSyntheticId('compact'),
            '/compact',
            'compact',
            true,
          );
        if (t.compactedAt === undefined) {
          t.queue.push({
            type: ProviderEventType.Compacted,
            preTokens: 0,
            trigger,
          });
          t.compactedAt = this.now();
        }
        // The hook carries the summary itself (~1 s before the transcript's
        // isCompactSummary line) — use it and ignore the later duplicate.
        const summary = pickString(p, 'compact_summary');
        if (summary && !t.summarySeen) {
          t.summarySeen = true;
          t.queue.push({ type: ProviderEventType.CompactionSummary, summary });
        }
        break;
      }
      case 'MessageDisplay': {
        const id = pickString(p, 'message_id');
        const index = p['index'];
        if (!id || typeof index !== 'number' || index < 0) break;
        this.applyDisplay(id, index, pickString(p, 'delta') ?? '');
        break;
      }
      case 'Stop': {
        if (!turn) break;
        const promptId = pickString(p, 'prompt_id');
        if (
          promptId &&
          turn.promptId !== promptId &&
          !turn.promptId.startsWith('synthetic-')
        )
          break;
        turn.stopHookSeen = true;
        this.finalize('hook');
        break;
      }
      case 'StopFailure': {
        const t = this.ensureTurn();
        const errorType = pickString(p, 'error_type') ?? 'unknown';
        t.failed = `Claude API error: ${errorType}. The turn ended without a successful response.`;
        this.finalize('failed');
        break;
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        const agentType = pickString(p, 'agent_type');
        if (!agentType || !agentId) break; // Claude's internal agents have no type
        this.host.onNotice({
          kind: 'subagent',
          phase: ev.event === 'SubagentStart' ? 'start' : 'stop',
          agentId,
          agentType,
          summary: pickString(p, 'last_assistant_message')?.slice(0, 400),
        });
        break;
      }
      case 'PostModelSwitch': {
        const model = pickString(p, 'to_model');
        if (model) this.host.onNotice({ kind: 'model', model });
        break;
      }
      default:
        break;
    }
  }

  // ── Transcript channel ────────────────────────────────────────────────────

  protected override applyTranscript(entry: unknown): void {
    if (!isPlainObject(entry)) return;
    if (entry['isSidechain'] === true) return;
    switch (entry['type']) {
      case 'user':
        this.applyUserLine(entry);
        break;
      case 'assistant':
        this.applyAssistantLine(entry);
        break;
      case 'system':
        this.applySystemLine(entry);
        break;
      case 'attachment':
        this.applyAttachment(entry);
        break;
      default:
        break; // mode, permission-mode, ai-title, last-prompt, queue-operation, …
    }
  }

  /** A message typed while the turn ran is incorporated as a
   *  `queued_command` attachment (no ordinary user line) — show it once. */
  private applyAttachment(entry: Record<string, unknown>): void {
    const attachment = entry['attachment'];
    if (!isPlainObject(attachment) || attachment['type'] !== 'queued_command')
      return;
    const prompt = pickString(attachment, 'prompt');
    if (prompt && this.turn) this.noteInjectedMessage(this.turn, prompt);
  }

  private applyUserLine(entry: Record<string, unknown>): void {
    const msg = entry['message'];
    if (!isPlainObject(msg)) return;
    const content = msg['content'];
    if (entry['isCompactSummary'] === true) {
      const summary =
        typeof content === 'string' ? content : joinTextBlocks(content);
      if (!summary) return;
      const t = this.ensureTurn();
      if (t.summarySeen) return; // already delivered from the PostCompact hook
      if (t.compactedAt === undefined) {
        t.queue.push({
          type: ProviderEventType.Compacted,
          preTokens: 0,
          trigger: 'manual',
        });
        t.compactedAt = this.now();
      }
      t.summarySeen = true;
      t.queue.push({ type: ProviderEventType.CompactionSummary, summary });
      return;
    }
    if (entry['isMeta'] === true) return;
    if (typeof content === 'string') {
      this.handleUserText(entry, content);
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block['type'] === 'tool_result') {
        const id = pickString(block, 'tool_use_id');
        if (!id || this.isStaleToolEvent(id)) continue;
        this.emitToolResult(
          this.ensureTurn(),
          id,
          stringifyToolResultContent(block['content']),
          block['is_error'] === true,
        );
      } else if (block['type'] === 'text') {
        const text = pickString(block, 'text');
        if (text !== undefined) texts.push(text);
      }
    }
    if (texts.length > 0) this.handleUserText(entry, texts.join(''));
  }

  private handleUserText(entry: Record<string, unknown>, raw: string): void {
    const text = raw.trim();
    if (!text || isLocalCommandNoise(text)) return;
    const promptId = pickString(entry, 'promptId');
    const turn = this.turn;
    if (INTERRUPTED_RE.test(text)) {
      // Esc / Ctrl+C in the TUI: no Stop hook follows, the transcript is the
      // only witness (verified live for both keys). Arrives late when the
      // interrupt came from the chat — never a new turn.
      if (turn) this.finalize('aborted');
      return;
    }
    if (
      turn &&
      (turn.promptId === promptId || !this.turnLooksFinished(turn) || !promptId)
    ) {
      this.noteInjectedMessage(turn, text);
      return;
    }
    this.startTurnFromPrompt(
      promptId ?? this.nextSyntheticId(),
      text,
      slashName(text),
    );
  }

  private applyAssistantLine(entry: Record<string, unknown>): void {
    const msg = entry['message'];
    if (!isPlainObject(msg)) return;
    const content = msg['content'];
    if (entry['isApiErrorMessage'] === true) {
      const t = this.ensureTurn();
      t.failed = joinTextBlocks(content) || 'Claude API error.';
      this.finalize('failed');
      return;
    }
    const t = this.ensureTurn();
    t.lastProgressAt = this.now();
    const model = pickString(msg, 'model');
    if (!t.modelEmitted && model) {
      t.queue.push({ type: ProviderEventType.ModelInfo, model });
      t.modelEmitted = true;
    }
    const usage = msg['usage'];
    if (isPlainObject(usage)) {
      t.usage = {
        inputTokens: numberOrUndefined(usage['input_tokens']),
        outputTokens: numberOrUndefined(usage['output_tokens']),
        cacheReadTokens: numberOrUndefined(usage['cache_read_input_tokens']),
        cacheCreationTokens: numberOrUndefined(
          usage['cache_creation_input_tokens'],
        ),
      };
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isPlainObject(block)) continue;
        switch (block['type']) {
          case 'thinking': {
            const thinking = pickString(block, 'thinking');
            if (thinking)
              t.queue.push({
                type: ProviderEventType.Thinking,
                text: thinking,
              });
            break;
          }
          case 'text': {
            const text = pickString(block, 'text');
            if (text) this.emitCanonicalText(t, text);
            break;
          }
          case 'tool_use': {
            const id = pickString(block, 'id');
            const name = pickString(block, 'name');
            if (id && name) {
              this.emitToolUse(
                t,
                id,
                name,
                isPlainObject(block['input']) ? block['input'] : {},
              );
            }
            break;
          }
          case 'tool_result': {
            const toolUseId = pickString(block, 'tool_use_id');
            if (toolUseId) {
              this.emitToolResult(
                t,
                toolUseId,
                stringifyToolResultContent(block['content']),
                block['is_error'] === true,
              );
            }
            break;
          }
          default:
            break;
        }
      }
    }
    const stopReason = msg['stop_reason'];
    if (typeof stopReason === 'string') {
      t.lastStopReason = stopReason;
      if (TERMINAL_STOP_REASONS.has(stopReason)) {
        this.markCompletionSeen(t);
      } else {
        t.completionSeenAt = undefined;
      }
    }
  }

  private applySystemLine(entry: Record<string, unknown>): void {
    const subtype = entry['subtype'];
    if (subtype === 'compact_boundary') {
      const t = this.ensureTurn();
      if (t.compactedAt === undefined) {
        const meta = isPlainObject(entry['compactMetadata'])
          ? entry['compactMetadata']
          : {};
        t.queue.push({
          type: ProviderEventType.Compacted,
          preTokens: numberOrUndefined(meta['preTokens']) ?? 0,
          trigger: meta['trigger'] === 'auto' ? 'auto' : 'manual',
        });
        t.compactedAt = this.now();
      }
      return;
    }
    if (subtype !== 'local_command') return;
    const content = pickString(entry, 'content') ?? '';
    const command = matchTag(content, 'command-name');
    if (command !== undefined) {
      this.pendingCommandName = command.trim();
      return;
    }
    const output = matchTag(content, 'local-command-stdout');
    if (output === undefined) return;
    const commandName = this.pendingCommandName;
    this.pendingCommandName = undefined;
    if (output.trim()) {
      this.host.onNotice({
        kind: 'local_command',
        command: commandName,
        output: output.trim(),
      });
    }
    // A slash command typed in chat produces no user line and no Stop hook:
    // its local output IS the turn.
    if (!this.turn && this.claim?.slash) {
      this.startTurn(
        this.nextSyntheticId('local'),
        this.claim.prompt,
        this.claim.slash,
        true,
      );
    }
    if (this.turn?.slash) this.finalize('local');
  }
}

// ─── Claude-specific helpers (exported for tests and for the driver) ─────────

/**
 * Human line for a prompt Claude Code submitted to itself. Today that is the
 * `<task-notification>` block it enqueues when an async sub-agent (Agent tool)
 * or a background Bash task finishes:
 *
 *   <task-notification><task-id>…</task-id><tool-use-id>…</tool-use-id>
 *   <output-file>…</output-file><status>completed</status>
 *   <summary>Agent "Trivial subagent smoke test" finished</summary>
 *   <note>…</note><result>PONG</result>
 *   <usage><subagent_tokens>…</subagent_tokens><tool_uses>0</tool_uses>
 *   <duration_ms>3383</duration_ms></usage></task-notification>
 *
 * The raw text stays in the mirrored model context; this is only what the
 * chat shows. Unknown shapes fall back to the tag-stripped text.
 */
export function describeSystemPrompt(text: string): string {
  const tag = (name: string): string | undefined => {
    const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1].replace(/\s+/g, ' ').trim() : undefined;
  };
  if (/^\s*<task-notification>/i.test(text)) {
    const summary = tag('summary') ?? 'A background task finished';
    const status = tag('status');
    const result = tag('result');
    const usage = text.match(/<usage>([\s\S]*?)<\/usage>/)?.[1] ?? '';
    const durationMs = usage.match(/<duration_ms>(\d+)<\/duration_ms>/)?.[1];
    const toolUses = usage.match(/<tool_uses>(\d+)<\/tool_uses>/)?.[1];
    let line = `Background task ${status && !/^completed$/i.test(status) ? status : 'finished'}: ${summary}`;
    const meta = [
      durationMs ? `${(Number(durationMs) / 1000).toFixed(1)} s` : '',
      toolUses ? `${toolUses} tool use${toolUses === '1' ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(', ');
    if (meta) line += ` (${meta})`;
    if (result)
      line += ` — result: ${result.length > 300 ? result.slice(0, 297) + '…' : result}`;
    return line;
  }
  if (/^\s*<turn_aborted>/i.test(text))
    return 'The previous turn was interrupted.';
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 200 ? plain.slice(0, 197) + '…' : plain;
}

/** Claude's `tool_response` hook field: string, `{stdout,stderr}` (Bash),
 *  MCP `{content:[…]}` or any JSON. Prefer the human-readable form. */
export function formatToolResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response === undefined || response === null) return '';
  if (isPlainObject(response)) {
    const stdout = response['stdout'];
    const stderr = response['stderr'];
    if (typeof stdout === 'string' || typeof stderr === 'string') {
      const parts = [stdout, stderr].filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      );
      return parts.join('\n');
    }
    if (Array.isArray(response['content'])) {
      const joined = joinTextBlocks(response['content']);
      if (joined) return joined;
    }
  }
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

/** A transcript `tool_result.content`: string or `[{type:'text',text}]`. */
export function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  return joinTextBlocks(content);
}

function matchTag(content: string, tag: string): string | undefined {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

/** Translate Claude's AskUserQuestion tool_input into an InteractivePromptStart. */
export function buildAskUserQuestionPromptEvent(
  toolUseId: string,
  toolInput: unknown,
): InteractivePromptStartEvent | null {
  if (!isPlainObject(toolInput)) return null;
  const rawQuestions = toolInput['questions'];
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const questions: InteractivePromptQuestion[] = [];
  for (let i = 0; i < rawQuestions.length; i++) {
    const q: unknown = rawQuestions[i];
    if (!isPlainObject(q)) continue;
    const questionText = pickString(q, 'question') ?? '';
    const header = pickString(q, 'header');
    const rawOptions = q['options'];
    if (!Array.isArray(rawOptions)) continue;
    const options = rawOptions.filter(isPlainObject).map((o, idx) => ({
      id: String(o['label'] ?? `opt-${idx}`),
      label: String(o['label'] ?? `Option ${idx + 1}`),
      description: pickString(o, 'description'),
    }));
    if (options.length === 0) continue;
    questions.push({
      id: header ?? `q-${i}`,
      question: questionText,
      header,
      options,
      multiSelect: q['multiSelect'] === true,
    });
  }
  if (questions.length === 0) return null;
  return {
    type: ProviderEventType.InteractivePromptStart,
    promptId: toolUseId,
    kind: 'ask-user',
    title:
      questions.length === 1
        ? questions[0].header ||
          questions[0].question ||
          'Claude is asking a question'
        : `Claude is asking ${questions.length} questions`,
    questions,
    toolName: 'AskUserQuestion',
    timeoutMs: 60 * 60_000,
  };
}
