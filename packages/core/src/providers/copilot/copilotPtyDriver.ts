/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_COPILOT_PROVIDER + AUDITARIA_PROVIDER_TERMINAL:
 * Interactive-mode GitHub Copilot CLI driver — the first consumer of the
 * provider-terminal abstraction (PtySession + providerPtyMirror +
 * JsonlFileTail).
 *
 * Why this exists: the original Copilot driver speaks ACP (agent-to-agent,
 * `copilot --acp --stdio`) — clean but headless. Driving the real TUI in a
 * PTY gives users the same live experience as the Claude provider: the
 * bidirectional web-terminal mirror, TUI slash commands (/model, /usage,
 * /login), and turns typed directly into the terminal surfacing in chat.
 *
 * Architecture (validated live against Copilot CLI 1.0.67):
 *   1. Spawn `copilot --session-id <uuid> --allow-all` in a PTY (the real
 *      copilot.exe, not the npm .cmd shim — cmd.exe wrapping breaks raw
 *      mode and survives kills). `--session-id` lets us PRE-ASSIGN the id,
 *      so the session-state path is known before spawn (no agy-style
 *      dir-diff discovery). Respawns use `--resume <uuid>`.
 *   2. The TUI writes a structured event log LIVE to
 *      `~/.copilot/session-state/<uuid>/events.jsonl`:
 *        user.message / assistant.turn_start / assistant.message (full text
 *        + model + outputTokens + toolRequests) / tool.execution_start /
 *        tool.execution_complete / assistant.turn_end / session.*
 *      We tail it with a byte cursor and map entries to ProviderEvents.
 *   3. Prompts are typed into the TUI (body, gap, CR — same technique as
 *      the Claude driver). The `user.message` event is positive
 *      confirmation the TUI ACCEPTED the prompt; if it doesn't appear we
 *      retry (Enter, then clear-and-retype) — a channel Claude doesn't have.
 *   4. Turn completion: `assistant.turn_end` fires per INFERENCE STEP, not
 *      per user turn — after tool calls a new turn_start (turnId+1) follows
 *      immediately. The reliable rule: a turn_end whose latest
 *      assistant.message carried NO toolRequests (and no tool still open),
 *      settled for a short window with no further event growth.
 *   5. The PTY persists across sendMessage calls (persistent session, warm
 *      TUI). Abort sends Esc (cancels the in-flight generation without
 *      nuking the TUI). Killed only in dispose()/interrupt().
 *   6. A background watcher drains events between chat-initiated turns so
 *      turns the user types directly into the (web-mirrored) terminal
 *      surface in Auditaria's chat — same duck-typed onBackground* interface
 *      the Claude driver exposes; providerManager forwards it unchanged.
 *
 * The ACP driver remains available as a fallback via
 * `AUDITARIA_COPILOT_ACP=1` (and stays the default for headless contexts:
 * sub-agent sessions and Teams threads).
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import type {
  ProviderDriver,
  ProviderEvent,
  AttachmentFile,
  InteractivePromptOption,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import { PtySession } from '../terminal/ptySession.js';
import { JsonlFileTail } from '../terminal/jsonlTail.js';
import { summariseToolArgs } from '../terminal/textUtils.js';
import type { CopilotDriverConfig } from './types.js';
import {
  injectAgentsMd,
  buildMcpConfigArg,
  resolveCopilotExecutable,
} from './shared.js';

const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[DEBUG][COPILOT_PTY]', ...args); // eslint-disable-line no-console
}

// Tuning constants (validated empirically against Copilot CLI 1.0.67).
// Ready timeout is generous: cold starts (first run after a self-update,
// skill/MCP loading) have been observed to exceed 30s.
const TUI_READY_TIMEOUT_MS = 60_000;
/** Extra settle after the TUI chrome renders before we type (fresh spawn). */
const READY_GRACE_FRESH_MS = 1500;
/** Resume replays history + reconnects MCP — give it longer before typing. */
const READY_GRACE_RESUME_MS = 3000;
/** Event-quiet window after a final-looking turn_end before we finalize.
 *  Continuation turns start within milliseconds, so this is generous. */
const TURN_SETTLE_MS = 1200;
/** No user.message after typing → first retry (Enter re-press). */
const PROMPT_CONFIRM_MS = 10_000;
/** Ladder step for the clear-and-retype retry. */
const PROMPT_RETRY_MS = 8_000;
/** No echo of the typed prompt in PTY output after this → input was
 *  swallowed (TUI churn / focus trap); recover fast instead of waiting. */
