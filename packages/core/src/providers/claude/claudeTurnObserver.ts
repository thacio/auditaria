/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: One turn pipeline, any trigger.
 *
 * Claude's TUI runs turns that Auditaria started (a prompt typed by
 * `sendMessage`) and turns it did not (the user typed into the mirrored web
 * terminal; the CLI auto-continued after a background task). Everything
 * downstream of "a turn is happening in the PTY" is identical, so this
 * observer is the ONLY reader of Claude's two live channels — the hook
 * relay JSONL and the session transcript JSONL — and turns both into one
 * ordered `ProviderEvent` stream per turn:
 *
 *   - the transcript is the primary source: it is written per content block
 *     as blocks complete (text / thinking / tool_use, in order) and leads the
 *     hooks by seconds, so text and tool calls surface live and in order;
 *   - hooks are the fast/structured complement: prompt acceptance
 *     (UserPromptSubmit), tool results (PostToolUse / PostToolUseFailure),
 *     turn end (Stop), API errors (StopFailure), compaction, dialogs
 *     (PermissionRequest / Notification), session changes (SessionStart),
 *     sub-agents, model switches.
 *
 * Turn completion is detected on three redundant channels — Stop hook,
 * settled terminal `stop_reason` in the transcript, idle PTY showing the
 * input prompt — because any single one can be dropped. A turn is attributed
 * to `sendMessage` when a claim is pending and the accepted prompt matches
 * it; otherwise it is an EXTERNAL turn, handed to the host with the same
 * event stream. Facts that are not turn events (a `/clear` typed in the
 * terminal, a dialog waiting for a human, a sub-agent finishing) are
 * reported as notices.
 *
 * Pure with respect to I/O: the host supplies the drains and the PTY probe,
 * so the whole state machine is unit-testable on captured fixtures.
 */

