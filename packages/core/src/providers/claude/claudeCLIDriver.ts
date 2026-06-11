/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Interactive-mode Claude CLI driver.
 *
 * Why this exists: starting 2026-06-15, Anthropic bills `claude -p` (and any
 * invocation that sets `CLAUDE_CODE_ENTRYPOINT=sdk-cli`) against a separate
 * Agent SDK credit cap ($20-$200/mo depending on plan). Interactive Claude
 * Code in a real TTY continues to use subscription limits as before.
 *
 * Detection (per anthropics/claude-code#59105): startup computes one boolean
 * from `-p` || `--init-only` || `--sdk-url` || `!process.stdout.isTTY`.
 * If any is true → `sdk-cli` → SDK billing. All false → `cli` → interactive
 * billing. We therefore spawn `claude` via a real PTY (process.stdout.isTTY
 * inside Claude is true) without any of the three flags.
 *
 * Architecture (mirrors smithersai/claude-p, adapted for Node + cross-platform):
 *   1. Write a tiny Node-based hook relay script to tmpdir.
 *   2. Build `--settings '{"hooks":...}'` JSON pointing at the relay.
 *   3. Spawn `claude` interactively inside a PTY (lydell-node-pty, ConPTY on
 *      Windows, openpty elsewhere) — NO `-p` flag.
 *   4. Drain PTY output (don't parse — the TUI is Ink/React; output is for
 *      humans). Watch for the workspace-trust dialog and dismiss it.
 *   5. SessionStart hook fires once Ink is ready → type prompt + Enter.
 *   6. Stop hook fires when the turn finishes → payload carries
 *      `transcript_path` and `session_id`.
 *   7. Read the canonical session JSONL transcript; emit ProviderEvents
 *      from messages appended during this turn.
 *   8. Terminate the PTY. Next turn spawns fresh with `--resume <session-id>`.
 *
 * The legacy `-p`-mode driver is preserved at `claudeCLIDriver.print.ts` as
 * `ClaudeCLIDriverPrint` for historical reference / rescue fallback.
 */

import {
  writeFileSync,
  unlinkSync,
  mkdirSync,
  existsSync,
  promises as fsp,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import stripAnsi from 'strip-ansi';
import { getPty } from '../../utils/getPty.js';
import { resolveExecutable } from '../../utils/shell-utils.js';
import type {
  ProviderDriver,
  ProviderEvent,
  InteractivePromptResponse,
  InteractivePromptStartEvent,
  InteractivePromptQuestion,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import { ClaudeSessionManager } from './claudeSessionManager.js';
import type { ClaudeContentBlock, ClaudeDriverConfig } from './types.js';
import { PtyWriteQueue } from './interactivePromptSupport.js'; // AUDITARIA_CLAUDE_PROVIDER
import { claudePtyMirror } from './claudePtyMirror.js'; // AUDITARIA_CLAUDE_PROVIDER

// AUDITARIA_CLAUDE_PROVIDER: Debug logging — enable at runtime with
// AUDITARIA_PROVIDER_DEBUG=1. Writes to stdout with a [DEBUG] prefix so the UI
// surfaces them as informational LOG lines instead of red ERROR.
const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[DEBUG][CLI_DRIVER]', ...args); // eslint-disable-line no-console
}

// AUDITARIA_CLAUDE_PROVIDER: Default timeouts.
const SESSION_START_TIMEOUT_MS = 30_000; // Time for Ink to fully bootstrap.
const STOP_TIMEOUT_MS = 30 * 60_000; // 30 minutes — long-running tool calls.
const PROMPT_TYPE_DELAY_MS = 150; // Pause between prompt body and the Enter keystroke.
const SESSION_START_GRACE_MS = 1500; // Wait after SessionStart for Ink to accept keystrokes.
const HOOK_POLL_INTERVAL_MS = 50;
// AUDITARIA_CLAUDE_PROVIDER: bumped from 40×50ms (2s) to 100×100ms (10s).
// The shorter wait was missing assistant content for AskUserQuestion turns
// where Claude generates text AFTER the picker resolves but the transcript
// flush lags.
const TRANSCRIPT_FLUSH_RETRIES = 100;
const TRANSCRIPT_FLUSH_INTERVAL_MS = 100;
const TRUST_DIALOG_SCAN_INTERVAL_MS = 200;
const PTY_COLS = 200;
const PTY_ROWS = 50;

// Hook relay script: tiny CommonJS script. The Claude Code hook command runs
// `node <relay> <eventName>` per hook fire. Relay reads the JSON payload from
// stdin, appends a single JSON line to AUDITARIA_CLAUDE_HOOK_FILE. We embed
// it as a string constant so the driver is self-contained — no bundle assets
// or path resolution needed at runtime.
const HOOK_RELAY_SCRIPT = `'use strict';
const fs = require('node:fs');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { buf += d; });
process.stdin.on('end', () => {
  const event = process.argv[2];
  const file = process.env.AUDITARIA_CLAUDE_HOOK_FILE;
  if (!file) { process.exit(0); }
  let line;
  try {
    const payload = buf.trim() ? JSON.parse(buf) : {};
    line = JSON.stringify({event, payload}) + '\\n';
  } catch (err) {
    line = JSON.stringify({event, error: String(err), raw: buf}) + '\\n';
  }
  try { fs.appendFileSync(file, line); } catch (_) {}
});
`;

// Minimal subset of @lydell/node-pty's IPty surface we use.
interface MinimalPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  kill(signal?: string): void;
}

interface HookEvent {
  event:
    | 'SessionStart'
    | 'Stop'
    | 'PostCompact'
    | 'StopFailure'
    | 'PreToolUse'
    | 'PostToolUse'
    | 'UserPromptExpansion'
    | string;
  payload: Record<string, unknown>;
  error?: string;
}

// AUDITARIA_CLAUDE_PROVIDER: Result of processing the hook event stream for
// one turn. Drives what (if anything) the caller emits after the loop ends.
type TurnResult =
  | {
      kind: 'stopped';
      yieldedToolUseIds: Set<string>;
      stopPayload: HookEvent;
      transcriptPathFromHook?: string;
    }
  | {
      kind: 'compacted';
      yieldedToolUseIds: Set<string>;
      stopPayload: HookEvent;
      transcriptPathFromHook?: string;
    }
  | {
      kind: 'failed';
      message: string;
      yieldedToolUseIds: Set<string>;
    }
  | { kind: 'aborted'; yieldedToolUseIds: Set<string> }
  | { kind: 'timeout'; yieldedToolUseIds: Set<string> };

// AUDITARIA_CLAUDE_PROVIDER: Encode an absolute path the same way Claude Code
// does for `~/.claude/projects/<encoded>/<session>.jsonl`. Replace drive-colon
// and path separators with `-`. Mirrors observed on-disk behavior:
//   C:\projects\auditaria → C--projects-auditaria
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[:\\/]/g, '-');
}

function shellQuote(s: string): string {
  // Use double quotes; escape any embedded double quotes.
  return `"${s.replace(/"/g, '\\"')}"`;
}

export class ClaudeCLIDriver implements ProviderDriver {
  private sessionManager = new ClaudeSessionManager();
  private activePty: MinimalPty | null = null;
  private mcpConfigPath: string | null = null;
  private hookRelayPath: string | null = null;
  private hookFilePath: string | null = null;
  private currentPromptFilePath: string | null = null; // AUDITARIA_AGENT_SESSION
  private transcriptLineOffset = 0; // bytes already consumed across turns
  // AUDITARIA_CLAUDE_PROVIDER: Phase-1 interactive-prompt state.
  // Maps promptId (= Claude's tool_use_id) → questions structure so
  // respondToPrompt() can map an answer back to the right keystroke.
  // MVP: single-question AskUserQuestion only. Multi-question support
  // (Phase 1B) will use the HTTP hook channel for deny+inject.
  private pendingPrompts = new Map<string, InteractivePromptQuestion[]>();
  // Timestamps for when each prompt was surfaced — used to gate respondToPrompt
  // so we don't fire keystrokes before Claude's picker has rendered.
  private promptEmittedAt = new Map<string, number>();
  private writeQueue: PtyWriteQueue | null = null;
  // AUDITARIA_CLAUDE_PROVIDER: Rolling PTY output buffer used by the
  // PTY-scrape fallback when transcript writing is broken (Claude 2.1.169
  // regression). Reset at the start of each turn.
  private recentPtyOutput = '';

