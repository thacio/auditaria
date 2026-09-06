/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: One turn pipeline, any trigger — the
 * provider-agnostic core.
 *
 * A PTY-driven CLI (Claude Code, Codex, …) runs turns that Auditaria started
 * (a prompt typed by `sendMessage`) and turns it did not (the user typed into
 * the mirrored web terminal; the CLI continued on its own). Everything
 * downstream of "a turn is happening in the PTY" is identical, so ONE observer
 * per PTY reads the CLI's live channels — a hook relay and a transcript /
 * rollout file — and turns both into one ordered `ProviderEvent` stream per
 * turn. This base class owns what does not depend on the CLI:
 *
 *   - claims: `sendMessage` registers the prompt it is about to type; the next
 *     accepted prompt that matches becomes a chat turn on the claim's stream,
 *     anything else is an EXTERNAL turn handed to the host with the same
 *     stream shape;
 *   - turn lifecycle: start, injected messages (a prompt typed while a turn
 *     runs), finalize (synthetic errored results for dangling tools, cancelled
 *     pickers, attention end, Aborted / Error / Finished);
 *   - completion channels: a positive completion signal that must settle with
 *     no open tools, slash-command idle, no-signal idle with the PTY showing
 *     its input prompt, and an absolute ceiling — any single channel can be
 *     dropped, so all run every tick;
 *   - emission with dedup: tool use/result pairs (with fences for events that
 *     arrive after their turn closed), provisional live text reconciled
 *     against canonical text, attention notices, interactive prompts.
 *
 * Subclasses implement `applyHook` / `applyTranscript` for their CLI's
 * shapes. Pure with respect to I/O: the host supplies the drains and the PTY
 * probe, so the state machine is unit-testable on captured fixtures.
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
import { AsyncEventQueue } from './asyncEventQueue.js';

// ─── Tunables ─────────────────────────────────────────────────────────────────

/** Quiet time after a positive completion signal before the transcript channel finalizes. */
export const TRANSCRIPT_SETTLE_MS = 600;
/** No hook, no transcript growth for this long + idle prompt → finalize (last resort). */
export const NO_SIGNAL_IDLE_MS = 20_000;
/** Slash-command turns emit little: shorter idle ceiling. */
export const SLASH_IDLE_MS = 6_000;
/** Absolute ceiling for one turn (long-running tools). */
export const TURN_CEILING_MS = 30 * 60_000;
/** After a compaction signal, how long to wait for the summary before finalizing. */
export const COMPACT_SUMMARY_GRACE_MS = 4_000;

export interface TurnTimings {
  settleMs: number;
  idleMs: number;
  slashIdleMs: number;
  ceilingMs: number;
  compactGraceMs: number;
}

export const DEFAULT_TURN_TIMINGS: TurnTimings = {
  settleMs: TRANSCRIPT_SETTLE_MS,
  idleMs: NO_SIGNAL_IDLE_MS,
  slashIdleMs: SLASH_IDLE_MS,
  ceilingMs: TURN_CEILING_MS,
  compactGraceMs: COMPACT_SUMMARY_GRACE_MS,
};

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
  /** New transcript / rollout lines since the last call, parsed. */
  drainTranscript(): Promise<{ entries: unknown[]; grew: boolean }>;
  /** Does the PTY tail show the CLI's idle input prompt? */
  ptyShowsInputPrompt(): boolean;
  onExternalTurn(turn: ObservedTurn): void;
  onNotice(notice: ProviderNotice): void;
  /** The CLI switched session (`clear`, `resume`, `new`, …). */
  onSessionChange(sessionId: string, source: string): void;
  /** The claimed prompt was accepted by the TUI (stops the CR retry). */
  onPromptAccepted(): void;
  now?(): number;
}

// ─── Internal state (visible to subclasses) ──────────────────────────────────

export interface TurnState {
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
  /** Queued messages the CLI injected into this turn (normalised text). */
  injected: Set<string>;
  /** Provisional live-text streams keyed by display id. */
  displays: Map<string, DisplayStream>;
  /** Provisional text already pushed to the stream, awaiting its canonical block. */
  provisional: { messageId: string; text: string } | null;
  /** Canonical text blocks emitted this turn (replay detection for late displays). */
  emittedTexts: string[];
  lastStopReason?: string;
  /** A positive completion signal was seen at this time (finalize after settle). */
  completionSeenAt?: number;
  compactedAt?: number;
  summarySeen: boolean;
  modelEmitted: boolean;
  usage?: ProviderFinishedEvent['usage'];
  stopHookSeen: boolean;
  failed?: string;
}