const ECHO_WAIT_MS = 3_000;
/** Echo-verified retype attempts per PTY life before the respawn escalation. */
const MAX_TYPE_ATTEMPTS = 3;
/** After the TUI footer renders, wait up to this long for the startup
 *  notification burst (gh check, "MCP Servers reloaded") to land before
 *  typing — input typed during that churn gets swallowed. */
const STARTUP_CHURN_MAX_MS = 12_000;
/** Slash commands may produce no events at all — finalize after this. */
const SLASH_IDLE_DONE_MS = 20_000;
/** A session.error with no completion following → fail the turn after this. */
const ERROR_SETTLE_MS = 3_000;
/** Accepted turn, no open tools, event log silent this long → finalize.
 *  Long on purpose: a single inference step writes no events until it ends,
 *  so this must comfortably exceed the longest silent generation. */
const NO_EVENT_IDLE_MS = 180_000;
const STOP_TIMEOUT_MS = 30 * 60_000; // parity with the Claude driver
const POLL_INTERVAL_MS = 100;
const BACKGROUND_POLL_MS = 300;

const ESC = '\x1b';
/**
 * Focus-in report (mode 1004). The Copilot TUI enables focus reporting; the
 * web-terminal viewer (xterm.js) therefore sends focus-out (ESC [O) whenever
 * the user clicks from the mirrored terminal back to the chat input — and an
 * "unfocused" Copilot input box IGNORES Enter (typed text accumulates,
 * nothing submits; validated live). Asserting focus-in before every typed
 * prompt neutralizes the stale focus-out. Harmless when already focused.
 */
const FOCUS_IN = '\x1b[I';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function pickString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------
// Pure per-turn event tracker (exported for unit tests).
//
// Feed it batches of parsed events.jsonl entries; it returns the
// ProviderEvents to yield and tracks turn-completion state:
//   - promptAccepted: the TUI acknowledged our typed prompt (user.message)
//   - completionCandidateAt: set when an assistant.turn_end looked FINAL
//     (latest assistant.message had no toolRequests and no tool is open);
//     cleared whenever a new turn_start arrives (agentic continuation).
// ---------------------------------------------------------------------------

export class CopilotTurnTracker {
  promptAccepted = false;
  completionCandidateAt: number | undefined = undefined;
  /** session.compaction_start was observed (compaction is running). */
  compactionStarted = false;
  /** session.compaction_complete with success=true was observed. */
  compactionSucceeded = false;
  /** session.error payload — fatal for the turn (fail fast, don't wait 30min). */
  fatalError: string | undefined = undefined;

  private modelEmitted = false;
  private lastAssistantHadToolRequests = false;
  private openToolIds = new Set<string>();
  /** ask_user tool calls surfaced as InteractivePromptStart (awaiting answer). */
  private surfacedAskIds = new Set<string>();
  private outputTokens = 0;
  private accumulatedText = '';
  private lastWarning: string | undefined = undefined;

  /**
   * @param manualCompact true when the typed prompt was `/compact` — a
   * session.compaction_complete then ENDS the turn (the TUI runs the
   * command without any assistant turn events). For normal turns a
   * compaction_complete is an auto-compact happening mid-turn: surface it
   * but keep waiting for the real turn end.
   */
  constructor(private readonly manualCompact = false) {}