  // AUDITARIA_CLAUDE_PROVIDER_START: Persistent-PTY state. The Claude
  // sub-process is spawned ONCE on first sendMessage and survives across
  // turns until dispose(). The web terminal can talk to the live PTY at
  // any time, including between turns; chat-initiated turns type into
  // Claude's already-open input box rather than re-spawning.
  private ptyExited = false;
  private ptyExitCode = 0;
  /**
   * Byte offset into the hook-events JSONL file. Snapshotted at the start
   * of every sendMessage so processTurnEvents only sees events from this
   * turn (the file appends across turns now that the PTY persists).
   */
  private hookFileByteOffset = 0;
  /** True once SessionStart has fired on the current PTY. */
  private sessionStarted = false;
  /** Resolved `claude` binary path, cached across turns. */
  private claudeExePath: string | null = null;
  /** First-call systemContext is locked in; later changes log a warn. */
  private lastSystemContext: string | undefined = undefined;

  // AUDITARIA_CLAUDE_PROVIDER: Background hook-watcher state. When the
  // user types in the web terminal between Auditaria-initiated turns,
  // Claude still processes — hooks fire, the transcript appends. Without
  // a background drain, those events accumulate on disk and get skipped
  // by the next sendMessage's offset snapshot, and Auditaria's chat UI
  // never learns the conversation happened.
  //
  // The watcher polls the hook file ~6× per second. On every Stop event
  // observed OUTSIDE a sendMessage, it reads the transcript delta and
  // emits user/assistant messages through `backgroundEmitter`, which
  // providerManager forwards to AppContainer.
  //
  // Paused while sendMessage is running so processTurnEvents doesn't
  // race against us for the same hook bytes.
  private backgroundEmitter = new EventEmitter();
  private backgroundWatcherTimer: NodeJS.Timeout | null = null;
  private backgroundWatcherPaused = false;
  private backgroundWatcherTickInFlight = false;
  // AUDITARIA_CLAUDE_PROVIDER_END

  constructor(private readonly config: ClaudeDriverConfig) {
    dbg('constructor', {
      model: config.model,
      cwd: config.cwd,
      mcpServerCount: config.mcpServers
        ? Object.keys(config.mcpServers).length
        : 0,
    });
  }

  readonly canResume = true;

  getSessionId(): string | undefined {
    return this.sessionManager.getSessionId();
  }

  setSessionId(id: string): void {
    this.sessionManager.setSessionId(id);
  }

  resetSession(): void {
    this.sessionManager.clearSession();
    this.transcriptLineOffset = 0;
  }

  // AUDITARIA_CLAUDE_PROVIDER_START: Background event subscription. UI
  // subscribes via providerManager; we expose typed on/off methods so
  // providerManager doesn't need access to our EventEmitter directly.

  /** Fires when the user typed a message in the web terminal that wasn't
   *  initiated via sendMessage. Provides the message text parsed from the
   *  transcript's `user` line. */
  onBackgroundUserMessage(
    handler: (data: { text: string }) => void,
  ): () => void {
    this.backgroundEmitter.on('user-message', handler);
    return () => this.backgroundEmitter.off('user-message', handler);
  }

  /** Fires for each `text` block in an assistant message produced during
   *  a turn not initiated via sendMessage. May fire multiple times per
   *  turn (one per text block). */
  onBackgroundAssistantText(
    handler: (data: { text: string }) => void,
  ): () => void {
    this.backgroundEmitter.on('assistant-text', handler);
    return () => this.backgroundEmitter.off('assistant-text', handler);
  }

  // ─── Internal watcher control ─────────────────────────────────────────

  private startBackgroundWatcher(): void {
    if (this.backgroundWatcherTimer) return;
    this.backgroundWatcherTimer = setInterval(() => {
      void this.backgroundWatcherTick();
    }, 150);
  }

  private stopBackgroundWatcher(): void {
    if (this.backgroundWatcherTimer) {
      clearInterval(this.backgroundWatcherTimer);
      this.backgroundWatcherTimer = null;
    }
  }

  private async backgroundWatcherTick(): Promise<void> {
    if (this.backgroundWatcherPaused) return;
    if (!this.activePty || this.ptyExited) return;
    if (this.backgroundWatcherTickInFlight) return;
    this.backgroundWatcherTickInFlight = true;
    try {
      const batch = await this.readNewHookEvents(this.hookFileByteOffset);
      if (batch.consumedBytes === this.hookFileByteOffset) return;
      this.hookFileByteOffset = batch.consumedBytes;

      // A Stop event in the background stream means a user-initiated
      // turn just completed. Read the transcript delta and emit the
      // user/assistant messages so the chat catches up.
      let sawStop = false;
      for (const ev of batch.events) {
        if (ev.event === 'Stop' || ev.event === 'PostCompact') {
          sawStop = true;
        }
      }
      if (sawStop) {
        await this.flushBackgroundTranscript();
      }
    } catch {
      /* swallow — try again next tick */
    } finally {
      this.backgroundWatcherTickInFlight = false;
    }
  }