/**
 * One provisional live-text stream (Claude's `MessageDisplay` hook): batches
 * with an index and a delta that can arrive out of order, do not join to
 * transcript ids, and for SHORT messages arrive AFTER the canonical block.
 * Only the contiguous prefix is ever emitted; a stream that repeats a block
 * already delivered is a replay and is ignored.
 */
export interface DisplayStream {
  parts: Map<number, string>;
  emittedLen: number;
  replay: boolean;
}

export interface ClaimState {
  prompt: string;
  slash?: string;
  queue: AsyncEventQueue<ProviderEvent>;
  accepted: boolean;
  done: boolean;
}

export type AttentionKind =
  | 'permission'
  | 'question'
  | 'elicitation'
  | 'dialog'
  | 'trust';

// ─── Observer ────────────────────────────────────────────────────────────────

export abstract class ProviderTurnObserver {
  protected turn: TurnState | null = null;
  protected claim: ClaimState | null = null;
  protected lastTranscriptGrowthAt = 0;
  protected syntheticSeq = 0;
  private ticking = false;
  private disposed = false;
  /** Tool ids of turns already closed: late lines for them (e.g. a rejected
   *  result written AFTER an interrupt) must not open a phantom turn. */
  protected readonly closedToolIds = new Set<string>();
  /** Text blocks of the last finalized turn: a display batch that arrives
   *  after finalize must be recognised as a replay, never become a new turn
   *  or leak into the next one. */
  protected recentTexts: string[] = [];
  /** Interactive pickers surfaced and not yet answered (for respondToPrompt). */
  protected readonly pendingPrompts = new Map<
    string,
    InteractivePromptQuestion[]
  >();
  protected readonly promptEmittedAt = new Map<string, number>();
  protected readonly timings: TurnTimings;

  constructor(
    protected readonly host: TurnObserverHost,
    /** Shown in timeout messages ("Timed out waiting for Codex …"). */
    protected readonly providerName: string,
    timings: Partial<TurnTimings> = {},
  ) {
    this.timings = { ...DEFAULT_TURN_TIMINGS, ...timings };
  }

  protected now(): number {
    return this.host.now?.() ?? Date.now();
  }

  // ── CLI-specific parts ─────────────────────────────────────────────────────