  ingest(entries: unknown[], now: number = Date.now()): ProviderEvent[] {
    const events: ProviderEvent[] = [];
    for (const raw of entries) {
      if (!isRecord(raw)) continue;
      const entryType = raw['type'];
      if (typeof entryType !== 'string') continue;
      const data = isRecord(raw['data']) ? raw['data'] : {};

      switch (entryType) {
        case 'user.message':
          this.promptAccepted = true;
          break;

        case 'assistant.turn_start':
          // Agentic continuation (or first step) — not final.
          this.completionCandidateAt = undefined;
          break;

        case 'assistant.message': {
          const model = pickString(data, 'model');
          if (model && !this.modelEmitted) {
            this.modelEmitted = true;
            events.push({ type: ProviderEventType.ModelInfo, model });
          }
          // Claude-family models via Copilot expose readable reasoning;
          // GPT-family carries only reasoningOpaque (skip).
          const reasoning = pickString(data, 'reasoning');
          if (reasoning) {
            events.push({ type: ProviderEventType.Thinking, text: reasoning });
          }
          const content = pickString(data, 'content');
          if (content) {
            this.accumulatedText +=
              (this.accumulatedText ? '\n' : '') + content;
            events.push({ type: ProviderEventType.Content, text: content });
          }
          const toolRequests = data['toolRequests'];
          this.lastAssistantHadToolRequests =
            Array.isArray(toolRequests) && toolRequests.length > 0;
          const out = data['outputTokens'];
          if (typeof out === 'number') this.outputTokens += out;
          break;
        }

        case 'tool.execution_start': {
          const toolId = pickString(data, 'toolCallId');
          const toolName = pickString(data, 'toolName');
          if (toolId && toolName) {
            this.openToolIds.add(toolId);
            const args = data['arguments'];
            events.push({
              type: ProviderEventType.ToolUse,
              toolName,
              toolId,
              input: isRecord(args) ? args : {},
            });
            // Copilot's ask_user tool renders an interactive picker in the
            // TUI (probe-validated args: {question, choices[], allow_freeform}).
            // Surface it like Claude's AskUserQuestion so the CLI layer can
            // route the user to the terminal (web viewer opens + focuses).
            // The picker blocks the turn until answered; openToolIds already
            // prevents any completion/idle finalize meanwhile.
            if (toolName === 'ask_user') {
              this.surfacedAskIds.add(toolId);
              const argsRec = isRecord(args) ? args : {};
              const question =
                pickString(argsRec, 'question') ??
                'Copilot is asking a question';
              const rawChoices = argsRec['choices'];
              const options: InteractivePromptOption[] = Array.isArray(
                rawChoices,
              )
                ? rawChoices
                    .filter((c) => typeof c === 'string')
                    .map((c: string) => ({ id: c, label: c }))
                : [];
              events.push({
                type: ProviderEventType.InteractivePromptStart,
                promptId: toolId,
                kind: 'ask-user',
                title: question,
                questions: [
                  {
                    id: 'q-0',
                    question,
                    options,
                    multiSelect: false,
                  },
                ],
                toolName: 'ask_user',
                timeoutMs: 60 * 60_000, // 1h — the user may take a while
              });
            }
          }
          break;
        }

        case 'tool.execution_complete': {
          const toolId = pickString(data, 'toolCallId');
          if (toolId) {
            this.openToolIds.delete(toolId);
            // Close any ask_user prompt the UI surfaced for this call.
            if (this.surfacedAskIds.delete(toolId)) {
              events.push({
                type: ProviderEventType.InteractivePromptResolved,
                promptId: toolId,
                response: { kind: 'answered', answers: [] },
              });
            }
            const result = isRecord(data['result']) ? data['result'] : {};
            let output = pickString(result, 'content') ?? '';
            if (!output && result['content'] !== undefined) {
              try {
                output = JSON.stringify(result['content']);
              } catch {
                output = String(result['content']);
              }
            }
            events.push({
              type: ProviderEventType.ToolResult,
              toolId,
              output,
              isError: data['success'] === false,
            });
          }
          break;
        }

        case 'assistant.turn_end':
          // Final only when the model's last message requested no tools and
          // nothing is still executing — otherwise a new turn follows with
          // the tool results.
          if (
            !this.lastAssistantHadToolRequests &&
            this.openToolIds.size === 0
          ) {
            this.completionCandidateAt = now;
          } else {
            this.completionCandidateAt = undefined;
          }
          break;

        // Copilot's /compact (and auto-compaction) writes structured events
        // (validated live on 1.0.67):
        //   session.compaction_start    {systemTokens, conversationTokens, …}
        //   session.compaction_complete {success, preCompactionTokens,
        //                                postCompactionTokens, messagesRemoved}
        case 'session.compaction_start':
          this.compactionStarted = true;
          break;

        case 'session.compaction_complete': {
          const success = data['success'] !== false;
          const preRaw = data['preCompactionTokens'];
          const preTokens = typeof preRaw === 'number' ? preRaw : 0;
          if (success) {
            this.compactionSucceeded = true;
            events.push({
              type: ProviderEventType.Compacted,
              preTokens,
              trigger: this.manualCompact ? 'manual' : 'auto',
            });
          }
          if (this.manualCompact) {
            // /compact produces no assistant turn — this event IS the end.
            this.completionCandidateAt = now;
          }
          break;
        }

        case 'session.warning': {
          const msg = pickString(data, 'message') ?? pickString(data, 'error');
          if (msg) this.lastWarning = msg;
          break;
        }

        case 'session.error': {
          const msg =
            pickString(data, 'message') ??
            pickString(data, 'error') ??
            'unknown session error';
          this.lastWarning = msg;
          this.fatalError = msg;
          break;
        }

        default:
          break;
      }
    }
    return events;
  }

  hasOpenTools(): boolean {
    return this.openToolIds.size > 0;
  }