  private async flushBackgroundTranscript(): Promise<void> {
    const path = this.computeTranscriptPath();
    if (!path) return;
    let content: string;
    try {
      content = await fsp.readFile(path, 'utf-8');
    } catch {
      return;
    }
    if (content.length <= this.transcriptLineOffset) return;
    const newText = content.slice(this.transcriptLineOffset);
    this.transcriptLineOffset = content.length;

    for (const line of newText.split('\n')) {
      if (!line.trim()) continue;
      let entry: TranscriptEntry;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        entry = JSON.parse(line) as TranscriptEntry;
      } catch {
        continue;
      }

      // Skip compaction summary markers — those aren't real user input.
      if (
        entry.type === 'user' &&
        entry.message &&
        entry['isCompactSummary'] !== true
      ) {
        const text = extractUserTextFromTranscriptEntry(entry);
        if (text) {
          this.backgroundEmitter.emit('user-message', { text });
        }
      } else if (entry.type === 'assistant' && entry.message) {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          for (const block of content as ClaudeContentBlock[]) {
            if (block.type === 'text' && block.text) {
              this.backgroundEmitter.emit('assistant-text', {
                text: block.text,
              });
            }
            // tool_use / tool_result blocks intentionally NOT emitted —
            // chat UI doesn't need to replay tool calls from the web
            // terminal; user sees them in the live xterm.
          }
        }
      }
    }
  }
  // AUDITARIA_CLAUDE_PROVIDER_END

  async interrupt(): Promise<void> {
    this.killPty();
  }

  dispose(): void {
    // AUDITARIA_CLAUDE_PROVIDER: stop the background hook-watcher first
    // so its in-flight tick can't read into a half-disposed driver.
    this.stopBackgroundWatcher();
    this.backgroundEmitter.removeAllListeners();
    this.killPty();
    this.cleanupMcpConfig();
    this.cleanupHookFiles();
    if (this.currentPromptFilePath) {
      try {
        unlinkSync(this.currentPromptFilePath);
      } catch {
        /* ignore */
      }
      this.currentPromptFilePath = null;
    }
    // AUDITARIA_CLAUDE_PROVIDER: drop any pending interactive prompts (the UI
    // modal stays open otherwise). Drivers don't have an emit channel from
    // dispose() so we silently discard; the UI will see the next session
    // start fresh.
    this.pendingPrompts.clear();
    this.writeQueue = null;
  }

  // AUDITARIA_CLAUDE_PROVIDER_START: Persistent-PTY spawn helper.
  //
  // Returns null when a healthy PTY is ready for the next turn. Returns
  // an error message string when the spawn failed and the caller should
  // surface it as a ProviderEvent.Error.
  //
  // On first call: spawns Claude in a PTY, wires the data/exit handlers,
  // waits for SessionStart (handling the trust dialog inline), captures
  // the session id.
  //
  // On subsequent calls: returns null immediately if the existing PTY is
  // still alive. If it died (Claude crashed or was killed), tears down
  // the corpse and respawns fresh — same behaviour as the original
  // per-turn driver from the caller's perspective.
  private async ensurePtySpawned(
    signal: AbortSignal,
  ): Promise<string | null> {
    if (this.activePty && !this.ptyExited) return null;
    if (this.activePty && this.ptyExited) {
      // Previous PTY died — clean up before respawning.
      this.activePty = null;
      this.writeQueue = null;
      this.sessionStarted = false;
      this.hookFileByteOffset = 0;
    }

    const ptyInfo = await getPty();
    if (!ptyInfo) {
      return (
        'node-pty is not available. The interactive Claude driver requires ' +
        'a PTY backend (@lydell/node-pty or node-pty). On Windows ARM64 ' +
        'install via WSL2 or use the x64 Node build.'
      );
    }

    this.ensureHookInfra();

    // Reset hook file only on the FIRST spawn this session. For respawns
    // after a PTY crash we also reset so we don't carry old events.
    try {
      writeFileSync(this.hookFilePath!, '');
      this.hookFileByteOffset = 0;
    } catch (e) {
      return `Failed to reset hook event file: ${String(e)}`;
    }

    const settingsJson = this.buildSettingsJson();
    const args = this.buildArgs(settingsJson, this.lastSystemContext);

    if (!this.claudeExePath) {
      const resolved = await resolveClaudeExecutable();
      this.claudeExePath = resolved ?? null;
    }
    const claudeExe = this.claudeExePath;
    if (!claudeExe) {
      return 'Could not locate the `claude` executable on PATH. Install Claude Code: npm install -g @anthropic-ai/claude-code';
    }

    let pty: MinimalPty;
    try {
      pty = ptyInfo.module.spawn(claudeExe, args, {
        name: 'xterm-256color',
        cols: PTY_COLS,
        rows: PTY_ROWS,
        cwd: this.config.cwd,
        env: {
          ...process.env,
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
          CLAUDE_CODE_ENTRYPOINT: 'cli',
          AUDITARIA_CLAUDE_HOOK_FILE: this.hookFilePath!,
        },
        handleFlowControl: true,
      }) as MinimalPty;
    } catch (e) {
      return `Failed to spawn claude in PTY: ${String(e)}. Ensure 'claude' is on PATH.`;
    }
    this.activePty = pty;
    this.ptyExited = false;
    this.ptyExitCode = 0;
    this.recentPtyOutput = '';
    dbg('spawned (persistent)', { pid: pty.pid });

    this.writeQueue = new PtyWriteQueue((bytes) => pty.write(bytes));

    const RECENT_MAX = 128 * 1024;
    pty.onData((data) => {
      this.recentPtyOutput += data;
      if (this.recentPtyOutput.length > RECENT_MAX) {
        this.recentPtyOutput = this.recentPtyOutput.slice(
          this.recentPtyOutput.length - RECENT_MAX,
        );
      }
      claudePtyMirror.emitData(data);
      if (DEBUG) {
        const stripped = stripAnsi(data).replace(/\r?\n/g, '\\n');
        dbg('pty raw:', stripped.slice(0, 200));
      }
    });

    claudePtyMirror.setActive(this);

    pty.onExit((e) => {
      this.ptyExited = true;
      this.ptyExitCode = e.exitCode ?? 0;
      dbg('pty exit', e);
      claudePtyMirror.setInactive(this);
    });

    // First-call: wait for SessionStart hook (handles trust dialog inline).
    const sessionStartEv = await this.waitForSessionStart(
      pty,
      () => this.recentPtyOutput,
      () => this.ptyExited,
      signal,
    );
    if (!sessionStartEv) {
      if (this.ptyExited) {
        return `claude exited before SessionStart (code ${this.ptyExitCode}). Check that the CLI is installed and authenticated.`;
      }
      if (signal.aborted) return 'Aborted before SessionStart';
      return 'Timed out waiting for SessionStart hook from claude.';
    }

    const sessIdFromHook = pickString(sessionStartEv.payload, 'session_id');
    if (sessIdFromHook) {
      this.sessionManager.setSessionId(sessIdFromHook);
      dbg('captured session_id from SessionStart', sessIdFromHook);
    }
    this.sessionStarted = true;

    // Skip past SessionStart in the hook file so future readNewHookEvents
    // calls don't replay it.
    try {
      const stat = await fsp.stat(this.hookFilePath!);
      this.hookFileByteOffset = stat.size;
    } catch {
      /* file may not exist yet, leave offset at 0 */
    }

    // Brief delay so Ink finishes wiring its raw-mode key handler.
    await delay(SESSION_START_GRACE_MS);

    // Start the background hook-watcher now that the PTY is alive and
    // SessionStart has been consumed. It pauses automatically while
    // sendMessage is running.
    this.startBackgroundWatcher();
    return null;
  }
  // AUDITARIA_CLAUDE_PROVIDER_END

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
    attachmentFiles?: Array<import('../types.js').AttachmentFile>,
  ): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) return;

    if (attachmentFiles?.length) {
      // AUDITARIA_CLAUDE_PROVIDER: Image attachments are unsupported in
      // interactive mode for now. The previous print-mode driver fed images
      // via `--input-format stream-json` NDJSON — not available when we drive
      // the TUI by typing. Surface a clear message rather than silently drop.
      yield {
        type: ProviderEventType.Error,
        message:
          'Image attachments are not yet supported with the interactive ' +
          'Claude driver. Drop the image, or temporarily switch providers.',
      };
      return;
    }

    // AUDITARIA_CLAUDE_PROVIDER: Persistent-PTY refactor. systemContext is
    // baked into spawn args on the FIRST sendMessage; subsequent calls
    // can't change it without respawning. Log a warning if it ever
    // changes mid-session and accept the limitation for now.
    if (
      this.lastSystemContext !== undefined &&
      systemContext !== undefined &&
      this.lastSystemContext !== systemContext
    ) {
      dbg(
        'WARN: systemContext changed mid-session; not respawning, baked-in copy is stale',
      );
    }
    if (this.lastSystemContext === undefined && systemContext !== undefined) {
      this.lastSystemContext = systemContext;
    }

    const spawnError = await this.ensurePtySpawned(signal);
    if (spawnError) {
      yield { type: ProviderEventType.Error, message: spawnError };
      return;
    }
    const pty = this.activePty!;

    // AUDITARIA_CLAUDE_PROVIDER: Pause the background watcher for the
    // duration of this turn so it doesn't race processTurnEvents for
    // the same hook bytes. Resumed in the finally.
    this.backgroundWatcherPaused = true;

    // AUDITARIA_CLAUDE_PROVIDER_START: Persistent-PTY per-turn flow.
    // The PTY is already alive and at the input box (Claude finished its
    // last turn and returned to idle). We snapshot the hook-file offset
    // and transcript size, type the prompt, drain hook events, run the
    // final transcript scan, and DO NOT kill the PTY in finally — it
    // survives for the next sendMessage call.

    // Snapshot transcript byte size so yieldEventsFromTranscript only
    // reports content from THIS turn.
    const transcriptPathPredicted = this.computeTranscriptPath();
    if (transcriptPathPredicted && existsSync(transcriptPathPredicted)) {
      try {
        const stat = await fsp.stat(transcriptPathPredicted);
        this.transcriptLineOffset = stat.size;
        dbg('pre-turn transcript size', this.transcriptLineOffset);
      } catch {
        this.transcriptLineOffset = 0;
      }
    } else {
      this.transcriptLineOffset = 0;
    }

    // Snapshot hook-file offset for the same reason (the file appends
    // across turns now that the PTY persists).
    try {
      const stat = await fsp.stat(this.hookFilePath!);
      this.hookFileByteOffset = stat.size;
      dbg('pre-turn hook offset', this.hookFileByteOffset);
    } catch {
      /* leave the existing offset */
    }

    if (signal.aborted) return;

    // Slash command detection. Stop never fires for TUI-level slash
    // commands; /compact uses PostCompact instead; others currently hit
    // the Stop timeout (known limitation).
    const trimmed = prompt.trimStart();
    const isSlashCommand = trimmed.startsWith('/');
    const slashCommandName = isSlashCommand
      ? trimmed.slice(1).split(/[\s/]/)[0]?.toLowerCase()
      : undefined;
    dbg('slash command?', { isSlashCommand, name: slashCommandName });

    this.typePromptIntoPty(pty, prompt);

    // Abort handler. Persistent PTY: send Ctrl+C to abort the CURRENT
    // turn (Claude will catch SIGINT and return to input) rather than
    // killing the whole PTY and losing the session.
    const abortHandler = () => {
      dbg('abort handler triggered — sending Ctrl+C (persistent PTY)');
      try {
        this.activePty?.write('\x03');
      } catch {
        /* PTY already dead — onExit will tell the mirror */
      }
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    try {
      // Drain hook events for this turn.
      const turnResult = yield* this.processTurnEvents({
        signal,
        isExited: () => this.ptyExited,
        getExitCode: () => this.ptyExitCode,
        slashCommandName,
      });

      // Terminal event reached — run the final transcript scan to emit
      // text/thinking content (those don't have hook signals).
      if (turnResult.kind === 'stopped' || turnResult.kind === 'compacted') {
        const transcriptPath =
          turnResult.transcriptPathFromHook ?? transcriptPathPredicted;
        if (transcriptPath) {
          yield* this.yieldEventsFromTranscript(
            transcriptPath,
            turnResult.stopPayload,
            turnResult.yieldedToolUseIds,
            turnResult.kind === 'compacted',
          );
        } else if (turnResult.kind === 'stopped') {
          yield {
            type: ProviderEventType.Error,
            message:
              'Stop hook fired without transcript_path and we could not compute one.',
          };
        }
      } else if (turnResult.kind === 'failed') {
        yield {
          type: ProviderEventType.Error,
          message: turnResult.message,
        };
      } else if (turnResult.kind === 'timeout' && !signal.aborted) {
        if (this.ptyExited) {
          yield {
            type: ProviderEventType.Error,
            message: `claude exited before Stop/PostCompact (code ${this.ptyExitCode}).`,
          };
        } else {
          yield {
            type: ProviderEventType.Error,
            message: isSlashCommand
              ? `Timed out waiting for completion of slash command "/${slashCommandName ?? ''}". Slash commands other than /compact are not yet fully supported.`
              : 'Timed out waiting for Stop hook from claude.',
          };
        }
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
      // NOTE: do NOT killPty here — the persistent PTY survives across
      // turns. Cleanup happens in dispose().
      this.backgroundWatcherPaused = false;
    }
    // AUDITARIA_CLAUDE_PROVIDER_END
  }

  // ─── private helpers ──────────────────────────────────────────────────────

  private buildArgs(settingsJson: string, systemContext?: string): string[] {
    // No -p! No --input-format / --output-format stream-json — those imply
    // SDK billing (and stream-json isn't honored in interactive mode anyway).
    const args: string[] = ['--settings', settingsJson];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    const sessionId = this.sessionManager.getSessionId();
    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (
      this.config.permissionMode &&
      this.config.permissionMode !== 'default'
    ) {
      args.push('--permission-mode', this.config.permissionMode);
    }

    // AUDITARIA_TOOL_RESTRICTION
    if (this.config.disallowedTools?.length) {
      args.push('--disallowedTools', this.config.disallowedTools.join(','));
    }

    // AUDITARIA_CLAUDE_PROVIDER: MCP server passthrough
    const mcpPath = this.getOrWriteMcpConfig();
    if (mcpPath) {
      args.push('--mcp-config', mcpPath);
    }

    // AUDITARIA_CLAUDE_PROVIDER: System context via file. The
    // --append-system-prompt-file flag is honored in interactive mode and
    // does NOT persist across --resume, so we pass it every call.
    if (systemContext) {
      const filePath = this.writeSystemPromptFile(systemContext);
      args.push('--append-system-prompt-file', filePath);
    }

    return args;
  }

  private buildSettingsJson(): string {
    if (!this.hookRelayPath) {
      throw new Error('hook relay not initialized');
    }
    const command = `${shellQuote(process.execPath)} ${shellQuote(this.hookRelayPath)}`;
    const hookEntry = (event: string) => ({
      matcher: '*',
      hooks: [
        {
          type: 'command',
          command: `${command} ${event}`,
        },
      ],
    });
    // AUDITARIA_CLAUDE_PROVIDER_START: Phase 2 hooks
    //   SessionStart       — Ink is ready; we can start typing the prompt.
    //   Stop               — assistant turn finished; collect transcript text.
    //   PostCompact        — /compact slash command completion (Stop never fires
    //                        for slash commands). Also fires on auto-compact.
    //   StopFailure        — API error (rate_limit, auth, billing, etc.) —
    //                        surface immediately instead of waiting for Stop.
    //   PreToolUse         — tool starting; yield ToolUse live to the UI.
    //   PostToolUse        — tool result; yield ToolResult live to the UI.
    //   UserPromptExpansion — slash command intercept; observe which one.
    //   Notification       — surfaced by Claude for permission_prompt,
    //                        idle_prompt, auth_success, elicitation_dialog/
    //                        complete/response. Observability for now;
    //                        Phase 1 of the interactive-prompt UX will use
    //                        this as the detection signal.
    return JSON.stringify({
      hooks: {
        SessionStart: [hookEntry('SessionStart')],
        Stop: [hookEntry('Stop')],
        PostCompact: [hookEntry('PostCompact')],
        StopFailure: [hookEntry('StopFailure')],
        PreToolUse: [hookEntry('PreToolUse')],
        PostToolUse: [hookEntry('PostToolUse')],
        UserPromptExpansion: [hookEntry('UserPromptExpansion')],
        Notification: [hookEntry('Notification')],
      },
    });
    // AUDITARIA_CLAUDE_PROVIDER_END
  }

  private ensureHookInfra(): void {
    if (this.hookRelayPath && this.hookFilePath) return;
    const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const relay = join(tmpdir(), `auditaria-claude-hook-relay-${stamp}.cjs`);
    const evFile = join(
      tmpdir(),
      `auditaria-claude-hook-events-${stamp}.jsonl`,
    );
    writeFileSync(relay, HOOK_RELAY_SCRIPT, 'utf-8');
    writeFileSync(evFile, '');
    this.hookRelayPath = relay;
    this.hookFilePath = evFile;
    dbg('hook infra', { relay, evFile });
  }

  private cleanupHookFiles(): void {
    for (const p of [this.hookRelayPath, this.hookFilePath]) {
      if (!p) continue;
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
    this.hookRelayPath = null;
    this.hookFilePath = null;
  }

  // Reused (verbatim) from the legacy driver — same config-file output format.
  private getOrWriteMcpConfig(): string | null {
    if (this.mcpConfigPath) return this.mcpConfigPath;

    const claudeMcpServers: Record<string, Record<string, unknown>> = {};
    const servers = this.config.mcpServers;
    for (const [name, server] of Object.entries(servers || {})) {
      if (server.command) {
        claudeMcpServers[name] = {
          type: 'stdio',
          command: server.command,
          args: server.args || [],
          ...(server.env && { env: server.env }),
          ...(server.cwd && { cwd: server.cwd }),
        };
      } else if (server.url || server.httpUrl) {
        const url = server.url || server.httpUrl;
        const transportType = server.type || (server.httpUrl ? 'http' : 'sse');
        claudeMcpServers[name] = {
          type: transportType,
          url,
          ...(server.headers && { headers: server.headers }),
        };
      }
    }

    if (this.config.toolBridgePort && this.config.toolBridgeScript) {
      const bridgeArgs = [
        this.config.toolBridgeScript,
        '--port',
        String(this.config.toolBridgePort),
      ];
      for (const name of this.config.toolBridgeExclude ?? []) {
        bridgeArgs.push('--exclude', name);
      }
      claudeMcpServers['auditaria-tools'] = {
        type: 'stdio',
        command: process.execPath,
        args: bridgeArgs,
      };
    }

    if (Object.keys(claudeMcpServers).length === 0) return null;

    const configObj = { mcpServers: claudeMcpServers };
    this.mcpConfigPath = join(
      tmpdir(),
      `auditaria-mcp-${process.pid}-${Date.now()}.json`,
    );
    writeFileSync(this.mcpConfigPath, JSON.stringify(configObj, null, 2));
    return this.mcpConfigPath;
  }

  private cleanupMcpConfig(): void {
    if (this.mcpConfigPath) {
      try {
        unlinkSync(this.mcpConfigPath);
      } catch {
        /* ignore */
      }
      this.mcpConfigPath = null;
    }
  }

  private writeSystemPromptFile(content: string): string {
    if (!this.config.promptFileId) {
      const dir = join(this.config.cwd, '.auditaria');
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, '.system-prompt');
      writeFileSync(filePath, content, 'utf-8');
      return filePath;
    }
    const dir = join(this.config.cwd, '.auditaria', 'prompts');
    mkdirSync(dir, { recursive: true });
    const realId = this.sessionManager.getSessionId();
    const filename = `${realId ?? this.config.promptFileId}.prompt`;
    const filePath = join(dir, filename);
    if (
      realId &&
      this.currentPromptFilePath &&
      this.currentPromptFilePath !== filePath
    ) {
      try {
        unlinkSync(this.currentPromptFilePath);
      } catch {
        /* ignore */
      }
    }
    writeFileSync(filePath, content, 'utf-8');
    this.currentPromptFilePath = filePath;
    return filePath;
  }

  private killPty(): void {
    if (!this.activePty) return;
    try {
      this.activePty.kill();
    } catch {
      /* ignore */
    }
    // AUDITARIA_CLAUDE_PROVIDER: Ensure the mirror sees the death even if
    // onExit doesn't fire promptly (kill path races onExit on Windows).
    claudePtyMirror.setInactive(this);
  }

  private typePromptIntoPty(pty: MinimalPty, prompt: string): void {
    // Strategy mirrors smithersai/claude-p: write the body, brief gap, then
    // CR as a separate event. Ink's bracketed-paste / burst-input heuristics
    // can otherwise drop the CR into the input buffer instead of submitting.
    //
    // AUDITARIA_CLAUDE_PROVIDER: All writes through PtyWriteQueue with the
    // gate up so a web-typist's keystrokes can't slip between body and CR.
    void this.writeQueue?.withAtomicBlock(async () => {
      await this.writeQueue?.writeAtomic(prompt, 'system');
      await new Promise<void>((r) => setTimeout(r, PROMPT_TYPE_DELAY_MS));
      await this.writeQueue?.writeAtomic('\r', 'system');
    });
  }

  // AUDITARIA_CLAUDE_PROVIDER: Public PTY input entry-point used by the
  // claudePtyMirror to forward web-terminal keystrokes. Uses the
  // 'web-typist' queue priority so it never preempts a typePromptIntoPty
  // burst or a system-level response keystroke.
  async writeRawInput(bytes: string): Promise<void> {
    if (!bytes) return;
    await this.writeQueue?.writeAtomic(bytes, 'web-typist');
  }

  // AUDITARIA_CLAUDE_PROVIDER: Public PTY resize entry-point. Web viewer
  // calls this whenever xterm.js' FitAddon reports new geometry so
  // Claude redraws to fit, eliminating the misaligned-lines problem
  // when the xterm panel is smaller (or larger) than the pinned 200×50
  // we used to start with.
  resize(cols: number, rows: number): void {
    if (!this.activePty) return;
    try {
      this.activePty.resize(cols, rows);
    } catch {
      /* PTY died — onExit will tell the mirror */
    }
  }

  // AUDITARIA_CLAUDE_PROVIDER: Phase-1 interactive-prompt response entry point.
  // Called by providerManager.respondToPrompt() once the UI has the answer.
  // For AskUserQuestion single-question: write the option-index keystroke
  // ("N\r") to the live PTY picker. For multi-question (Phase-1B), we'll
  // fall back to the HTTP hook channel and deny+inject; for now just
  // resolve the pending promise so the surfaced ProviderEvent loop can
  // continue.
  async respondToPrompt(
    promptId: string,
    response: InteractivePromptResponse,
  ): Promise<void> {
    const questions = this.pendingPrompts.get(promptId);
    if (!questions) {
      dbg('respondToPrompt: no pending prompt for id', promptId);
      return;
    }
    // NOTE: do NOT delete from pendingPrompts here — PostToolUse handler
    // uses this map to detect "we surfaced this one" and emits
    // InteractivePromptResolved on cleanup. Deleting here would suppress
    // the Resolved event the UI uses to dismiss the modal.

    if (response.kind !== 'answered') {
      // User cancelled. We can't easily cancel Claude's picker from outside;
      // best we can do is send Escape and hope. Esc is 0x1b.
      dbg('respondToPrompt: user cancelled — sending ESC');
      await this.writeQueue?.writeAtomic('\x1b', 'system');
      return;
    }

    // AUDITARIA_CLAUDE_PROVIDER: Wait until the picker is rendered. PreToolUse
    // fires when Claude DECIDES to call the tool, before the TUI shows the
    // picker. Number-digit input goes into the prompt input box if the
    // picker isn't focused yet. Use arrow keys (Down + Enter) — these are
    // interpreted as picker navigation regardless of focus race.
    const PICKER_READY_DELAY_MS = 2500;
    const ARROW_DELAY_MS = 80;
    const SELECT_SETTLE_MS = 200;
    const TAB_DELAY_MS = 300;
    const DOWN = '\x1b[B';
    const ENTER = '\r';

    const emittedAt = this.promptEmittedAt.get(promptId) ?? Date.now();
    this.promptEmittedAt.delete(promptId);
    const waitMore = Math.max(
      0,
      PICKER_READY_DELAY_MS - (Date.now() - emittedAt),
    );
    if (waitMore > 0) {
      dbg('respondToPrompt: waiting', waitMore, 'ms for picker to render');
      await new Promise<void>((r) => setTimeout(r, waitMore));
    }

    // Multi-question picker has a top tab-bar [Q1] [Q2] ... [Submit].
    // For Q-by-Q: navigate Down to chosen option, Enter to mark, Tab to
    // next question's tab. After last answer: Tab to Submit, Enter.
    // Single-question picker has no tab-bar: Enter on the focused option
    // submits the picker directly.
    const isMulti = questions.length > 1;
    dbg(
      'respondToPrompt:',
      isMulti ? 'multi-question' : 'single-question',
      'driving picker',
    );

    const press = async (bytes: string, delayMs: number): Promise<void> => {
      await this.writeQueue?.writeAtomic(bytes, 'system');
      if (delayMs > 0) {
        await new Promise<void>((r) => setTimeout(r, delayMs));
      }
    };

    // Picker behaviour observed empirically (Claude Code 2.1.170):
    //   - Down: move within current question's options
    //   - Enter on a focused option BOTH selects it AND auto-advances
    //     focus to the next question's first option — picker is a
    //     wizard, not a checkbox grid. After Enter on the final
    //     question's pick, focus auto-advances to the `Submit answers`
    //     button.
    //   - For single-question pickers, the lone Enter submits directly.
    //   - For multi-question, one trailing Enter on the auto-focused
    //     Submit button confirms.
    //   - Tab is NOT needed between questions — it would skip past
    //     Submit to Cancel.
    for (let qi = 0; qi < questions.length; qi++) {
      const question = questions[qi];
      const answer =
        response.answers.find((a) => a.questionId === question.id) ??
        response.answers[qi];
      if (!answer) {
        dbg('respondToPrompt: no answer for question index', qi);
        continue;
      }
      const optionIndex =
        answer.optionIds.length > 0
          ? question.options.findIndex((o) => o.id === answer.optionIds[0])
          : -1;
      // AUDITARIA_CLAUDE_PROVIDER: Custom-text path. Claude's picker auto-
      // appends a "Type something" row at index = model-options.length (so
      // for 3 model options it appears as row 4). Navigate there, press
      // Enter to switch the picker into text-input mode, type the user's
      // text, press Enter to submit / auto-advance.
      const wantsCustomText =
        optionIndex < 0 &&
        typeof answer.customText === 'string' &&
        answer.customText.length > 0;
      if (wantsCustomText) {
        const typeRowIndex = question.options.length;
        dbg(
          `respondToPrompt: Q${qi + 1}/${questions.length} → custom text (${answer.customText!.length} chars)`,
        );
        for (let i = 0; i < typeRowIndex; i++) {
          await press(DOWN, ARROW_DELAY_MS);
        }
        await new Promise<void>((r) => setTimeout(r, SELECT_SETTLE_MS));
        // Enter focuses the "Type something" row's input box.
        await press(ENTER, SELECT_SETTLE_MS);
        // Type the text as a single bulk write — Claude's input box
        // accepts pasted content fine.
        await press(answer.customText!, SELECT_SETTLE_MS);
        // Final Enter submits / auto-advances to the next question.
        await press(ENTER, isMulti ? TAB_DELAY_MS : 0);
        continue;
      }
      if (optionIndex < 0) {
        dbg(
          'respondToPrompt: option id not found in question and no customText',
          qi,
          answer.optionIds[0],
        );
        continue;
      }
      dbg(
        `respondToPrompt: Q${qi + 1}/${questions.length} → option ${optionIndex + 1}`,
      );
      for (let i = 0; i < optionIndex; i++) {
        await press(DOWN, ARROW_DELAY_MS);
      }
      await new Promise<void>((r) => setTimeout(r, SELECT_SETTLE_MS));
      // Enter selects + auto-advances. For multi we wait a beat between
      // questions so the picker re-renders before the next Down stream.
      await press(ENTER, isMulti ? TAB_DELAY_MS : 0);
    }

    // For multi-question, focus is now on the `Submit answers` button
    // (auto-advanced after the last option's Enter). One Enter submits.
    if (isMulti) {
      await press(ENTER, 0);
    }
  }

  // AUDITARIA_CLAUDE_PROVIDER: Translate Claude's AskUserQuestion tool_input
  // into our structured InteractivePromptStart event. Returns null if the
  // input doesn't look like an AskUserQuestion payload (defensive).
  private buildAskUserQuestionPromptEvent(
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
      const multiSelect = q['multiSelect'] === true;
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
        multiSelect,
      });
    }
    if (questions.length === 0) return null;

    this.pendingPrompts.set(toolUseId, questions);
    this.promptEmittedAt.set(toolUseId, Date.now());

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
      timeoutMs: 60 * 60_000, // 1 hour — user might take a long time
    };
  }

  private async waitForSessionStart(
    pty: MinimalPty,
    getRecent: () => string,
    isExited: () => boolean,
    signal: AbortSignal,
  ): Promise<HookEvent | null> {
    const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
    let trustDismissed = false;
    let lastTrustScan = 0;
    let consumed = 0; // bytes already read from the hook file
    while (Date.now() < deadline) {
      if (signal.aborted) return null;
      if (isExited()) return null;

      // Try to dismiss the workspace-trust dialog if it appeared. We don't
      // know that the dialog is showing — we scan the recent PTY output for
      // the words "trust" and "folder" (stripped of CSI codes since the
      // dialog pads them with cursor-move escapes).
      if (
        !trustDismissed &&
        Date.now() - lastTrustScan > TRUST_DIALOG_SCAN_INTERVAL_MS
      ) {
        lastTrustScan = Date.now();
        const stripped = stripAnsi(getRecent());
        if (
          stripped.toLowerCase().includes('trust') &&
          stripped.toLowerCase().includes('folder')
        ) {
          dbg('trust dialog detected, sending Enter');
          try {
            pty.write('\r');
          } catch {
            /* ignore */
          }
          trustDismissed = true;
        }
      }

      const events = await this.readNewHookEvents(consumed);
      consumed = events.consumedBytes;
      for (const ev of events.events) {
        if (ev.event === 'SessionStart') return ev;
      }

      await delay(HOOK_POLL_INTERVAL_MS);
    }
    return null;
  }

  // AUDITARIA_CLAUDE_PROVIDER: Phase 2 unified hook-driven event loop.
  // Yields ProviderEvents live as PreToolUse / PostToolUse hooks fire so the
  // UI sees tool calls in real time. Terminates on:
  //   - Stop          → normal assistant-turn end
  //   - PostCompact   → if the user typed /compact (Stop never fires for
  //                     slash commands); also surfaced as a Compacted event
  //                     mid-turn for auto-compaction
  //   - StopFailure   → API error, terminate with a useful error message
  //   - abort signal  → caller cancelled
  //   - PTY exit      → process died unexpectedly
  //   - timeout       → defensive ceiling
  private async *processTurnEvents(opts: {
    signal: AbortSignal;
    isExited: () => boolean;
    getExitCode: () => number;
    slashCommandName?: string;
  }): AsyncGenerator<ProviderEvent, TurnResult> {
    const { signal, isExited, slashCommandName } = opts;
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    const yieldedToolUseIds = new Set<string>();
    // AUDITARIA_CLAUDE_PROVIDER: start at the per-turn offset that
    // sendMessage snapshotted on the persistent hook file. We then
    // advance the class field as we drain so the NEXT sendMessage call
    // picks up where we left off.
    let consumed = this.hookFileByteOffset;

    const processEvent = (
      ev: HookEvent,
    ): { yields?: ProviderEvent[]; done?: TurnResult } | null => {
      switch (ev.event) {
        case 'PreToolUse': {
          const toolName = pickString(ev.payload, 'tool_name');
          const toolUseId = pickString(ev.payload, 'tool_use_id');
          const toolInput = ev.payload['tool_input'];
          if (!toolName || !toolUseId) return null;
          yieldedToolUseIds.add(toolUseId);
          const safeInput: Record<string, unknown> = isPlainObject(toolInput)
            ? toolInput
            : {};
          const yields: ProviderEvent[] = [
            {
              type: ProviderEventType.ToolUse,
              toolName,
              toolId: toolUseId,
              input: safeInput,
            },
          ];
          // AUDITARIA_CLAUDE_PROVIDER: AskUserQuestion → surface as a
          // first-class InteractivePromptStart so Auditaria's UI can show
          // the picker. The TUI's own picker is still rendering in the
          // PTY; respondToPrompt() writes the matching keystroke back.
          if (toolName === 'AskUserQuestion') {
            const promptEvent = this.buildAskUserQuestionPromptEvent(
              toolUseId,
              toolInput,
            );
            if (promptEvent) yields.push(promptEvent);
          }
          return { yields };
        }
        case 'PostToolUse': {
          const toolUseId = pickString(ev.payload, 'tool_use_id');
          if (!toolUseId) return null;
          const result = ev.payload['tool_result'];
          let output: string;
          if (typeof result === 'string') {
            output = result;
          } else if (result === undefined || result === null) {
            output = '';
          } else {
            try {
              output = JSON.stringify(result);
            } catch {
              output = String(result);
            }
          }
          const yields: ProviderEvent[] = [
            {
              type: ProviderEventType.ToolResult,
              toolId: toolUseId,
              output,
              isError: false,
            },
          ];
          // AUDITARIA_CLAUDE_PROVIDER: If this PostToolUse closes an
          // AskUserQuestion we surfaced, emit InteractivePromptResolved so
          // the UI dismisses the modal.
          if (this.pendingPrompts.has(toolUseId)) {
            this.pendingPrompts.delete(toolUseId);
            yields.push({
              type: ProviderEventType.InteractivePromptResolved,
              promptId: toolUseId,
              response: {
                kind: 'answered',
                // We don't reverse-engineer the answer from the picker
                // here; the UI already has its own copy from the
                // respondToPrompt call. This event just signals "done".
                answers: [],
              },
            });
          }
          return { yields };
        }
        case 'UserPromptExpansion': {
          dbg('UserPromptExpansion', {
            type: pickString(ev.payload, 'expansion_type'),
            name: pickString(ev.payload, 'command_name'),
          });
          return null;
        }
        case 'Notification': {
          // AUDITARIA_CLAUDE_PROVIDER: Observability only for now. Phase 1
          // of the interactive-prompt UX will lift this into a real
          // ProviderEvent (InteractivePrompt) and propagate to UI.
          // notification_type values: permission_prompt, idle_prompt,
          // auth_success, elicitation_dialog, elicitation_complete,
          // elicitation_response.
          dbg('Notification', {
            type: pickString(ev.payload, 'notification_type'),
            title: pickString(ev.payload, 'title'),
            message: pickString(ev.payload, 'message')?.slice(0, 120),
          });
          return null;
        }
        case 'PostCompact': {
          const trigger = pickString(ev.payload, 'trigger');
          dbg('PostCompact', { trigger, slashCommandName });
          const compactedEvent: ProviderEvent = {
            type: ProviderEventType.Compacted,
            preTokens: 0,
            trigger: trigger === 'auto' ? 'auto' : 'manual',
          };
          // /compact never fires Stop — PostCompact is the terminal signal.
          if (slashCommandName === 'compact') {
            return {
              yields: [compactedEvent],
              done: {
                kind: 'compacted',
                yieldedToolUseIds,
                stopPayload: ev,
                transcriptPathFromHook: pickString(
                  ev.payload,
                  'transcript_path',
                ),
              },
            };
          }
          // Mid-turn auto-compact: surface and keep listening for Stop.
          return { yields: [compactedEvent] };
        }
        case 'StopFailure': {
          const errorType = pickString(ev.payload, 'error_type') ?? 'unknown';
          dbg('StopFailure', { errorType });
          return {
            done: {
              kind: 'failed',
              message: `Claude API error: ${errorType}. The turn ended without a successful response.`,
              yieldedToolUseIds,
            },
          };
        }
        case 'Stop': {
          dbg('Stop hook received');
          return {
            done: {
              kind: 'stopped',
              yieldedToolUseIds,
              stopPayload: ev,
              transcriptPathFromHook: pickString(ev.payload, 'transcript_path'),
            },
          };
        }
        default:
          return null;
      }
    };

    while (Date.now() < deadline) {
      if (signal.aborted) {
        return { kind: 'aborted', yieldedToolUseIds };
      }

      const batch = await this.readNewHookEvents(consumed);
      consumed = batch.consumedBytes;
      for (const ev of batch.events) {
        const action = processEvent(ev);
        if (!action) continue;
        if (action.yields) for (const y of action.yields) yield y;
        if (action.done) return action.done;
      }

      if (isExited()) {
        // Drain any final events post-exit then surrender.
        await delay(50);
        const final = await this.readNewHookEvents(consumed);
        consumed = final.consumedBytes;
        for (const ev of final.events) {
          const action = processEvent(ev);
          if (!action) continue;
          if (action.yields) for (const y of action.yields) yield y;
          if (action.done) return action.done;
        }
        return { kind: 'timeout', yieldedToolUseIds };
      }

      await delay(HOOK_POLL_INTERVAL_MS);
    }
    return { kind: 'timeout', yieldedToolUseIds };
  }

  private async readNewHookEvents(
    fromByteOffset: number,
  ): Promise<{ events: HookEvent[]; consumedBytes: number }> {
    if (!this.hookFilePath)
      return { events: [], consumedBytes: fromByteOffset };
    let content: string;
    try {
      content = await fsp.readFile(this.hookFilePath, 'utf-8');
    } catch {
      return { events: [], consumedBytes: fromByteOffset };
    }
    if (content.length <= fromByteOffset) {
      return { events: [], consumedBytes: fromByteOffset };
    }
    const fresh = content.slice(fromByteOffset);
    // Only consume up to the last newline — anything after is a partial write.
    const lastNl = fresh.lastIndexOf('\n');
    if (lastNl < 0) return { events: [], consumedBytes: fromByteOffset };
    const complete = fresh.slice(0, lastNl);
    const newOffset = fromByteOffset + lastNl + 1;
    const events: HookEvent[] = [];
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isHookEvent(parsed)) events.push(parsed);
      } catch (e) {
        dbg('hook line parse error', e, line.slice(0, 200));
      }
    }
    return { events, consumedBytes: newOffset };
  }

  private computeTranscriptPath(): string | undefined {
    const sessionId = this.sessionManager.getSessionId();
    if (!sessionId) return undefined;
    const encoded = encodeProjectPath(this.config.cwd);
    return join(
      homedir(),
      '.claude',
      'projects',
      encoded,
      `${sessionId}.jsonl`,
    );
  }

  // AUDITARIA_CLAUDE_PROVIDER: PTY-scrape fallback for Claude 2.1.169+
  // transcript-writing regression.
  //
  // Recent Claude versions stopped writing the conversation lines to
  // `~/.claude/projects/<cwd>/<session>.jsonl` for our spawned PTY
  // sessions (the file gets created with only the `ai-title` metadata
  // line, no user/assistant content). Claude IS generating responses
  // — they're visible in the PTY — they're just not persisted.
  //
  // This scraper extracts Claude's last assistant text from the rolling
  // recentPtyOutput buffer. Heuristic: Claude's TUI prefixes assistant
  // text with `●` (U+25CF). After the text comes a status line with
  // spinner glyphs and elapsed-time markers like "(6s · ↓ 181 tokens)".
  //
  // Called only when the transcript yielded no Content for the turn.
  // Returns null when nothing useful can be extracted (model emitted
  // tool calls only, or the TUI buffer wrapped past the response).
  private scrapeAssistantTextFromPTY(): string | null {
    const stripped = stripAnsi(this.recentPtyOutput);
    // Find the LAST `●` marker — most recent assistant response.
    const lastIdx = stripped.lastIndexOf('●');
    if (lastIdx < 0) return null;
    let chunk = stripped.slice(lastIdx + 1);
    // Cut at the first status/spinner indicator that follows the text.
    // Spinner glyphs:   ✻ ✶ ✽ ✢ ✣ ✤ ✥ ✦ ✧ ✩ ✪ ⚫
    // Elapsed-time:     "(Xs · ..."
    // Status pill:      "❯ "  (TUI returning focus to input)
    const endPattern = /[✻✶✽✢✣✤✥✦✧✩✪⚫]|\s\(\d+s\s*[·]|\n\s*❯\s/;
    const endIdx = chunk.search(endPattern);
    if (endIdx >= 0) chunk = chunk.slice(0, endIdx);
    // The TUI wraps long lines at terminal width. Re-join soft-wrapped
    // lines, but keep paragraph breaks (blank line between).
    const text = chunk
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => l.length > 0 || (arr[i - 1] ?? '').length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 0 ? text : null;
  }

  private async *yieldEventsFromTranscript(
    transcriptPath: string,
    stopEv: HookEvent,
    yieldedToolUseIds: Set<string>,
    wasCompacted: boolean,
  ): AsyncGenerator<ProviderEvent> {
    // Stop hook can fire a few ms before claude flushes the final assistant
    // message to disk. Retry briefly.
    let text = '';
    for (let i = 0; i < TRANSCRIPT_FLUSH_RETRIES; i++) {
      try {
        text = await fsp.readFile(transcriptPath, 'utf-8');
        if (text.length > this.transcriptLineOffset) break;
      } catch {
        /* file may not exist yet */
      }
      await delay(TRANSCRIPT_FLUSH_INTERVAL_MS);
    }
    if (text.length <= this.transcriptLineOffset) {
      // Fall back to last_assistant_message from Stop hook payload if Claude
      // included one (newer versions do). For compaction, no text is expected.
      const lastMsg = pickString(stopEv.payload, 'last_assistant_message');
      if (lastMsg) {
        yield { type: ProviderEventType.Content, text: lastMsg };
        yield { type: ProviderEventType.Finished };
        return;
      }
      if (wasCompacted) {
        // /compact path — just emit Finished, Compacted already yielded.
        yield { type: ProviderEventType.Finished };
        return;
      }
      // AUDITARIA_CLAUDE_PROVIDER: PTY-scrape fallback for Claude 2.1.169+
      // transcript-writing regression. See scrapeAssistantTextFromPTY.
      const scraped = this.scrapeAssistantTextFromPTY();
      if (scraped) {
        dbg('PTY-scrape (transcript empty) yielded', scraped.length, 'chars');
        yield { type: ProviderEventType.Content, text: scraped };
        yield { type: ProviderEventType.Finished };
        return;
      }
      yield {
        type: ProviderEventType.Error,
        message: `Transcript missing or empty at ${transcriptPath}.`,
      };
      return;
    }

    const newText = text.slice(this.transcriptLineOffset);
    this.transcriptLineOffset = text.length;

    let modelEmitted = false;
    let yieldedAnyContent = false;
    let usage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        }
      | undefined;

    for (const line of newText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry: TranscriptEntry;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape of own-written JSONL line
        entry = JSON.parse(trimmed) as TranscriptEntry;
      } catch {
        continue;
      }

      // Capture session ID if not already known (paranoia).
      const sid = entry['sessionId'] ?? entry['session_id'];
      if (typeof sid === 'string' && !this.sessionManager.getSessionId()) {
        this.sessionManager.setSessionId(sid);
      }

      if (entry.type === 'assistant' && entry.message) {
        const msg = entry.message;
        if (!modelEmitted && typeof msg.model === 'string') {
          yield { type: ProviderEventType.ModelInfo, model: msg.model };
          modelEmitted = true;
        }
        if (msg.usage && typeof msg.usage === 'object') {
          const u = msg.usage;
          usage = {
            inputTokens: numberOrUndefined(u.input_tokens),
            outputTokens: numberOrUndefined(u.output_tokens),
            cacheReadTokens: numberOrUndefined(u.cache_read_input_tokens),
            cacheCreationTokens: numberOrUndefined(
              u.cache_creation_input_tokens,
            ),
          };
        }
        const content = msg.content;
        if (Array.isArray(content)) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape of own-written JSONL block
          for (const block of content as ClaudeContentBlock[]) {
            // AUDITARIA_CLAUDE_PROVIDER: Skip tool blocks already streamed via
            // PreToolUse / PostToolUse hooks. yieldedToolUseIds populated by
            // processTurnEvents.
            if (block.type === 'tool_use' && yieldedToolUseIds.has(block.id)) {
              continue;
            }
            if (
              block.type === 'tool_result' &&
              yieldedToolUseIds.has(block.tool_use_id)
            ) {
              continue;
            }
            if (block.type === 'text' && block.text) {
              yieldedAnyContent = true;
            }
            yield* this.yieldEventsFromBlock(block);
          }
        }
      } else if (entry.type === 'user' && entry.message) {
        // AUDITARIA_CLAUDE_PROVIDER: Compaction summary lives in a user
        // message with isCompactSummary:true and a STRING content. Surface as
        // a CompactionSummary event so providerManager can mirror it into
        // Gemini's chat history via <state_snapshot> tags.
        if (entry['isCompactSummary'] === true) {
          const c = entry.message.content;
          if (typeof c === 'string' && c.length > 0) {
            yield { type: ProviderEventType.CompactionSummary, summary: c };
          }
          continue;
        }
        // tool_result blocks land in user messages.
        const content = entry.message.content;
        if (Array.isArray(content)) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape of own-written JSONL block
          for (const block of content as ClaudeContentBlock[]) {
            if (block.type === 'tool_result') {
              if (yieldedToolUseIds.has(block.tool_use_id)) continue;
              yield {
                type: ProviderEventType.ToolResult,
                toolId: block.tool_use_id,
                output: typeof block.content === 'string' ? block.content : '',
                isError: block.is_error,
              };
            }
          }
        }
      }
    }

    // AUDITARIA_CLAUDE_PROVIDER: PTY-scrape fallback for the common case
    // where transcript has metadata (ai-title etc.) but no assistant text
    // blocks (Claude 2.1.169+ regression).
    if (!yieldedAnyContent && !wasCompacted) {
      const scraped = this.scrapeAssistantTextFromPTY();
      if (scraped) {
        dbg(
          'PTY-scrape (no text in transcript) yielded',
          scraped.length,
          'chars',
        );
        yield { type: ProviderEventType.Content, text: scraped };
      }
    }

    yield { type: ProviderEventType.Finished, usage };
  }

  private *yieldEventsFromBlock(
    block: ClaudeContentBlock,
  ): Generator<ProviderEvent> {
    switch (block.type) {
      case 'text':
        if (block.text) {
          yield { type: ProviderEventType.Content, text: block.text };
        }
        break;
      case 'thinking':
        if (block.thinking) {
          yield { type: ProviderEventType.Thinking, text: block.thinking };
        }
        break;
      case 'tool_use':
        yield {
          type: ProviderEventType.ToolUse,
          toolName: block.name,
          toolId: block.id,
          input: block.input,
        };
        break;
      case 'tool_result':
        // Defensive — tool_results are usually in user messages, but Claude
        // has put them under assistant in rare cases.
        yield {
          type: ProviderEventType.ToolResult,
          toolId: block.tool_use_id,
          output: typeof block.content === 'string' ? block.content : '',
          isError: block.is_error,
        };
        break;
      default:
        break;
    }
  }
}