  protected abstract applyHook(ev: HookEvent): void;
  protected abstract applyTranscript(entry: unknown): void;
  /** Does this turn look over (so a new prompt is a new turn, not an injection)? */
  protected abstract turnLooksFinished(t: TurnState): boolean;
  /** An interactive prompt for a tool call the TUI will wait on (Claude's
   *  AskUserQuestion); null when the tool is not one. */
  protected interactivePromptFor(
    _toolId: string,
    _toolName: string,
    _input: Record<string, unknown>,
  ): InteractivePromptStartEvent | null {
    return null;
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
      // seconds before the tool / stop hooks), so within one poll window the
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

  protected nextSyntheticId(prefix = 'synthetic'): string {
    return `${prefix}-${++this.syntheticSeq}`;
  }

  protected startTurn(
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
  protected startTurnFromPrompt(
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
  protected ensureTurn(): TurnState {
    if (this.turn) return this.turn;
    return this.startTurn(
      this.nextSyntheticId(),
      this.claim?.prompt ?? '',
      undefined,
      true,
    );
  }

  /** Does the pending chat claim match this accepted prompt text? */
  protected claimMatches(text: string): boolean {
    return !!this.claim && promptMatches(this.claim.prompt, text);
  }

  protected finalize(reason: FinalizeReason): void {
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
  protected isStaleToolEvent(toolId: string): boolean {
    return !this.turn && this.closedToolIds.has(toolId);
  }

  /** Record a positive completion signal; the turn finalizes once it settled
   *  with no open tools (see checkCompletion). */
  protected markCompletionSeen(t: TurnState): void {
    if (t.completionSeenAt === undefined) t.completionSeenAt = this.now();
  }

  protected checkCompletion(): void {
    const turn = this.turn;
    if (!turn) return;
    const now = this.now();
    const tm = this.timings;
    if (turn.compactedAt !== undefined && turn.slash === 'compact') {
      if (turn.summarySeen || now - turn.compactedAt >= tm.compactGraceMs) {
        this.finalize('compacted');
      }
      return;
    }
    if (
      turn.completionSeenAt !== undefined &&
      turn.openTools.size === 0 &&
      now - this.lastTranscriptGrowthAt >= tm.settleMs
    ) {
      this.finalize('transcript');
      return;
    }
    const idle = now - turn.lastProgressAt;
    if (
      turn.slash &&
      idle >= tm.slashIdleMs &&
      this.host.ptyShowsInputPrompt()
    ) {
      this.finalize('idle');
      return;
    }
    if (
      idle >= tm.idleMs &&
      turn.openTools.size === 0 &&
      turn.askIds.size === 0 &&
      this.host.ptyShowsInputPrompt()
    ) {
      this.finalize('idle');
      return;
    }
    if (now - turn.startedAt >= tm.ceilingMs) {
      turn.failed = `Timed out waiting for ${this.providerName} to finish the turn.`;
      this.finalize('timeout');
    }
  }

  // ── Provisional live text ─────────────────────────────────────────────────

  /** A display batch (`message_id`, `index`, `delta`) of provisional text. */
  protected applyDisplay(id: string, index: number, delta: string): void {
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
      // Short messages: the display arrives AFTER the canonical block — a
      // stream that repeats the last delivered block is a replay, not new text.
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

  /** A canonical text block: emit only what the provisional display stream
   *  has not shown yet, then close that stream. */
  protected emitCanonicalText(t: TurnState, text: string): void {
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

  /** A user message that belongs to the running turn: its own prompt (already
   *  shown) or a queued message the CLI injected mid-turn (show once). */
  protected noteInjectedMessage(turn: TurnState, text: string): void {
    const norm = text.replace(/\s+/g, ' ').trim();
    if (!norm || norm === turn.userText.replace(/\s+/g, ' ').trim()) return;
    if (turn.injected.has(norm)) return;
    turn.injected.add(norm);
    this.host.onNotice({ kind: 'user_message', text });
  }

  // ── Event emission with dedup ─────────────────────────────────────────────

  protected emitToolUse(
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
    if (!t.askIds.has(id)) {
      const prompt = this.interactivePromptFor(id, name, input);
      if (prompt) {
        t.askIds.add(id);
        this.pendingPrompts.set(id, prompt.questions);
        this.promptEmittedAt.set(id, this.now());
        t.queue.push(prompt);
      }
    }
  }

  protected emitToolResult(
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
      // Result for a tool we never saw start (both channels missed it):
      // surface it so the pair stays matched.
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

  protected attentionStart(
    t: TurnState,
    id: string,
    what: AttentionKind,
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

  protected attentionEnd(id: string): void {
    const t = this.turn;
    if (!t || !t.attention.has(id)) return;
    t.attention.delete(id);
    this.host.onNotice({ kind: 'attention', phase: 'end', id, what: 'dialog' });
  }
}

// ─── Pure helpers (shared by the CLI-specific observers and their drivers) ───

/** `<task-notification>`, `<system-reminder>`… are the CLI talking to itself. */
export function classifyExternalSource(text: string): ExternalTurnSource {
  return /^\s*<(task-notification|system-reminder|local-command|turn_aborted)/i.test(
    text,
  )
    ? 'system'
    : 'terminal';
}

export function slashName(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  return trimmed.slice(1).split(/[\s/]/)[0]?.toLowerCase() || undefined;
}

/** Does the prompt the CLI accepted correspond to what `sendMessage` typed?
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

/** One-line preview of a tool input for an attention notice. */
export function summariseInput(input: unknown): string {
  if (!isPlainObject(input)) return '';
  for (const key of [
    'command',
    'cmd',
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

export function joinTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isPlainObject(block) || block['type'] !== 'text') continue;
    const text = pickString(block, 'text');
    if (text !== undefined) parts.push(text);
  }
  return parts.join('\n');
}

export function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

export function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
