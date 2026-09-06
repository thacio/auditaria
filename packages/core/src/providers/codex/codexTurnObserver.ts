/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CODEX_PROVIDER: One turn pipeline, any trigger — Codex CLI.
 *
 * Codex's interactive TUI has two live channels (verified on 0.153.4):
 *
 *   - the session ROLLOUT `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`,
 *     created at the first prompt and written per event: `session_meta`,
 *     `event_msg` (task_started, item_completed, token_count, task_complete,
 *     turn_aborted, …), `response_item` (user/assistant/developer `message`,
 *     `reasoning`, `function_call` / `custom_tool_call` / `local_shell_call`
 *     and their `*_output`), `compacted`, `turn_context`; it leads the hooks
 *     by up to a second and carries the canonical content in order;
 *   - HOOKS (session-scoped through `-c hooks.*`): SessionStart (with the
 *     rollout path), UserPromptSubmit (prompt + turn_id), PreToolUse /
 *     PostToolUse (call ids = the rollout's), PermissionRequest (an approval
 *     dialog is on screen), Stop (turn end), Interrupt (Esc), Pre/PostCompact,
 *     SubagentStart/Stop.
 *
 * Completion channels: Stop hook, settled `task_complete`, Interrupt /
 * `turn_aborted`, idle PTY showing the input prompt, ceiling. A message typed
 * while a turn runs is queued by the TUI and injected under the SAME
 * `turn_id` (UserPromptSubmit re-fires) — surfaced in place, like Claude.
 */

import { ProviderEventType } from '../types.js';
import {
  ProviderTurnObserver,
  isPlainObject,
  numberOrUndefined,
  pickString,
  slashName,
  summariseInput,
  type HookEvent,
  type TurnObserverHost,
  type TurnState,
} from '../terminal/turnObserver.js';

export type { HookEvent, TurnObserverHost } from '../terminal/turnObserver.js';

/** User-role rollout lines the TUI writes for itself (never a prompt). */
const META_USER_TEXT_RE =
  /^\s*<(environment_context|user_instructions|permissions instructions|skills_instructions|apps_instructions|collaboration_mode|agents_md|memory|turn_context|available_tools)/i;
/** Written after Esc: "<turn_aborted>\nThe user interrupted the previous …". */
const TURN_ABORTED_RE = /^\s*<turn_aborted>/i;

/** Codex tool names → the display names the chat already knows. */
export function mapCodexToolName(name: string): string {
  switch (name) {
    case 'exec_command':
    case 'shell':
    case 'shell_command':
    case 'local_shell':
    case 'write_stdin':
      return 'Bash';
    case 'apply_patch':
      return 'ApplyPatch';
    case 'web_search':
    case 'web_search_call':
      return 'WebSearch';
    case 'view_image':
      return 'ViewImage';
    default:
      return name;
  }
}

/** `function_call.arguments` is a JSON string; keep it readable on failure. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : { arguments: parsed };
  } catch {
    return { arguments: raw };
  }
}

/** exec_command outputs end with "Process exited with code N" — N≠0 is an error. */
export function outputLooksFailed(output: string): boolean {
  const m = output.match(/Process exited with code (\d+)/);
  if (m && m[1] !== '0') return true;
  return /^aborted by user/im.test(output);
}

export class CodexTurnObserver extends ProviderTurnObserver {
  /** Session id from `session_meta` (informational; the driver owns resume). */
  sessionId: string | undefined;
  /** Rollout `item_completed` items that reported `status: "failed"`. */
  private readonly failedCalls = new Set<string>();
  /** `task_started` seen before its user line: remember the turn id. */
  private pendingTurnId: string | undefined;

  constructor(host: TurnObserverHost) {
    super(host, 'Codex');
  }

  protected override turnLooksFinished(t: TurnState): boolean {
    return t.stopHookSeen || t.completionSeenAt !== undefined;
  }

  // ── Hook channel ───────────────────────────────────────────────────────────