import type {
  ExternalTurnSource,
  InteractivePromptQuestion,
  InteractivePromptStartEvent,
  ProviderEvent,
  ProviderFinishedEvent,
  ProviderNotice,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import { AsyncEventQueue } from '../terminal/asyncEventQueue.js';
import { isLocalCommandNoise } from './claudeSessionLoader.js';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Quiet time after a terminal stop_reason before the transcript channel finalizes. */
export const TRANSCRIPT_SETTLE_MS = 600;
/** No hook, no transcript growth for this long + idle prompt → finalize (last resort). */
export const NO_SIGNAL_IDLE_MS = 20_000;
/** Slash-command turns emit little: shorter idle ceiling. */
export const SLASH_IDLE_MS = 6_000;
/** Absolute ceiling for one turn (long-running tools). */
export const TURN_CEILING_MS = 30 * 60_000;
/** After PostCompact, how long to wait for the summary line before finalizing. */
export const COMPACT_SUMMARY_GRACE_MS = 4_000;
const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'stop_sequence',
  'max_tokens',
]);
/** Claude writes this user line when Esc / Ctrl+C interrupts a turn. */
const INTERRUPTED_RE = /^\[Request interrupted by user/i;

// ─── Public shapes ───────────────────────────────────────────────────────────

export interface HookEvent {
  event: string;
  payload: Record<string, unknown>;
}

export type TurnSource = 'chat' | ExternalTurnSource;

export type FinalizeReason =
  | 'hook'
  | 'transcript'
  | 'idle'
  | 'compacted'
  | 'local'
  | 'failed'
  | 'aborted'
  | 'timeout'
  | 'superseded'
  | 'pty-exit'
  | 'dispose';

export interface ObservedTurn {
  promptId: string;
  source: ExternalTurnSource;
  userText: string;
  events: AsyncIterable<ProviderEvent>;
}

/** Handle returned to `sendMessage` for the turn it is about to type. */
export interface TurnClaim {
  events: AsyncIterable<ProviderEvent>;
  /** True once the provider accepted the typed prompt (hook or transcript). */
  readonly accepted: boolean;
  /** True once the turn ended (its stream is closed). */
  readonly done: boolean;
}

export interface TurnObserverHost {
  /** New hook events since the last call (the host owns the file cursor). */
  drainHooks(): Promise<HookEvent[]>;
  /** New transcript lines since the last call, parsed. */
  drainTranscript(): Promise<{ entries: unknown[]; grew: boolean }>;
  /** Does the PTY tail show Claude's idle input prompt (❯)? */
  ptyShowsInputPrompt(): boolean;
  onExternalTurn(turn: ObservedTurn): void;
  onNotice(notice: ProviderNotice): void;
  /** SessionStart with a non-startup source (`clear`, `resume`, …). */
  onSessionChange(sessionId: string, source: string): void;
  /** The claimed prompt was accepted by the TUI (stops the CR retry). */
  onPromptAccepted(): void;
  now?(): number;
}

// ─── Internal state ──────────────────────────────────────────────────────────

interface TurnState {
  promptId: string;
  source: TurnSource;
  userText: string;
  slash?: string;
  queue: AsyncEventQueue<ProviderEvent>;
  /** The sendMessage claim this turn satisfied (chat turns only). */
  claim?: ClaimState;
  startedAt: number;
  lastProgressAt: number;
  openTools: Map<string, string>;
  seenToolUse: Set<string>;
  seenToolResult: Set<string>;
  askIds: Set<string>;
  attention: Set<string>;
  /** Queued messages Claude injected into this turn (normalised text). */
  injected: Set<string>;
  /** MessageDisplay streams (provisional live text) keyed by display id. */
  displays: Map<string, DisplayStream>;
  /** Provisional text already pushed to the stream, awaiting its transcript block. */
  provisional: { messageId: string; text: string } | null;
  /** Transcript text blocks emitted this turn (replay detection for late displays). */
  emittedTexts: string[];
  lastStopReason?: string;
  completionSeenAt?: number;
  compactedAt?: number;
  summarySeen: boolean;
  modelEmitted: boolean;
  usage?: ProviderFinishedEvent['usage'];
  stopHookSeen: boolean;
  failed?: string;
}

/**
 * One `MessageDisplay` stream: Claude Code fires this hook per displayed text
 * batch with `message_id`, `index`, `delta`, `final`. Batches can arrive out
 * of order (separate hook processes), display ids do not join to transcript
 * ids, and for SHORT messages the hook fires AFTER the transcript block. Only
 * the contiguous prefix is ever emitted; a stream that repeats a block the
 * transcript already delivered is a replay and is ignored.
 */
interface DisplayStream {
  parts: Map<number, string>;
  emittedLen: number;
  replay: boolean;
}

interface ClaimState {
  prompt: string;
  slash?: string;
  queue: AsyncEventQueue<ProviderEvent>;
  accepted: boolean;
  done: boolean;
}

// ─── Observer ────────────────────────────────────────────────────────────────

export class ClaudeTurnObserver {
  private turn: TurnState | null = null;
  private claim: ClaimState | null = null;
  private lastTranscriptGrowthAt = 0;
  private pendingCommandName: string | undefined;
  private syntheticSeq = 0;
  private ticking = false;
  private disposed = false;
  /** Tool ids of turns already closed: late transcript lines for them (e.g.
   *  the "User rejected tool use" result Claude writes AFTER an interrupt)
   *  must not open a phantom turn. */
  private readonly closedToolIds = new Set<string>();
  /** Text blocks of the last finalized turn: a MessageDisplay batch that
   *  arrives after finalize (short messages fire it late) must be recognised
   *  as a replay, never become a new turn or leak into the next one. */
  private recentTexts: string[] = [];
  /** AskUserQuestion pickers surfaced and not yet answered (for respondToPrompt). */
  private readonly pendingPrompts = new Map<
    string,
    InteractivePromptQuestion[]
  >();
  private readonly promptEmittedAt = new Map<string, number>();

  constructor(private readonly host: TurnObserverHost) {}

  private now(): number {
    return this.host.now?.() ?? Date.now();
  }

  // ── Driver-facing API ──────────────────────────────────────────────────────

  /** Register the prompt `sendMessage` is about to type; the next accepted
   *  prompt that matches it becomes a chat turn on the returned stream. */
  claimNextTurn(prompt: string): TurnClaim {
    if (this.claim) this.releaseClaim('superseded');
    const claim: ClaimState = {
      prompt,
      slash: slashName(prompt),
      queue: new AsyncEventQueue<ProviderEvent>(),
      accepted: false,
      done: false,
    };
    this.claim = claim;
    return {
      events: claim.queue,
      get accepted() {
        return claim.accepted;
      },
      get done() {
        return claim.done;
      },
    };
  }

  /** Drop a claim that never became a turn (abort before acceptance). */
  releaseClaim(reason: FinalizeReason = 'aborted'): void {
    const claim = this.claim;
    if (!claim) return;
    this.claim = null;
    claim.queue.push({ type: ProviderEventType.Aborted, reason });
    claim.queue.end();
    claim.done = true;
  }

  /** True while a turn runs or a typed prompt awaits acceptance. */
  isTurnActive(): boolean {
    return this.turn !== null || this.claim !== null;
  }

  get activeTurn(): { promptId: string; source: TurnSource } | null {
    return this.turn
      ? { promptId: this.turn.promptId, source: this.turn.source }
      : null;
  }

  hasPendingPrompts(): boolean {
    return this.pendingPrompts.size > 0;
  }

  getPendingPrompt(promptId: string): InteractivePromptQuestion[] | undefined {
    return this.pendingPrompts.get(promptId);
  }

  takePromptEmittedAt(promptId: string): number | undefined {
    const at = this.promptEmittedAt.get(promptId);
    this.promptEmittedAt.delete(promptId);
    return at;
  }

  /** The user interrupted (Esc / Ctrl+C) or the PTY died. */
  abortCurrentTurn(reason: FinalizeReason = 'aborted'): void {
    if (this.turn) this.finalize(reason);
    else if (this.claim) this.releaseClaim(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortCurrentTurn('dispose');
  }

  /** One poll: drain both channels, apply, then run the completion checks. */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      // Transcript first: it leads the hooks in reality (content lands
      // seconds before PreToolUse / Stop), so within one poll window the
      // content must be applied before a Stop can close the turn.
      const { entries, grew } = await this.host.drainTranscript();
      if (grew) {
        this.lastTranscriptGrowthAt = this.now();
        if (this.turn) this.turn.lastProgressAt = this.lastTranscriptGrowthAt;
      }
      for (const entry of entries) this.applyTranscript(entry);
      const hooks = await this.host.drainHooks();
      for (const ev of hooks) this.applyHook(ev);
      this.checkCompletion();
    } finally {
      this.ticking = false;
    }
  }

  // ── Turn lifecycle ─────────────────────────────────────────────────────────

  private startTurn(
    promptId: string,
    userText: string,
    slash: string | undefined,
    allowClaim: boolean,
  ): TurnState {
    if (this.turn) this.finalize('superseded');
    const claim = this.claim;
    let source: TurnSource;
    let queue: AsyncEventQueue<ProviderEvent>;
    let consumedClaim: ClaimState | undefined;
    if (claim && allowClaim) {
      source = 'chat';
      queue = claim.queue;
      claim.accepted = true;
      consumedClaim = claim;
      this.claim = null;
      this.host.onPromptAccepted();
      slash = slash ?? claim.slash;
    } else {
      source = classifyExternalSource(userText);
      queue = new AsyncEventQueue<ProviderEvent>();
    }
    const now = this.now();
    const turn: TurnState = {
      promptId,
      source,
      userText,
      slash,
      queue,
      claim: consumedClaim,
      startedAt: now,
      lastProgressAt: now,
      openTools: new Map(),
      seenToolUse: new Set(),
      seenToolResult: new Set(),
      askIds: new Set(),
      attention: new Set(),
      injected: new Set(),
      displays: new Map(),
      provisional: null,
      emittedTexts: [],
      summarySeen: false,
      modelEmitted: false,
      stopHookSeen: false,
    };
    this.turn = turn;
    if (source !== 'chat') {
      this.host.onExternalTurn({ promptId, source, userText, events: queue });
    }
    return turn;
  }

  /** A prompt was accepted (hook) or landed in the transcript (user line). */
  private startTurnFromPrompt(
    promptId: string,
    text: string,
    slash: string | undefined,
  ): TurnState {
    const claim = this.claim;
    const matches = claim ? promptMatches(claim.prompt, text) : false;
    return this.startTurn(promptId, text, slash, matches);
  }

  /** Something turn-shaped arrived with no open turn (both start signals
   *  missed, or a tool fired before either). Attribute to a pending claim. */
  private ensureTurn(): TurnState {
    if (this.turn) return this.turn;
    return this.startTurn(
      `synthetic-${++this.syntheticSeq}`,
      this.claim?.prompt ?? '',
      undefined,
      true,
    );
  }

  private finalize(reason: FinalizeReason): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    const push = (ev: ProviderEvent) => turn.queue.push(ev);
    for (const [id, name] of turn.openTools) {
      if (turn.seenToolResult.has(id)) continue;
      turn.seenToolResult.add(id);
      push({
        type: ProviderEventType.ToolResult,
        toolId: id,
        output: `[No result received for ${name} — the turn ended (${reason}).]`,
        isError: true,
      });
    }
    for (const id of turn.askIds) {
      this.pendingPrompts.delete(id);
      this.promptEmittedAt.delete(id);
      push({
        type: ProviderEventType.InteractivePromptResolved,
        promptId: id,
        response: { kind: 'cancelled', reason: 'user-cancel' },
      });
    }
    for (const id of turn.attention) {
      this.host.onNotice({
        kind: 'attention',
        phase: 'end',
        id,
        what: 'dialog',
      });
    }
    if (reason === 'aborted' || reason === 'dispose' || reason === 'pty-exit') {
      push({ type: ProviderEventType.Aborted, reason });
    } else if (turn.failed) {
      push({ type: ProviderEventType.Error, message: turn.failed });
    } else {
      push({ type: ProviderEventType.Finished, usage: turn.usage });
    }
    turn.queue.end();
    if (turn.claim) turn.claim.done = true;
    this.recentTexts = turn.provisional
      ? [...turn.emittedTexts, turn.provisional.text]
      : turn.emittedTexts;
    if (this.closedToolIds.size > 500) this.closedToolIds.clear();
    for (const id of turn.seenToolUse) this.closedToolIds.add(id);
  }

  /** A tool event for a turn that already ended — drop it (see closedToolIds). */
  private isStaleToolEvent(toolId: string): boolean {
    return !this.turn && this.closedToolIds.has(toolId);
  }

  private checkCompletion(): void {
    const turn = this.turn;
    if (!turn) return;
    const now = this.now();
    if (turn.compactedAt !== undefined && turn.slash === 'compact') {
      if (
        turn.summarySeen ||
        now - turn.compactedAt >= COMPACT_SUMMARY_GRACE_MS
      ) {
        this.finalize('compacted');
      }
      return;
    }
    if (
      turn.completionSeenAt !== undefined &&
      turn.openTools.size === 0 &&
      now - this.lastTranscriptGrowthAt >= TRANSCRIPT_SETTLE_MS
    ) {
      this.finalize('transcript');
      return;
    }
    const idle = now - turn.lastProgressAt;
    if (
      turn.slash &&
      idle >= SLASH_IDLE_MS &&
      this.host.ptyShowsInputPrompt()
    ) {
      this.finalize('idle');
      return;
    }
    if (
      idle >= NO_SIGNAL_IDLE_MS &&
      turn.openTools.size === 0 &&
      turn.askIds.size === 0 &&
      this.host.ptyShowsInputPrompt()
    ) {
      this.finalize('idle');
      return;
    }
    if (now - turn.startedAt >= TURN_CEILING_MS) {
      turn.failed = 'Timed out waiting for Claude to finish the turn.';
      this.finalize('timeout');
    }
  }

  // ── Hook channel ───────────────────────────────────────────────────────────

  private applyHook(ev: HookEvent): void {
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
        const promptId =
          pickString(p, 'prompt_id') ?? `synthetic-${++this.syntheticSeq}`;
        // A message typed while the turn runs is queued by Claude and then
        // injected into the SAME turn (verified live: UserPromptSubmit
        // re-fires with the running prompt_id). Surface it in place. A NEW
        // prompt_id that matches the pending chat claim is our own prompt
        // starting its turn — Claude runs one turn at a time, so whatever
        // turn we still hold (a synthetic one, or one whose Stop is late)
        // is over.
        const claimMatches =
          !!this.claim && promptMatches(this.claim.prompt, prompt);
        if (
          turn &&
          (turn.promptId === promptId ||
            (!turnLooksFinished(turn) && !claimMatches))
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
            `compact-${++this.syntheticSeq}`,
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
      case 'MessageDisplay':
        this.applyDisplay(p);
        break;
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

  private applyTranscript(entry: unknown): void {
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

  // ── MessageDisplay: provisional live text ────────────────────────────────

  private applyDisplay(p: Record<string, unknown>): void {
    const id = pickString(p, 'message_id');
    const index = p['index'];
    const delta = pickString(p, 'delta') ?? '';
    if (!id || typeof index !== 'number' || index < 0) return;
    // A display batch never starts a turn: with no open turn it is the late
    // echo of a block the finalized turn already delivered.
    const t = this.turn;
    if (!t) return;
    t.lastProgressAt = this.now();
    let stream = t.displays.get(id);
    if (!stream) {
      stream = { parts: new Map(), emittedLen: 0, replay: false };
      t.displays.set(id, stream);
    }
    if (!stream.parts.has(index)) stream.parts.set(index, delta);
    if (stream.replay) return;
    let acc = '';
    for (let i = 0; stream.parts.has(i); i++) acc += stream.parts.get(i);
    if (stream.emittedLen === 0) {
      // Short messages: the hook fires AFTER the transcript block — a stream
      // that repeats the last delivered block is a replay, not new text.
      const last = t.emittedTexts[t.emittedTexts.length - 1];
      const replays = (x: string | undefined) =>
        x !== undefined && acc.length > 0 && x.startsWith(acc);
      if (replays(last) || this.recentTexts.some(replays)) {
        stream.replay = true;
        return;
      }
      if (t.provisional && t.provisional.messageId !== id) {
        // The previous provisional block never got its canonical line.
        t.emittedTexts.push(t.provisional.text);
        t.provisional = null;
      }
    }
    if (acc.length > stream.emittedLen) {
      const fresh = acc.slice(stream.emittedLen);
      stream.emittedLen = acc.length;
      t.provisional = { messageId: id, text: acc };
      t.queue.push({ type: ProviderEventType.Content, text: fresh });
    }
  }

  /** A canonical transcript text block: emit only what the provisional
   *  display stream has not shown yet, then close that stream. */
  private emitCanonicalText(t: TurnState, text: string): void {
    const prov = t.provisional;
    t.provisional = null;
    t.emittedTexts.push(text);
    if (prov) {
      const stream = t.displays.get(prov.messageId);
      if (stream) stream.replay = true; // nothing more from this stream
      if (text.startsWith(prov.text)) {
        const rest = text.slice(prov.text.length);
        if (rest) t.queue.push({ type: ProviderEventType.Content, text: rest });
        return;
      }
      if (prov.text.startsWith(text)) return;
      // Mismatch: the canonical text wins; a visible repeat beats wrong text.
    }
    t.queue.push({ type: ProviderEventType.Content, text });
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
      (turn.promptId === promptId || !turnLooksFinished(turn) || !promptId)
    ) {
      this.noteInjectedMessage(turn, text);
      return;
    }
    this.startTurnFromPrompt(
      promptId ?? `synthetic-${++this.syntheticSeq}`,
      text,
      slashName(text),
    );
  }

  /** A user message that belongs to the running turn: its own prompt (already
   *  shown) or a queued message Claude injected mid-turn (show once). */
  private noteInjectedMessage(turn: TurnState, text: string): void {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (!norm || norm === turn.userText.replace(/\s+/g, ' ').trim()) return;
    if (turn.injected.has(norm)) return;
    turn.injected.add(norm);
    this.host.onNotice({ kind: 'user_message', text });
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
        if (t.completionSeenAt === undefined) t.completionSeenAt = this.now();
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
        `local-${++this.syntheticSeq}`,
        this.claim.prompt,
        this.claim.slash,
        true,
      );
    }
    if (this.turn?.slash) this.finalize('local');
  }

  // ── Event emission with dedup ─────────────────────────────────────────────

  private emitToolUse(
    t: TurnState,
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): void {
    if (t.seenToolUse.has(id)) return;
    t.seenToolUse.add(id);
    t.openTools.set(id, name);
    t.lastProgressAt = this.now();
    t.queue.push({
      type: ProviderEventType.ToolUse,
      toolName: name,
      toolId: id,
      input,
    });
    if (name === 'AskUserQuestion' && !t.askIds.has(id)) {
      const prompt = buildAskUserQuestionPromptEvent(id, input);
      if (prompt) {
        t.askIds.add(id);
        this.pendingPrompts.set(id, prompt.questions);
        this.promptEmittedAt.set(id, this.now());
        t.queue.push(prompt);
      }
    }
  }

  private emitToolResult(
    t: TurnState,
    id: string,
    output: string,
    isError: boolean,
  ): void {
    if (t.seenToolResult.has(id)) return;
    t.seenToolResult.add(id);
    t.openTools.delete(id);
    t.lastProgressAt = this.now();
    if (!t.seenToolUse.has(id)) {
      // Result for a tool we never saw start (both PreToolUse and the
      // transcript block missed): surface it so the pair stays matched.
      t.seenToolUse.add(id);
      t.queue.push({
        type: ProviderEventType.ToolUse,
        toolName: 'unknown',
        toolId: id,
        input: {},
      });
    }
    t.queue.push({
      type: ProviderEventType.ToolResult,
      toolId: id,
      output,
      isError,
    });
    if (t.askIds.has(id)) {
      t.askIds.delete(id);
      this.pendingPrompts.delete(id);
      this.promptEmittedAt.delete(id);
      t.queue.push({
        type: ProviderEventType.InteractivePromptResolved,
        promptId: id,
        response: { kind: 'answered', answers: [] },
      });
    }
    // Any result means the TUI is no longer waiting on a dialog.
    for (const attentionId of [...t.attention]) this.attentionEnd(attentionId);
  }

  private attentionStart(
    t: TurnState,
    id: string,
    what: 'permission' | 'question' | 'elicitation' | 'dialog' | 'trust',
    toolName?: string,
    detail?: string,
  ): void {
    if (t.attention.has(id)) return;
    t.attention.add(id);
    this.host.onNotice({
      kind: 'attention',
      phase: 'start',
      id,
      what,
      toolName,
      detail,
    });
  }

  private attentionEnd(id: string): void {
    const t = this.turn;
    if (!t || !t.attention.has(id)) return;
    t.attention.delete(id);
    this.host.onNotice({ kind: 'attention', phase: 'end', id, what: 'dialog' });
  }
}