// ─── module-private utilities ─────────────────────────────────────────────────

interface TranscriptEntry {
  type?: string;
  sessionId?: string;
  session_id?: string;
  message?: {
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
  };
  [k: string]: unknown;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// AUDITARIA_CLAUDE_PROVIDER: Pull human-typed text out of a transcript
// `user` entry. The message content is either a plain string (typical
// for actual user messages) or an array of blocks where the only block
// type that represents what the human typed is `text` (the others are
// tool_result echoes Claude appends when a tool returns).
function extractUserTextFromTranscriptEntry(
  entry: TranscriptEntry,
): string | null {
  const msg = entry.message;
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block &&
        block['type'] === 'text' &&
        typeof block['text'] === 'string'
      ) {
        parts.push(block['text'] as string);
      }
    }
    const joined = parts.join('').trim();
    return joined.length > 0 ? joined : null;
  }
  return null;
}

// AUDITARIA_CLAUDE_PROVIDER: On Windows, npm installs `claude` as a .cmd shim
// that calls the real `claude.exe` deep inside node_modules. Spawning the
// .cmd via PTY ends up wrapped in cmd.exe, which closes the foreground
// TTY before Ink can set raw mode. Read the shim and spawn the real exe
// directly. On Unix, resolveExecutable returns the right thing.
async function resolveClaudeExecutable(): Promise<string | undefined> {
  const shim = await resolveExecutable('claude');
  if (!shim) return undefined;
  if (process.platform !== 'win32') return shim;
  if (!shim.toLowerCase().endsWith('.cmd')) return shim;
  // Peek inside the .cmd shim for a quoted path to claude.exe.
  try {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(shim, 'utf-8');
    // Match "...\claude.exe" — npm shims always wrap the path in double quotes.
    const m = text.match(/"([^"]+\\claude\.exe)"/i);
    if (m && m[1]) {
      // Resolve any %dp0%-style relative bits to the shim's directory.
      const { dirname, join, normalize } = await import('node:path');
      const dp0 = dirname(shim);
      const resolved = normalize(
        m[1].replace(/%dp0%\\?/i, dp0.endsWith('\\') ? dp0 : dp0 + '\\'),
      );
      const { existsSync } = await import('node:fs');
      if (existsSync(resolved)) return resolved;
      // Try one more — relative to dp0\
      const alt = normalize(join(dp0, m[1].replace(/^.*?\\/, '')));
      if (existsSync(alt)) return alt;
    }
  } catch {
    /* fall through to using the shim */
  }
  return shim;
}

function isHookEvent(v: unknown): v is HookEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { event?: unknown }).event === 'string'
  );
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