  protected override applyHook(ev: HookEvent): void {
    const p = ev.payload ?? {};
    const turn = this.turn;
    if (turn && ev.event !== 'SessionStart') turn.lastProgressAt = this.now();
    switch (ev.event) {
      case 'SessionStart': {
        const source = pickString(p, 'source');
        const sessionId = pickString(p, 'session_id');
        if (
          sessionId &&
          source &&
          source !== 'startup' &&
          source !== 'compact'
        ) {
          this.host.onSessionChange(sessionId, source);
        }
        break;
      }
      case 'UserPromptSubmit': {
        const prompt = pickString(p, 'prompt') ?? '';
        const turnId = pickString(p, 'turn_id') ?? this.nextSyntheticId();
        this.acceptPrompt(turnId, prompt);
        break;
      }
      case 'PreToolUse': {
        const id = pickString(p, 'tool_use_id');
        const name = pickString(p, 'tool_name');
        if (!id || !name || this.isStaleToolEvent(id)) break;
        this.emitToolUse(
          this.ensureTurn(),
          id,
          mapCodexToolName(name),
          isPlainObject(p['tool_input']) ? p['tool_input'] : {},
        );
        break;
      }
      case 'PostToolUse': {
        const id = pickString(p, 'tool_use_id');
        if (!id || this.isStaleToolEvent(id)) break;
        const response = p['tool_response'];
        const text =
          typeof response === 'string'
            ? response
            : response === undefined
              ? ''
              : safeJson(response);
        this.emitToolResult(
          this.ensureTurn(),
          id,
          text,
          this.failedCalls.has(id) || outputLooksFailed(text),
        );
        break;
      }
      case 'PermissionRequest': {
        const name = pickString(p, 'tool_name') ?? 'a tool';
        this.attentionStart(
          this.ensureTurn(),
          `permission:${name}`,
          'permission',
          mapCodexToolName(name),
          summariseInput(p['tool_input']),
        );
        break;
      }
      case 'Stop': {
        if (!turn) break;
        const turnId = pickString(p, 'turn_id');
        if (
          turnId &&
          turn.promptId !== turnId &&
          !turn.promptId.startsWith('synthetic-')
        )
          break;
        turn.stopHookSeen = true;
        this.finalize('hook');
        break;
      }
      case 'Interrupt': {
        if (turn) this.finalize('aborted');
        break;
      }
      case 'PreCompact':
        break;
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
        break;
      }
      case 'SubagentStart':
      case 'SubagentStop': {
        const agentId =
          pickString(p, 'agent_id') ?? pickString(p, 'turn_id') ?? 'agent';
        const agentType = pickString(p, 'agent_type') ?? 'sub-agent';
        this.host.onNotice({
          kind: 'subagent',
          phase: ev.event === 'SubagentStart' ? 'start' : 'stop',
          agentId,
          agentType,
          summary: pickString(p, 'last_assistant_message')?.slice(0, 400),
        });
        break;
      }
      default:
        break; // SessionEnd, …
    }
  }

  /** A prompt Codex accepted (hook) or wrote as a user line (rollout). */
  private acceptPrompt(turnId: string, prompt: string): void {
    const turn = this.turn;
    if (
      turn &&
      (turn.promptId === turnId ||
        (!this.turnLooksFinished(turn) && !this.claimMatches(prompt)))
    ) {
      this.noteInjectedMessage(turn, prompt);
      return;
    }
    this.pendingTurnId = undefined;
    this.startTurnFromPrompt(turnId, prompt, slashName(prompt));
  }

  // ── Rollout channel ───────────────────────────────────────────────────────

  protected override applyTranscript(entry: unknown): void {
    if (!isPlainObject(entry)) return;
    const payload = isPlainObject(entry['payload']) ? entry['payload'] : {};
    switch (entry['type']) {
      case 'session_meta': {
        const id =
          pickString(payload, 'id') ?? pickString(payload, 'session_id');
        if (!id) break;
        // `/new` in the TUI: a new rollout with a new id. Codex fires the
        // SessionStart hook lazily (at the next prompt), so the rollout is
        // the timely witness of the switch.
        if (this.sessionId && this.sessionId !== id) {
          this.host.onSessionChange(id, 'new');
        }
        this.sessionId = id;
        break;
      }
      case 'event_msg':
        this.applyEvent(payload);
        break;
      case 'response_item':
        this.applyResponseItem(payload);
        break;
      case 'compacted': {
        const t = this.ensureTurn();
        if (t.compactedAt === undefined) {
          t.queue.push({
            type: ProviderEventType.Compacted,
            preTokens: 0,
            trigger: 'manual',
          });
          t.compactedAt = this.now();
        }
        const summary =
          pickString(payload, 'message') ?? pickString(payload, 'summary');
        if (summary && !t.summarySeen) {
          t.summarySeen = true;
          t.queue.push({ type: ProviderEventType.CompactionSummary, summary });
        }
        break;
      }
      default:
        break; // turn_context, world_state, token_usage_record, …
    }
  }

  private applyEvent(p: Record<string, unknown>): void {
    switch (pickString(p, 'type')) {
      case 'task_started': {
        // The user line follows within ~2 s; remember the id so the turn it
        // starts carries Codex's own turn_id.
        this.pendingTurnId = pickString(p, 'turn_id');
        break;
      }
      case 'item_completed': {
        const item = isPlainObject(p['item']) ? p['item'] : {};
        const id = pickString(item, 'id');
        if (id && pickString(item, 'status') === 'failed')
          this.failedCalls.add(id);
        break;
      }
      case 'task_complete': {
        const t = this.turn;
        if (!t) break;
        const turnId = pickString(p, 'turn_id');
        if (
          turnId &&
          t.promptId !== turnId &&
          !t.promptId.startsWith('synthetic-')
        )
          break;
        this.markCompletionSeen(t);
        break;
      }
      case 'turn_aborted': {
        if (this.turn) this.finalize('aborted');
        break;
      }
      case 'token_count': {
        const t = this.turn;
        if (!t) break;
        const info = isPlainObject(p['info']) ? p['info'] : {};
        const last = isPlainObject(info['last_token_usage'])
          ? info['last_token_usage']
          : undefined;
        const total = isPlainObject(info['total_token_usage'])
          ? info['total_token_usage']
          : undefined;
        const usage = last ?? total;
        if (usage) {
          t.usage = {
            inputTokens: numberOrUndefined(usage['input_tokens']),
            outputTokens: numberOrUndefined(usage['output_tokens']),
            cacheReadTokens: numberOrUndefined(usage['cached_input_tokens']),
          };
        }
        break;
      }
      case 'error': {
        const t = this.ensureTurn();
        t.failed = pickString(p, 'message') ?? 'Codex reported an error.';
        this.finalize('failed');
        break;
      }
      case 'exec_approval_request':
      case 'apply_patch_approval_request':
      case 'mcp_tool_approval_request': {
        const name =
          pickString(p, 'type') === 'apply_patch_approval_request'
            ? 'ApplyPatch'
            : 'Bash';
        this.attentionStart(
          this.ensureTurn(),
          `approval:${name}`,
          'permission',
          name,
          summariseInput(p),
        );
        break;
      }
      default:
        break; // agent_message / reasoning duplicates of response_items, warnings, …
    }
  }

  private applyResponseItem(p: Record<string, unknown>): void {
    switch (pickString(p, 'type')) {
      case 'message': {
        const role = pickString(p, 'role');
        const text = joinInputText(p['content']);
        if (role === 'user') {
          if (!text.trim() || META_USER_TEXT_RE.test(text)) break;
          if (TURN_ABORTED_RE.test(text)) {
            if (this.turn) this.finalize('aborted');
            break;
          }
          this.acceptPrompt(
            this.pendingTurnId ?? this.nextSyntheticId(),
            text.trim(),
          );
        } else if (role === 'assistant') {
          if (!text) break;
          const t = this.ensureTurn();
          if (!t.modelEmitted) t.modelEmitted = true;
          this.emitCanonicalText(t, text);
        }
        break; // developer / system: instructions, not conversation
      }
      case 'reasoning': {
        const summary = p['summary'];
        if (!Array.isArray(summary)) break;
        const texts = summary
          .filter(isPlainObject)
          .map((s) => pickString(s, 'text') ?? '')
          .filter(Boolean);
        if (texts.length) {
          this.ensureTurn().queue.push({
            type: ProviderEventType.Thinking,
            text: texts.join('\n\n'),
          });
        }
        break;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const id = pickString(p, 'call_id') ?? pickString(p, 'id');
        const name = pickString(p, 'name');
        if (!id || !name || this.isStaleToolEvent(id)) break;
        const rawArgs = p['arguments'] ?? p['input'];
        this.emitToolUse(
          this.ensureTurn(),
          id,
          mapCodexToolName(name),
          parseToolArguments(rawArgs),
        );
        break;
      }
      case 'local_shell_call': {
        const id = pickString(p, 'call_id') ?? pickString(p, 'id');
        if (!id || this.isStaleToolEvent(id)) break;
        const action = isPlainObject(p['action']) ? p['action'] : {};
        const command = Array.isArray(action['command'])
          ? action['command'].join(' ')
          : '';
        this.emitToolUse(this.ensureTurn(), id, 'Bash', { command });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const id = pickString(p, 'call_id') ?? pickString(p, 'id');
        if (!id || this.isStaleToolEvent(id)) break;
        const out = p['output'];
        const text =
          typeof out === 'string'
            ? out
            : out === undefined
              ? ''
              : safeJson(out);
        this.emitToolResult(
          this.ensureTurn(),
          id,
          text,
          this.failedCalls.has(id) || outputLooksFailed(text),
        );
        break;
      }
      case 'web_search_call': {
        const id = pickString(p, 'id') ?? this.nextSyntheticId('search');
        const action = isPlainObject(p['action']) ? p['action'] : {};
        const t = this.ensureTurn();
        this.emitToolUse(t, id, 'WebSearch', {
          query: pickString(action, 'query') ?? '',
        });
        this.emitToolResult(
          t,
          id,
          pickString(p, 'status') ?? 'completed',
          false,
        );
        break;
      }
      default:
        break;
    }
  }
}

/** Concatenate the text parts of a rollout message `content` array. */
export function joinInputText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    const type = pickString(block, 'type');
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = pickString(block, 'text');
      if (text) parts.push(text);
    }
  }
  return parts.join('');
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