// ─── Pure helpers (exported for tests and for the driver) ────────────────────

/** `<task-notification>`, `<system-reminder>`… are the CLI talking to itself. */
export function classifyExternalSource(text: string): ExternalTurnSource {
  return /^\s*<(task-notification|system-reminder|local-command)/i.test(text)
    ? 'system'
    : 'terminal';
}

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
  const plain = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 200 ? plain.slice(0, 197) + '…' : plain;
}

export function slashName(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  return trimmed.slice(1).split(/[\s/]/)[0]?.toLowerCase() || undefined;
}

/** Does the prompt Claude accepted correspond to what `sendMessage` typed?
 *  Whitespace-insensitive; tolerates a context prefix on either side. */
export function promptMatches(claimed: string, accepted: string): boolean {
  const a = claimed.replace(/\s+/g, ' ').trim();
  const b = accepted.replace(/\s+/g, ' ').trim();
  if (!a || !b) return true; // nothing to compare against — trust the claim
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 12 && longer.includes(shorter);
}

function turnLooksFinished(t: TurnState): boolean {
  return (
    t.stopHookSeen ||
    (t.lastStopReason !== undefined &&
      TERMINAL_STOP_REASONS.has(t.lastStopReason))
  );
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

function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainObject(block) || block['type'] !== 'text') continue;
    const text = pickString(block, 'text');
    if (text !== undefined) parts.push(text);
  }
  return parts.join('\n');
}

function matchTag(content: string, tag: string): string | undefined {
  const m = content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : undefined;
}

/** One-line preview of a tool input for an attention notice. */
export function summariseInput(input: unknown): string {
  if (!isPlainObject(input)) return '';
  for (const key of [
    'command',
    'file_path',
    'pattern',
    'query',
    'url',
    'path',
    'name',
    'question',
  ]) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) {
      const s = v.trim();
      return s.length > 140 ? s.slice(0, 137) + '…' : s;
    }
  }
  try {
    const dump = JSON.stringify(input);
    return dump.length > 140 ? dump.slice(0, 137) + '…' : dump;
  } catch {
    return '';
  }
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

function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