  getUsage(): { outputTokens: number } | undefined {
    return this.outputTokens > 0
      ? { outputTokens: this.outputTokens }
      : undefined;
  }

  getAccumulatedText(): string {
    return this.accumulatedText;
  }

  getLastWarning(): string | undefined {
    return this.lastWarning;
  }
}

// ---------------------------------------------------------------------------
// Args builder (exported for unit tests).
// `--session-id <uuid>` pre-assigns a NEW session's id; `--resume <uuid>`
// reopens an existing one (same session-state dir, events.jsonl appends).
// ---------------------------------------------------------------------------

export function buildCopilotPtyArgs(opts: {
  sessionId: string;
  resume: boolean;
  model?: string;
  reasoningEffort?: string;
  mcpConfigArg?: string;
}): string[] {
  const args: string[] = [];
  if (opts.resume) {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--session-id', opts.sessionId);
  }
  args.push('--allow-all');
  if (opts.model && opts.model !== 'auto') {
    args.push('--model', opts.model);
  }
  if (opts.reasoningEffort) {
    args.push('--effort', opts.reasoningEffort);
  }
  if (opts.mcpConfigArg) {
    args.push('--additional-mcp-config', opts.mcpConfigArg);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class CopilotPtyDriver implements ProviderDriver {
  readonly canResume = true;

  private session: PtySession | null = null;
  private sessionId: string | undefined;
  /** True once the current sessionId exists on disk → respawns use --resume. */
  private useResume = false;
  /**
   * True only after the FULL spawn path completed (TUI ready + events tail
   * positioned + watcher started). A spawn whose readiness wait failed can
   * leave the process alive — such a session must be torn down and
   * respawned, never reused (its events tail was never positioned).
   */
  private spawnReady = false;
  private exePath: string | null = null;
  private eventsTail = new JsonlFileTail(() => this.eventsPath());
  private turnInFlight = false;

  // Background (web-terminal typed) turn surfacing — same duck-typed shape
  // as the Claude driver; providerManager forwards it automatically.
  private backgroundEmitter = new EventEmitter();
  private backgroundTimer: NodeJS.Timeout | null = null;
  private bgTickInFlight = false;

  constructor(private readonly config: CopilotDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
  }

  // ─── ProviderDriver surface ───────────────────────────────────────────

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    const previous = this.sessionId;
    this.sessionId = id;
    this.useResume = true;
    this.eventsTail.reset(0);
    if (previous !== id && this.session?.isAlive()) {
      dbg('setSessionId: session changed — killing PTY for respawn');
      this.session.kill();
      this.spawnReady = false;
    }
  }

  resetSession(): void {
    this.session?.kill();
    this.spawnReady = false;
    this.sessionId = undefined;
    this.useResume = false;
    this.eventsTail.reset(0);
  }

  async interrupt(): Promise<void> {
    this.session?.kill();
  }

  dispose(): void {
    this.stopBackgroundWatcher();
    this.backgroundEmitter.removeAllListeners();
    this.session?.kill();
    this.session = null;
    this.spawnReady = false;
  }

  // ─── Background event subscriptions (duck-typed BackgroundCapableDriver) ──

  onBackgroundUserMessage(
    handler: (data: { text: string }) => void,
  ): () => void {
    this.backgroundEmitter.on('user-message', handler);
    return () => this.backgroundEmitter.off('user-message', handler);
  }

  onBackgroundAssistantText(
    handler: (data: { text: string }) => void,
  ): () => void {
    this.backgroundEmitter.on('assistant-text', handler);
    return () => this.backgroundEmitter.off('assistant-text', handler);
  }

  onBackgroundError(handler: (data: { message: string }) => void): () => void {
    this.backgroundEmitter.on('error', handler);
    return () => this.backgroundEmitter.off('error', handler);
  }

  // ─── sendMessage ──────────────────────────────────────────────────────

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
    attachmentFiles?: AttachmentFile[],
  ): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) return;

    if (attachmentFiles?.length) {
      yield {
        type: ProviderEventType.Error,
        message:
          'Image attachments are not supported with the interactive Copilot ' +
          'terminal driver. Drop the image, or set AUDITARIA_COPILOT_ACP=1 ' +
          'to use the headless ACP driver (supports inline images).',
      };
      return;
    }

    // Copilot reads AGENTS.md at session start; keep it fresh anyway so a
    // respawn (or Copilot re-read) picks up the latest context.
    if (systemContext) {
      injectAgentsMd(this.config.cwd, systemContext);
    }

    const spawnError = await this.ensureSpawned(signal);
    if (spawnError) {
      yield { type: ProviderEventType.Error, message: spawnError };
      return;
    }
    // `let`: the recovery ladder may respawn the PTY mid-turn (retry 3).
    let session = this.session!;

    this.turnInFlight = true;
    try {
      // Flush any events from turns the user drove directly in the web
      // terminal BEFORE our prompt, so they surface as background chat
      // entries rather than bleeding into this turn's stream.
      await this.backgroundTick(true);

      const trimmed = prompt.trimStart();
      const isSlash = trimmed.startsWith('/');
      const isCompact = /^\/compact\b/i.test(trimmed);
      const tracker = new CopilotTurnTracker(isCompact);

      // Abort wiring BEFORE the prompt is typed, so a cancellation landing
      // during the typing window still sends Esc (otherwise the cancelled
      // prompt would silently execute).
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        // Esc cancels the in-flight generation; the TUI (and session)
        // survives for the next turn. Ctrl+C would risk exiting the TUI.
        void session.writeSystem(ESC);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted && !aborted) onAbort();

      try {
        const deadline = Date.now() + STOP_TIMEOUT_MS;
        let typedAt = Date.now();
        let lastGrowthAt = Date.now();
        // Closed-loop typing state. The TUI can swallow typed input entirely
        // (notification / instruction-reload churn, focus trapped in a popup
        // or expanded pane after mouse interaction in the mirrored terminal).
        // The input box ECHOES what actually reaches it, so we verify the
        // echo in the PTY output and retype quickly instead of waiting blind.
        let echoSeen = false;
        let enterRetried = false;
        let attempts = 0;
        let respawnsUsed = 0;

        const typeAttempt = async () => {
          // Assert terminal focus first — a stale focus-out from the web
          // viewer makes the input box ignore Enter (see FOCUS_IN).
          await session.writeSystem(FOCUS_IN);
          // Fresh output buffer so the echo check only sees post-type bytes
          // (a prompt quoting on-screen text must not self-match).
          session.clearRecentOutput();
          dbg('typing prompt', { chars: prompt.length, isSlash, attempts });
          await session.typeSubmit(prompt);
          typedAt = Date.now();
          echoSeen = false;
          enterRetried = false;
        };
        const recoverAndRetype = async () => {
          // Copilot's input clears with DOUBLE-Esc (the first arms the
          // "esc again to clear input" hint) — this also closes popups /
          // expanded panes. Then retype with focus asserted.
          await session.writeSystem(ESC);
          await new Promise<void>((r) => setTimeout(r, 250));
          await session.writeSystem(ESC);
          await new Promise<void>((r) => setTimeout(r, 300));
          await typeAttempt();
        };

        await typeAttempt();

        while (Date.now() < deadline) {
          if (aborted || signal.aborted) {
            dbg('turn aborted');
            // Skip whatever the aborted turn already wrote — otherwise the
            // background watcher replays it as ghost chat entries (including
            // a duplicate of our own user message).
            await this.eventsTail.seekToEnd();
            return;
          }

          const { entries, grew } = await this.eventsTail.drain();
          if (grew) lastGrowthAt = Date.now();
          for (const ev of tracker.ingest(entries)) yield ev;

          // Prompt-acceptance ladder. user.message in events.jsonl is
          // positive confirmation the TUI took our prompt; without it the
          // CR may have been swallowed (resume replay, focus race).
          if (!tracker.promptAccepted) {
            if (isSlash) {
              // TUI-level slash commands (e.g. /model, /usage) never write
              // a user.message. /compact DOES write compaction events (the
              // tracker finalizes on session.compaction_complete); other
              // commands get a quiet moment, then finish — the user sees
              // the result in the terminal mirror. Gate on event growth too
              // so a long-running /compact isn't cut off mid-compaction,
              // and never fabricate a Compacted we didn't observe (a wrong
              // one would wipe the mirrored history while Copilot's real
              // context stayed intact — compactNative falls back to
              // Gemini-side compression instead).
              if (
                !tracker.compactionStarted &&
                Date.now() - Math.max(typedAt, lastGrowthAt) >
                  SLASH_IDLE_DONE_MS
              ) {
                dbg('slash command idle-finalize');
                yield { type: ProviderEventType.Finished };
                return;
              }
            } else {
              if (!echoSeen && this.promptEchoVisible(session, prompt)) {
                echoSeen = true;
                dbg('prompt echo confirmed in PTY output');
              }
              const sinceTyped = Date.now() - typedAt;
              // Only interfere while nothing has happened since we typed —
              // if events grew, the turn likely started and acceptance is
              // on its way; an Esc now could cancel a live generation.
              const noTurnActivity = lastGrowthAt <= typedAt;

              const attemptFailed =
                // Echo never appeared: input went nowhere (swallowed by
                // churn / focus trap) — recover fast.
                (!echoSeen && noTurnActivity && sinceTyped > ECHO_WAIT_MS) ||
                // Echo present, Enter re-pressed, still no acceptance:
                // something is eating the submit — full retype.
                (echoSeen &&
                  enterRetried &&
                  noTurnActivity &&
                  sinceTyped > PROMPT_CONFIRM_MS + PROMPT_RETRY_MS);

              if (attemptFailed) {
                attempts++;
                if (attempts <= MAX_TYPE_ATTEMPTS) {
                  dbg(`typing attempt failed — recovery retype #${attempts}`);
                  await recoverAndRetype();
                } else if (respawnsUsed === 0) {
                  dbg('retypes exhausted — respawn + fresh attempt cycle');
                  respawnsUsed = 1;
                  attempts = 0;
                  // Nuclear option: the TUI is in a state keystrokes can't
                  // fix. Respawn resuming the SAME session (context intact
                  // on disk); the echo-verified typing loop then gets a
                  // full set of attempts against the fresh TUI.
                  session.kill();
                  const respawnErr = await this.ensureSpawned(signal);
                  if (respawnErr) {
                    yield {
                      type: ProviderEventType.Error,
                      message:
                        'Copilot TUI stopped accepting input and the ' +
                        'recovery respawn failed: ' +
                        respawnErr,
                    };
                    return;
                  }
                  session = this.session!;
                  await typeAttempt();
                } else {
                  yield {
                    type: ProviderEventType.Error,
                    message:
                      'The Copilot TUI did not accept the prompt (no ' +
                      'user.message event appeared), even after a recovery ' +
                      'respawn. It may be showing a dialog or login screen — ' +
                      'open the web terminal to check. Last terminal output:\n' +
                      this.ptyTail(session),
                  };
                  return;
                }
              } else if (
                echoSeen &&
                !enterRetried &&
                noTurnActivity &&
                sinceTyped > PROMPT_CONFIRM_MS
              ) {
                // Text reached the input box but wasn't submitted — the CR
                // was likely swallowed. Press Enter once before escalating.
                dbg('echo present but no acceptance — pressing Enter');
                enterRetried = true;
                await session.writeSystem('\r');
              }
            }
          }

          // Completion: final-looking turn_end + event-quiet settle window.
          if (
            tracker.completionCandidateAt !== undefined &&
            Date.now() - lastGrowthAt >= TURN_SETTLE_MS
          ) {
            dbg('turn complete');
            // The Compacted event itself is emitted by the tracker from
            // session.compaction_complete; here we only attach a summary if
            // any assistant text accompanied the compaction.
            if (isCompact && tracker.compactionSucceeded) {
              const summary = tracker.getAccumulatedText();
              if (summary.trim().length > 0) {
                yield {
                  type: ProviderEventType.CompactionSummary,
                  summary,
                };
              }
            }
            yield {
              type: ProviderEventType.Finished,
              usage: tracker.getUsage(),
            };
            return;
          }

          // Fail fast on a fatal session error when no completion follows
          // shortly — don't sit on a dead turn for 30 minutes.
          if (
            tracker.fatalError !== undefined &&
            tracker.completionCandidateAt === undefined &&
            Date.now() - lastGrowthAt >= ERROR_SETTLE_MS
          ) {
            yield {
              type: ProviderEventType.Error,
              message: `Copilot session error: ${tracker.fatalError}`,
            };
            return;
          }

          // Last-resort idle fallback (the Claude driver's hard-won lesson:
          // single-channel completion detection eventually hangs a turn).
          // If the prompt was accepted, no tool is executing, and the event
          // log has been silent for a long time, finalize with whatever we
          // have — e.g. the user pressed Esc inside the mirrored terminal
          // (cancels generation without our AbortSignal), or Copilot died
          // mid-step without a final turn_end.
          if (
            tracker.promptAccepted &&
            !tracker.hasOpenTools() &&
            Date.now() - lastGrowthAt >= NO_EVENT_IDLE_MS
          ) {
            dbg('no-event idle fallback finalize');
            if (tracker.getAccumulatedText().trim().length > 0) {
              yield {
                type: ProviderEventType.Finished,
                usage: tracker.getUsage(),
              };
            } else {
              yield {
                type: ProviderEventType.Error,
                message:
                  'Copilot produced no completion signal (turn cancelled in ' +
                  'the terminal, or the CLI stopped writing events). Check ' +
                  'the web terminal for the session state.',
              };
            }
            return;
          }

          if (session.hasExited()) {
            // Drain any final events flushed on shutdown, then surrender.
            await new Promise<void>((r) => setTimeout(r, 100));
            const final = await this.eventsTail.drain();
            for (const ev of tracker.ingest(final.entries)) yield ev;
            if (tracker.completionCandidateAt !== undefined) {
              yield {
                type: ProviderEventType.Finished,
                usage: tracker.getUsage(),
              };
              return;
            }
            const warn = tracker.getLastWarning();
            yield {
              type: ProviderEventType.Error,
              message:
                `copilot exited before the turn completed (code ${session.exitCode})` +
                (warn ? `: ${warn}` : '.'),
            };
            return;
          }

          await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
        }

        const warn = tracker.getLastWarning();
        yield {
          type: ProviderEventType.Error,
          message:
            'Timed out waiting for Copilot turn completion.' +
            (warn ? ` Last session warning: ${warn}` : ''),
        };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    } finally {
      this.turnInFlight = false;
    }
  }

  // ─── Spawn / readiness ────────────────────────────────────────────────

  /** Compact tail of the stripped PTY output for error messages. Fullscreen
   *  TUIs render with cursor moves rather than newlines, so a "last lines"
   *  cut produces a useless megablob — use the last characters instead. */
  private ptyTail(session: PtySession, chars = 400): string {
    return session.strippedOutput().replace(/\s+/g, ' ').trim().slice(-chars);
  }

  /**
   * Best-effort check that the typed prompt is echoed in the PTY output —
   * the positive signal that the bytes reached the input box at all. Both
   * sides are whitespace-compacted (the TUI wraps at the box width) and the
   * needle is short (renders can interleave UI fragments between characters
   * mid-typing; the trailing characters sit next to the cursor and render
   * contiguously). Callers must clear the rolling buffer before typing so a
   * prompt quoting on-screen text can't self-match.
   */
  private promptEchoVisible(session: PtySession, prompt: string): boolean {
    const needle = prompt.replace(/\s+/g, '').slice(-12);
    if (!needle) return true;
    return session.strippedOutput().replace(/\s+/g, '').includes(needle);
  }

  private eventsPath(): string | undefined {
    if (!this.sessionId) return undefined;
    return join(
      homedir(),
      '.copilot',
      'session-state',
      this.sessionId,
      'events.jsonl',
    );
  }

  /** Returns an error message string, or null when a live TUI is ready. */
  private async ensureSpawned(signal: AbortSignal): Promise<string | null> {
    if (this.session?.isAlive()) {
      if (this.spawnReady) return null;
      // Alive but the previous spawn never reached readiness (e.g. the user
      // aborted during the ready-wait). Its events tail was never
      // positioned — reusing it would replay stale history. Restart clean.
      this.session.kill();
    }
    this.spawnReady = false;

    if (!this.exePath) {
      this.exePath = resolveCopilotExecutable() ?? null;
    }
    if (!this.exePath) {
      return (
        'Could not locate the `copilot` executable on PATH. Install the ' +
        'GitHub Copilot CLI: npm install -g @github/copilot'
      );
    }

    const resume = this.useResume && !!this.sessionId;
    if (!this.sessionId) this.sessionId = randomUUID();

    const args = buildCopilotPtyArgs({
      sessionId: this.sessionId,
      resume,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      mcpConfigArg: buildMcpConfigArg(this.config),
    });

    this.session = new PtySession({
      cwd: this.config.cwd,
      mirror: this.config.mirrorPty !== false,
      mirrorLabel: 'GitHub Copilot',
    });

    dbg('spawning', { exe: this.exePath, args, resume });
    const spawnErr = await this.session.spawn(this.exePath, args);
    if (spawnErr) return spawnErr;

    const readyErr = await this.waitForTuiReady(signal, resume);
    if (readyErr) {
      // Never got a usable TUI — tear the half-started process down. If the
      // session never materialized on disk (first spawn), drop the id so the
      // next attempt starts fresh (`--resume` of a virgin id would fail).
      this.session.kill();
      if (!this.useResume) this.sessionId = undefined;
      return readyErr;
    }
    // The session now exists on disk — future respawns resume it.
    this.useResume = true;

    // Only consume events from AFTER this point for the next turn; anything
    // already in the file (resumed history) was surfaced in past turns.
    await this.eventsTail.seekToEnd();

    this.spawnReady = true;
    this.startBackgroundWatcher();
    return null;
  }

  /** Returns an error message string, or null once the TUI accepts input. */
  private async waitForTuiReady(
    signal: AbortSignal,
    resume: boolean,
  ): Promise<string | null> {
    const session = this.session!;
    const deadline = Date.now() + TUI_READY_TIMEOUT_MS;
    let trustDismissed = false;

    while (Date.now() < deadline) {
      if (signal.aborted) return 'Aborted while waiting for the Copilot TUI.';
      if (session.hasExited()) {
        const tail = this.ptyTail(session);
        return (
          `copilot exited during startup (code ${session.exitCode}). ` +
          'Check that the CLI is installed and authenticated (`copilot /login`).' +
          (tail ? `\nLast output:\n${tail}` : '')
        );
      }

      const stripped = session.strippedOutput();
      const lower = stripped.toLowerCase();

      // Trusted-folder dialog: best-effort Enter to accept the default,
      // mirroring the Claude driver's approach.
      if (
        !trustDismissed &&
        lower.includes('trust') &&
        (lower.includes('folder') || lower.includes('files'))
      ) {
        dbg('trust-like dialog detected — sending Enter');
        session.writeUnqueued('\r');
        trustDismissed = true;
      }

      // The input footer ("/ commands · ? help · tab next tab") renders when
      // the input box exists. Resume replays history after that, so wait a
      // longer grace before typing on resume.
      if (stripped.includes('? help') || stripped.includes('/ commands')) {
        // Startup notification burst (gh-not-installed check, "MCP Servers
        // reloaded: N servers connected") lands AFTER the footer; a prompt
        // typed during that churn is swallowed. When our MCP bridge is
        // configured, the reload line is a reliable "burst done" marker —
        // wait for it (bounded), then the usual grace.
        if (this.config.toolBridgePort) {
          const churnDeadline = Date.now() + STARTUP_CHURN_MAX_MS;
          while (
            Date.now() < churnDeadline &&
            !signal.aborted &&
            !session.hasExited() &&
            !/MCP Servers reloaded|servers? connected/i.test(
              session.strippedOutput(),
            )
          ) {
            await new Promise<void>((r) => setTimeout(r, 200));
          }
        }
        await new Promise<void>((r) =>
          setTimeout(r, resume ? READY_GRACE_RESUME_MS : READY_GRACE_FRESH_MS),
        );
        return null;
      }

      await new Promise<void>((r) => setTimeout(r, 200));
    }
    return 'Timed out waiting for the Copilot TUI to become ready.';
  }

  // ─── Background watcher (web-terminal typed turns) ────────────────────

  private startBackgroundWatcher(): void {
    if (this.backgroundTimer) return;
    this.backgroundTimer = setInterval(() => {
      void this.backgroundTick(false);
    }, BACKGROUND_POLL_MS);
  }

  private stopBackgroundWatcher(): void {
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  /**
   * Drain events that arrived OUTSIDE a chat-initiated turn (the user typed
   * into the live terminal) and surface them to chat. `force` runs even
   * while paused — used once at turn start to flush stragglers.
   */
  private async backgroundTick(force: boolean): Promise<void> {
    if (!force && this.turnInFlight) return;
    if (this.bgTickInFlight) return;
    if (!this.session?.isAlive()) return;
    this.bgTickInFlight = true;
    try {
      const { entries } = await this.eventsTail.drain();
      for (const raw of entries) {
        if (!isRecord(raw)) continue;
        const entryType = raw['type'];
        if (typeof entryType !== 'string') continue;
        const data = isRecord(raw['data']) ? raw['data'] : {};
        switch (entryType) {
          case 'user.message': {
            const text = pickString(data, 'content');
            if (text) {
              this.backgroundEmitter.emit('user-message', { text });
            }
            break;
          }
          case 'assistant.message': {
            const text = pickString(data, 'content');
            if (text) {
              this.backgroundEmitter.emit('assistant-text', { text });
            }
            break;
          }
          case 'tool.execution_start': {
            const toolName = pickString(data, 'toolName');
            if (!toolName) break;
            const preview = summariseToolArgs(data['arguments']);
            this.backgroundEmitter.emit('assistant-text', {
              text: preview
                ? `↪ Calling ${toolName}: ${preview}`
                : `↪ Calling ${toolName}`,
            });
            break;
          }
          case 'session.warning':
          case 'session.error': {
            const msg =
              pickString(data, 'message') ?? pickString(data, 'error');
            if (msg) {
              this.backgroundEmitter.emit('error', {
                message: `Copilot session: ${msg}`,
              });
            }
            break;
          }
          default:
            break;
        }
      }
    } catch {
      /* try again next tick */
    } finally {
      this.bgTickInFlight = false;
    }
  }
}
