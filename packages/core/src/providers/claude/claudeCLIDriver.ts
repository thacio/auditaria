/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Interactive Claude driver (PTY + hooks + transcript).
 *
 * Drives the REAL `claude` TUI in a persistent PTY:
 *   1. Write a tiny Node-based hook relay script to tmpdir.
 *   2. Build `--settings '{"hooks":...}'` JSON pointing at the relay.
 *   3. Spawn `claude --settings ... --model ...` in a PTY and wait for the
 *      SessionStart hook (accepting the workspace-trust dialog if it shows).
 *   4. Type each prompt into Claude's input box (body, gap, CR).
 *   5. ONE observer (`ClaudeTurnObserver`) reads the hook relay file and the
 *      session transcript and turns them into ordered ProviderEvents for
 *      WHATEVER turn is running — one typed by `sendMessage`, one the user
 *      typed into the mirrored web terminal, or one the CLI started by itself
 *      (background-task / sub-agent notifications). Chat turns are consumed
 *      by the `sendMessage` generator; the others are delivered through
 *      `onExternalTurn` with the very same event stream.
 *
 * The PTY is mirrored live to the web client through `providerPtyMirror`.
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  ExternalTurn,
  ExternalTurnCapableDriver,
  ProviderNotice,
  ProviderDriverStatus,
  ProviderRecoveryCapableDriver,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import { ClaudeSessionManager } from './claudeSessionManager.js';
import type { ClaudeDriverConfig } from './types.js';
import { PtyWriteQueue } from './interactivePromptSupport.js'; // AUDITARIA_CLAUDE_PROVIDER
import { providerPtyMirror } from '../terminal/ptyMirror.js'; // AUDITARIA_PROVIDER_TERMINAL: shared web-terminal mirror bus
import { ProviderScreenMirror } from '../terminal/screenMirror.js'; // AUDITARIA_CLAUDE_PROVIDER: plain-text screen for the CLI hand-off
import { JsonlFileTail } from '../terminal/jsonlTail.js';
import { getClaudeProjectDirHash } from './claudeSessionBrowser.js'; // AUDITARIA_CLAUDE_PROVIDER
import {
  ClaudeTurnObserver,
  type HookEvent,
  type ObservedTurn,
} from './claudeTurnObserver.js';

// AUDITARIA_CLAUDE_PROVIDER: Debug logging — enable at runtime with
// AUDITARIA_PROVIDER_DEBUG=1. Writes to stdout with a [DEBUG] prefix so the UI
// surfaces them as informational LOG lines instead of red ERROR.
const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[DEBUG][CLI_DRIVER]', ...args); // eslint-disable-line no-console
}

// AUDITARIA_CLAUDE_PROVIDER: Default timeouts.
const SESSION_START_TIMEOUT_MS = 30_000; // Time for Ink to fully bootstrap.
const PROMPT_TYPE_DELAY_MS = 150; // Pause between prompt body and the Enter keystroke.
const SESSION_START_GRACE_MS = 1500; // Wait after SessionStart for Ink to accept keystrokes.
// AUDITARIA_CLAUDE_PROVIDER: prompt-acceptance verification. Typing is
// fire-and-forget: Ink's paste heuristics can swallow the CR into the input
// buffer, after a web-viewer focus-out the TUI (focus reporting, mode 1004)
// can mishandle Enter, and right after SessionStart the TUI is often still
// "connecting" (verified live: the first prompt needed a resend in most probe
// runs). If no signal confirms acceptance within this window, re-assert
// focus-in + CR (bounded); after the retries, fail the turn VISIBLY.
const PROMPT_ACCEPT_TIMEOUT_MS = 3_000;
const MAX_PROMPT_RESUBMITS = 3;
/** Slash commands typed from chat mostly open a dialog and emit nothing: after
 *  this long with no signal the turn is reported as "ran in the terminal". */
const SLASH_ACCEPT_TIMEOUT_MS = 8_000;
const OBSERVER_TICK_MS = 100;
const TRUST_DIALOG_SCAN_INTERVAL_MS = 200;
const DIALOG_DISMISS_SETTLE_MS = 400;
const PTY_COLS = 200;
const PTY_ROWS = 50;
// Kill switch: AUDITARIA_CLAUDE_PTY_SCRAPE_DISABLED=1 disables the PTY-scrape
// fallbacks (idle-prompt detection for turn completion, assistant-text scrape
// when the transcript is not written).
const PTY_SCRAPE_DISABLED =
  process.env['AUDITARIA_CLAUDE_PTY_SCRAPE_DISABLED'] === '1';

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
  // AUDITARIA_CLAUDE_PROVIDER: PreToolUse/PostToolUse/Stop fire as SEPARATE
  // node processes appending to ONE file; on Windows they collide
  // (EBUSY/EPERM/EACCES). The old code swallowed the error and silently
  // dropped the line — when the dropped line was Stop, the turn hung for
  // 30 min. Retry a few times with a short synchronous backoff.
  for (let attempt = 0; attempt < 5; attempt++) {
    try { fs.appendFileSync(file, line); break; }
    catch (err) {
      const code = err && err.code;
      if (attempt === 4 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES')) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15 * (attempt + 1)); } catch (_) {}
    }
  }
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

// AUDITARIA_CLAUDE_PROVIDER: Single-source-of-truth alias for the project
// directory hash Claude Code uses at `~/.claude/projects/<hash>/`.
function encodeProjectPath(absPath: string): string {
  return getClaudeProjectDirHash(absPath);
}

function shellQuote(s: string): string {
  // Use double quotes; escape any embedded double quotes.
  return `"${s.replace(/"/g, '\\"')}"`;
}

export class ClaudeCLIDriver
  implements
    ProviderDriver,
    ExternalTurnCapableDriver,
    ProviderRecoveryCapableDriver
{
  private sessionManager = new ClaudeSessionManager();
  private activePty: MinimalPty | null = null;
  private mcpConfigPath: string | null = null;
  private hookRelayPath: string | null = null;
  private hookFilePath: string | null = null;
  private currentPromptFilePath: string | null = null; // AUDITARIA_AGENT_SESSION
  private writeQueue: PtyWriteQueue | null = null;
  // Rolling PTY output buffer: idle-prompt detection, dialog detection, and
  // the assistant-text scrape fallback when the transcript is not written.
  private recentPtyOutput = '';
  private ptyExited = false;
  private ptyExitCode = 0;
  /** True once SessionStart has fired on the current PTY. */
  private sessionStarted = false;
  /** Resolved `claude` binary path, cached across turns. */
  private claudeExePath: string | null = null;
  /** First-call systemContext is locked in; later changes log a warn. */
  private lastSystemContext: string | undefined = undefined;

  // AUDITARIA_CLAUDE_PROVIDER: the one turn pipeline. Both files are tailed
  // by the observer through these cursors; the driver only positions them
  // (spawn, `/tui fullscreen`, session change).
  private readonly hookTail = new JsonlFileTail(
    () => this.hookFilePath ?? undefined,
  );
  private readonly transcriptTail = new JsonlFileTail(() =>
    this.computeTranscriptPath(),
  );
  private readonly observer: ClaudeTurnObserver;
  private observerTimer: NodeJS.Timeout | null = null;
  private readonly externalEmitter = new EventEmitter();
  // Prompt-acceptance tracking for the claim `sendMessage` is waiting on.
  private promptAccepted = false;
  /** Any turn accepted on this session yet? A never-used session id must not
   *  be resumed after a restart (Claude rejects resuming an empty session). */
  private hadAcceptedTurn = false;
  // AUDITARIA_CLAUDE_PROVIDER: headless copy of the TUI screen — what
  // `/provider terminal` shows in the CLI when no web client is attached.
  private screenMirror: ProviderScreenMirror | null = null;

  constructor(private readonly config: ClaudeDriverConfig) {
    dbg('constructor', {
      model: config.model,
      cwd: config.cwd,
      mcpServerCount: config.mcpServers
        ? Object.keys(config.mcpServers).length
        : 0,
    });
    this.observer = new ClaudeTurnObserver({
      drainHooks: () => this.drainHooks(),
      drainTranscript: async () => {
        const { entries, grew } = await this.transcriptTail.drain();
        return { entries, grew };
      },
      ptyShowsInputPrompt: () => this.ptyShowsInputPrompt(),
      onExternalTurn: (turn) => {
        this.hadAcceptedTurn = true;
        this.externalEmitter.emit('turn', this.toExternalTurn(turn));
      },
      onNotice: (notice) => {
        // The driver types `/tui fullscreen` itself at spawn; its local
        // output ("Already using the fullscreen renderer") is not news.
        if (notice.kind === 'local_command' && notice.command === '/tui')
          return;
        this.externalEmitter.emit('notice', notice);
      },
      onSessionChange: (sessionId, source) =>
        this.handleSessionChange(sessionId, source),
      onPromptAccepted: () => {
        this.promptAccepted = true;
        this.hadAcceptedTurn = true;
      },
    });
  }

  // AUDITARIA_CLAUDE_PROVIDER_START: local recovery (ProviderRecoveryCapableDriver)

  /** The TUI's current screen as plain text (for the CLI hand-off). */
  async screen(): Promise<string> {
    if (!this.screenMirror) return '';
    return this.screenMirror.plainScreen();
  }

  /** Esc in the TUI cancels the running generation; the observer closes the
   *  turn so the chat never waits on it. */
  interruptCurrentTurn(): void {
    try {
      this.activePty?.write('\x1b');
    } catch {
      /* PTY dead — the exit handler reports it */
    }
    this.observer.abortCurrentTurn('aborted');
  }

  /** Kill Claude; the next message spawns it again (resuming the session
   *  when it ever accepted a turn, fresh otherwise). */
  restart(): void {
    this.observer.abortCurrentTurn('pty-exit');
    this.killPty();
    this.activePty = null;
    this.writeQueue = null;
    this.sessionStarted = false;
    if (!this.hadAcceptedTurn) this.sessionManager.clearSession();
    this.externalEmitter.emit('notice', {
      kind: 'info',
      text: 'Claude Code restarted — the next message starts it again.',
    } satisfies ProviderNotice);
  }

  getStatus(): ProviderDriverStatus {
    return {
      ptyAlive: !!this.activePty && !this.ptyExited,
      sessionId: this.sessionManager.getSessionId(),
      turn: this.observer.activeTurn ?? undefined,
      pendingPrompts: this.observer.hasPendingPrompts() ? 1 : 0,
    };
  }
  // AUDITARIA_CLAUDE_PROVIDER_END

  readonly canResume = true;

  getSessionId(): string | undefined {
    return this.sessionManager.getSessionId();
  }

  setSessionId(id: string): void {
    // AUDITARIA_CLAUDE_PROVIDER: Force PTY respawn on session change so
    // the next sendMessage actually loads the requested session via
    // `--resume <id>`. Without this, the persistent PTY would keep
    // running whatever session it spawned with, and `/resume-claude` (or
    // any other consumer that switches the session id at runtime) would
    // silently type the user's prompt into the wrong session.
    const previousId = this.sessionManager.getSessionId();
    this.sessionManager.setSessionId(id);
    if (this.activePty && previousId !== id) {
      dbg(
        'setSessionId: session changed',
        { from: previousId?.slice(0, 8), to: id.slice(0, 8) },
        '— killing PTY so next sendMessage respawns with --resume',
      );
      this.killPty();
    }
  }

  resetSession(): void {
    this.sessionManager.clearSession();
    this.transcriptTail.reset(0);
  }

  // AUDITARIA_CLAUDE_PROVIDER_START: External turns + notices
  // (ExternalTurnCapableDriver). The manager subscribes once per driver.

  onExternalTurn(listener: (turn: ExternalTurn) => void): () => void {
    this.externalEmitter.on('turn', listener);
    return () => this.externalEmitter.off('turn', listener);
  }

  onNotice(listener: (notice: ProviderNotice) => void): () => void {
    this.externalEmitter.on('notice', listener);
    return () => this.externalEmitter.off('notice', listener);
  }

  /** True while ANY turn runs (chat-started or external) or a typed prompt
   *  awaits acceptance — the exact turn-boundary signal the hive and the
   *  messaging bridges need. */
  isTurnActive(): boolean {
    return this.observer.isTurnActive();
  }

  private toExternalTurn(turn: ObservedTurn): ExternalTurn {
    return {
      promptId: turn.promptId,
      source: turn.source,
      userText: turn.userText,
      events: turn.events,
      interrupt: () => {
        // Esc cancels the running generation in Claude's TUI and never
        // exits it (a second Ctrl+C at the idle prompt would).
        try {
          this.activePty?.write('\x1b');
        } catch {
          /* PTY dead — the observer will see the exit */
        }
        this.observer.abortCurrentTurn('aborted');
      },
    };
  }

  /** `/clear` or `/resume` typed in the terminal: Claude switched sessions
   *  under the same PTY. Follow it — do NOT respawn (setSessionId does). */
  private handleSessionChange(sessionId: string, source: string): void {
    if (this.sessionManager.getSessionId() === sessionId) return;
    dbg('session changed in the terminal', {
      source,
      to: sessionId.slice(0, 8),
    });
    this.sessionManager.setSessionId(sessionId);
    this.transcriptTail.reset(0);
    this.externalEmitter.emit('notice', {
      kind: 'session',
      source,
      sessionId,
      transcriptPath: this.computeTranscriptPath(),
    } satisfies ProviderNotice);
  }

  private async drainHooks(): Promise<HookEvent[]> {
    const { entries } = await this.hookTail.drain();
    return entries.filter(isHookEvent);
  }

  private startObserver(): void {
    if (this.observerTimer) return;
    this.observerTimer = setInterval(() => {
      void this.observer.tick().catch((e) => dbg('observer tick error', e));
    }, OBSERVER_TICK_MS);
  }

  private stopObserver(): void {
    if (this.observerTimer) {
      clearInterval(this.observerTimer);
      this.observerTimer = null;
    }
  }
  // AUDITARIA_CLAUDE_PROVIDER_END

  async interrupt(): Promise<void> {
    this.killPty();
  }

  dispose(): void {
    this.stopObserver();
    this.observer.dispose();
    this.externalEmitter.removeAllListeners();
    this.screenMirror?.dispose();
    this.screenMirror = null;
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
    this.writeQueue = null;
  }

  // AUDITARIA_CLAUDE_PROVIDER_START: Persistent-PTY spawn helper.
  //
  // Returns null when a healthy PTY is ready for the next turn. Returns
  // an error message string when the spawn failed and the caller should
  // surface it as a ProviderEvent.Error.
  //
  // On first call: spawns Claude in a PTY, wires the data/exit handlers,
  // waits for SessionStart (accepting the trust dialog inline), captures
  // the session id, positions both tails, and starts the observer.
  //
  // On subsequent calls: returns null immediately if the existing PTY is
  // still alive. If it died (Claude crashed or was killed), tears down
  // the corpse and respawns fresh.
  private async ensurePtySpawned(signal: AbortSignal): Promise<string | null> {
    if (this.activePty && !this.ptyExited) return null;
    if (this.activePty && this.ptyExited) {
      // Previous PTY died — clean up before respawning.
      this.activePty = null;
      this.writeQueue = null;
      this.sessionStarted = false;
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

    // Reset the hook file on every spawn so we don't carry old events.
    try {
      writeFileSync(this.hookFilePath!, '');
      this.hookTail.reset(0);
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- node-pty module returns a structurally-compatible IPty
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
    if (this.config.mirrorPty !== false) {
      this.screenMirror ??= new ProviderScreenMirror(PTY_COLS, PTY_ROWS);
      this.screenMirror.reset();
    }

    const RECENT_MAX = 128 * 1024;
    pty.onData((data) => {
      this.recentPtyOutput += data;
      if (this.recentPtyOutput.length > RECENT_MAX) {
        this.recentPtyOutput = this.recentPtyOutput.slice(
          this.recentPtyOutput.length - RECENT_MAX,
        );
      }
      this.screenMirror?.write(data);
      // AUDITARIA_PROVIDER_TERMINAL: source-guarded + suppressible for
      // headless drivers (sub-agent sessions, Teams threads).
      if (this.config.mirrorPty !== false) {
        providerPtyMirror.emitData(this, data);
      }
      if (DEBUG) {
        const stripped = stripAnsi(data).replace(/\r?\n/g, '\\n');
        dbg('pty raw:', stripped.slice(0, 200));
      }
    });

    if (this.config.mirrorPty !== false) {
      providerPtyMirror.setActive(this, 'Claude Code');
    }

    pty.onExit((e) => {
      this.ptyExited = true;
      this.ptyExitCode = e.exitCode ?? 0;
      dbg('pty exit', e);
      providerPtyMirror.setInactive(this);
      // Robustness: whatever was running is over — close its stream with a
      // visible reason instead of letting the UI wait.
      this.observer.abortCurrentTurn('pty-exit');
      if (this.sessionStarted) {
        this.externalEmitter.emit('notice', {
          kind: 'error',
          message: `Claude Code exited (code ${this.ptyExitCode}). The next message restarts it.`,
        } satisfies ProviderNotice);
      }
    });

    // First-call: wait for SessionStart hook (accepts the trust dialog inline).
    const sessionStartEv = await this.waitForSessionStart(
      pty,
      () => this.recentPtyOutput,
      () => this.ptyExited,
      signal,
    );
    if (!sessionStartEv) {
      if (this.ptyExited) {
        return `claude exited before SessionStart (code ${this.ptyExitCode}). Check that the CLI is installed and authenticated, and that the workspace trust prompt was accepted (terminal tail: ${this.ptyTail(200)}).`;
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

    // Position the tails: skip SessionStart in the hook file, and skip the
    // existing history of a resumed transcript (a fresh session has no file
    // yet, which seekToEnd treats as offset 0).
    await this.hookTail.seekToEnd();
    await this.transcriptTail.seekToEnd();

    // Brief delay so Ink finishes wiring its raw-mode key handler.
    await delay(SESSION_START_GRACE_MS);

    // AUDITARIA_CLAUDE_PROVIDER: Switch Claude's TUI into fullscreen
    // (alt-buffer) mode. The default inline / scrollback mode has a
    // known per-frame redraw leak in Claude Code 2.1.x that duplicates
    // banner / spinner / message lines in any xterm.js-based viewer —
    // tracked in anthropics/claude-code#49086 and #51828.
    //
    // Opt-out: set AUDITARIA_CLAUDE_TUI_INLINE=1 to keep inline mode.
    if (process.env['AUDITARIA_CLAUDE_TUI_INLINE'] !== '1') {
      dbg('sending /tui fullscreen to avoid xterm duplicate-line bug');
      try {
        pty.write('/tui fullscreen\r');
      } catch {
        /* benign — next turn will try again */
      }
      await delay(800); // let the TUI switch + any UserPromptExpansion drain
      await this.hookTail.seekToEnd();
      await this.transcriptTail.seekToEnd();
    }

    // The observer runs from here on, for chat AND terminal turns alike.
    this.startObserver();
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
      // interactive mode for now. Surface a clear message rather than
      // silently drop.
      yield {
        type: ProviderEventType.Error,
        message:
          'Image attachments are not yet supported with the interactive ' +
          'Claude driver. Drop the image, or temporarily switch providers.',
      };
      return;
    }

    // AUDITARIA_CLAUDE_PROVIDER: systemContext is baked into spawn args on
    // the FIRST sendMessage; subsequent calls can't change it without
    // respawning. Log a warning if it ever changes mid-session.
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
    if (signal.aborted) return;

    // Robustness: a prompt typed while the TUI shows a menu/dialog (the user
    // opened /mcp or /model in the terminal) would land INSIDE that dialog.
    // Dismiss it once; if it is still there, fail visibly instead of
    // typing into it.
    if (this.ptyShowsDialog()) {
      dbg('dialog detected before typing — sending Esc');
      await this.writeQueue?.writeAtomic('\x1b', 'system');
      await delay(DIALOG_DISMISS_SETTLE_MS);
      if (this.ptyShowsDialog()) {
        yield {
          type: ProviderEventType.Error,
          message:
            "Claude's terminal is showing a dialog, so the message was not sent. " +
            'Close the dialog in the provider terminal and send again.',
        };
        return;
      }
    }

    // Claim the next turn BEFORE typing so the acceptance signal can never
    // race the claim, then type body + CR.
    dbg('sendMessage: claiming', {
      prompt: prompt.slice(0, 60),
      turnActive: this.observer.isTurnActive(),
      activeTurn: this.observer.activeTurn,
    });
    const claim = this.observer.claimNextTurn(prompt);
    this.promptAccepted = false;
    const isSlash = prompt.trimStart().startsWith('/');
    this.typePromptIntoPty(pty, prompt);
    let typedAt = Date.now();
    let resubmits = 0;
    let userAborted = false;

    // Abort handler. Persistent PTY: send Ctrl+C to abort the CURRENT
    // turn (Claude returns to its input box) rather than killing the
    // whole PTY and losing the session.
    const abortHandler = () => {
      userAborted = true;
      dbg('abort handler triggered — sending Ctrl+C (persistent PTY)');
      try {
        this.activePty?.write('\x03');
      } catch {
        /* PTY already dead — onExit will tell the mirror */
      }
      this.observer.abortCurrentTurn('aborted');
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    // Closed-loop prompt acceptance (see PROMPT_ACCEPT_TIMEOUT_MS): while the
    // claim is not accepted, periodically re-assert focus-in + CR; after the
    // bounded retries release the claim so the turn ends with a visible error
    // instead of hanging. Slash commands emit nothing when they open a dialog,
    // so they get a single, longer wait and then count as "ran in the terminal".
    const acceptanceTimer = setInterval(() => {
      if (claim.accepted || claim.done || this.ptyExited) return;
      const waited = Date.now() - typedAt;
      if (isSlash) {
        if (waited >= SLASH_ACCEPT_TIMEOUT_MS)
          this.observer.releaseClaim('local');
        return;
      }
      if (waited < PROMPT_ACCEPT_TIMEOUT_MS) return;
      if (this.observer.hasPendingPrompts()) return; // a CR would answer a picker
      if (resubmits >= MAX_PROMPT_RESUBMITS) {
        this.observer.releaseClaim('timeout');
        return;
      }
      resubmits++;
      typedAt = Date.now();
      dbg('prompt not accepted — re-asserting focus-in + CR', {
        attempt: resubmits,
      });
      void this.writeQueue?.withAtomicBlock(async () => {
        await this.writeQueue?.writeAtomic('\x1b[I\r', 'system');
      });
    }, 500);

    let sawContent = false;
    try {
      for await (const event of claim.events) {
        if (signal.aborted) return;
        if (event.type === ProviderEventType.Content) sawContent = true;
        if (event.type === ProviderEventType.Aborted) {
          dbg('sendMessage: claim ended', {
            reason: event.reason,
            accepted: claim.accepted,
            userAborted,
            sinceTyped: Date.now() - typedAt,
          });
          if (userAborted) return;
          if (event.reason === 'local') {
            // A chat-typed slash command that only acted inside the TUI.
            yield {
              type: ProviderEventType.Content,
              text: `Ran \`${prompt.trim()}\` in Claude's terminal.`,
            };
            yield { type: ProviderEventType.Finished };
            return;
          }
          if (event.reason === 'pty-exit') {
            yield {
              type: ProviderEventType.Error,
              message: `Claude Code exited (code ${this.ptyExitCode}) before finishing the turn. The next message restarts it.`,
            };
            return;
          }
          yield {
            type: ProviderEventType.Error,
            message: claim.accepted
              ? 'The turn was interrupted in the provider terminal.'
              : `Claude did not accept the prompt after ${MAX_PROMPT_RESUBMITS} retries. Check the provider terminal (tail: ${this.ptyTail(160)}).`,
          };
          return;
        }
        if (
          event.type === ProviderEventType.Finished &&
          !sawContent &&
          !isSlash &&
          !PTY_SCRAPE_DISABLED
        ) {
          // Transcript-not-written fallback (Claude 2.1.169+ regression):
          // Claude answered on screen but persisted nothing — scrape the TUI.
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
        yield event;
      }
    } finally {
      clearInterval(acceptanceTimer);
      signal.removeEventListener('abort', abortHandler);
      // NOTE: do NOT killPty here — the persistent PTY survives across
      // turns. Cleanup happens in dispose().
    }
  }

  // ─── private helpers ──────────────────────────────────────────────────────

  private buildArgs(settingsJson: string, systemContext?: string): string[] {
    // No -p! No --input-format / --output-format stream-json — those imply
    // SDK billing (and stream-json isn't honored in interactive mode anyway).
    const args: string[] = ['--settings', settingsJson];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    // AUDITARIA_PROVIDER_EFFORT: thinking intensity for this session.
    // `ultra` is our id for Claude's ultracode mode ("xhigh + dynamic
    // workflow orchestration"). The --effort flag rejects it (valid values:
    // low..max), so it becomes --effort xhigh here plus `"ultracode": true`
    // in the --settings JSON — the session-scoped delivery path Claude
    // Code's own settings schema documents for it.
    if (this.config.reasoningEffort === 'ultra') {
      args.push('--effort', 'xhigh');
    } else if (this.config.reasoningEffort) {
      args.push('--effort', this.config.reasoningEffort);
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
    // AUDITARIA_CLAUDE_PROVIDER_START: the hook set the observer consumes.
    //   SessionStart        — Ink is ready (startup) / session switched (clear, resume).
    //   UserPromptSubmit    — prompt accepted (carries the prompt text + prompt_id).
    //   Stop / StopFailure  — turn end / API error.
    //   PreToolUse, PostToolUse, PostToolUseFailure — live tool cards.
    //   PermissionRequest, Notification, Elicitation(Result) — the TUI is
    //                         waiting on a human (permission, plan approval, MCP input).
    //   PreCompact/PostCompact — compaction (manual and auto).
    //   SubagentStart/Stop  — sub-agent activity (async Agent tool).
    //   PostModelSwitch     — /model switches (incl. plan-mode auto switches).
    //   UserPromptExpansion — observability.
    return JSON.stringify({
      hooks: {
        SessionStart: [hookEntry('SessionStart')],
        UserPromptSubmit: [hookEntry('UserPromptSubmit')],
        Stop: [hookEntry('Stop')],
        StopFailure: [hookEntry('StopFailure')],
        PreToolUse: [hookEntry('PreToolUse')],
        PostToolUse: [hookEntry('PostToolUse')],
        PostToolUseFailure: [hookEntry('PostToolUseFailure')],
        PermissionRequest: [hookEntry('PermissionRequest')],
        Notification: [hookEntry('Notification')],
        Elicitation: [hookEntry('Elicitation')],
        ElicitationResult: [hookEntry('ElicitationResult')],
        PreCompact: [hookEntry('PreCompact')],
        PostCompact: [hookEntry('PostCompact')],
        SubagentStart: [hookEntry('SubagentStart')],
        SubagentStop: [hookEntry('SubagentStop')],
        PostModelSwitch: [hookEntry('PostModelSwitch')],
        UserPromptExpansion: [hookEntry('UserPromptExpansion')],
        // Provisional live text: long answers stream in batches ~1 s before
        // the transcript writes the complete block (Astra's finding).
        MessageDisplay: [hookEntry('MessageDisplay')],
      },
      // AUDITARIA_PROVIDER_EFFORT: session-scoped ultracode mode (see
      // buildArgs — pairs with --effort xhigh). Harmlessly ignored when
      // workflows are unavailable (the schema `.catch`es invalid values).
      ...(this.config.reasoningEffort === 'ultra' ? { ultracode: true } : {}),
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
    const pty = this.activePty;
    if (!pty) return;
    try {
      pty.kill();
    } catch {
      /* ignore */
    }
    // Windows: pty.kill() can leave claude.exe alive behind a dead ConPTY
    // host; the zombies later make ConPTY spawns fail (error 216, observed
    // live). Kill the whole tree by pid.
    if (process.platform === 'win32' && pty.pid) {
      try {
        execSync(`taskkill /PID ${pty.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
    // AUDITARIA_CLAUDE_PROVIDER: Ensure the mirror sees the death even if
    // onExit doesn't fire promptly (kill path races onExit on Windows).
    providerPtyMirror.setInactive(this);
  }

  private typePromptIntoPty(pty: MinimalPty, prompt: string): void {
    // Strategy mirrors smithersai/claude-p: write the body, brief gap, then
    // CR as a separate event. Ink's bracketed-paste / burst-input heuristics
    // can otherwise drop the CR into the input buffer instead of submitting.
    //
    // AUDITARIA_CLAUDE_PROVIDER: All writes through PtyWriteQueue with the
    // gate up so a web-typist's keystrokes can't slip between body and CR.
    void pty;
    void this.writeQueue?.withAtomicBlock(async () => {
      // AUDITARIA_CLAUDE_PROVIDER: assert focus-in first — Claude Code enables
      // focus reporting (mode 1004), and after the web viewer sends a
      // focus-out (user clicks from the mirrored terminal back to chat) the
      // TUI can mishandle Enter, leaving the typed prompt unsubmitted.
      await this.writeQueue?.writeAtomic('\x1b[I', 'system');
      // Paced chunks, not one burst: a long prompt (e.g. a large delivered
      // hive message) is otherwise dropped to its tail by Ink's input parser.
      await this.writeQueue?.writeChunked(prompt, 'system');
      await new Promise<void>((r) => setTimeout(r, PROMPT_TYPE_DELAY_MS));
      await this.writeQueue?.writeAtomic('\r', 'system');
    });
  }

  // AUDITARIA_CLAUDE_PROVIDER: Public PTY input entry-point used by the
  // providerPtyMirror to forward web-terminal keystrokes. Uses the
  // 'web-typist' queue priority so it never preempts a typePromptIntoPty
  // burst or a system-level response keystroke.
  async writeRawInput(bytes: string): Promise<void> {
    if (!bytes) return;
    if (!this.writeQueue) {
      throw new Error('Claude is not running — send a message to start it.');
    }
    await this.writeQueue.writeAtomic(bytes, 'web-typist');
  }

  // AUDITARIA_CLAUDE_PROVIDER: Public PTY resize entry-point. Web viewer
  // calls this whenever xterm.js' FitAddon reports new geometry so
  // Claude redraws to fit.
  resize(cols: number, rows: number): void {
    if (!this.activePty) return;
    try {
      this.activePty.resize(cols, rows);
      this.screenMirror?.resize(cols, rows);
    } catch {
      /* PTY died — onExit will tell the mirror */
    }
  }

  // AUDITARIA_CLAUDE_PROVIDER: Interactive-prompt response entry point.
  // Called by providerManager.respondToPrompt() once the UI has the answer.
  // Drives Claude's AskUserQuestion picker with keystrokes.
  async respondToPrompt(
    promptId: string,
    response: InteractivePromptResponse,
  ): Promise<void> {
    const questions = this.observer.getPendingPrompt(promptId);
    if (!questions) {
      dbg('respondToPrompt: no pending prompt for id', promptId);
      return;
    }
    // NOTE: the observer keeps the prompt pending until the tool_result
    // lands, and emits InteractivePromptResolved then.

    if (response.kind !== 'answered') {
      // User cancelled. We can't easily cancel Claude's picker from outside;
      // best we can do is send Escape and hope. Esc is 0x1b.
      dbg('respondToPrompt: user cancelled — sending ESC');
      await this.writeQueue?.writeAtomic('\x1b', 'system');
      return;
    }

    // AUDITARIA_CLAUDE_PROVIDER: Wait until the picker is rendered. The
    // tool_use lands (transcript/PreToolUse) when Claude DECIDES to call the
    // tool, before the TUI shows the picker. Number-digit input goes into the
    // prompt input box if the picker isn't focused yet. Use arrow keys
    // (Down + Enter) — these are interpreted as picker navigation regardless
    // of focus race.
    const PICKER_READY_DELAY_MS = 2500;
    const ARROW_DELAY_MS = 80;
    const SELECT_SETTLE_MS = 200;
    const TAB_DELAY_MS = 300;
    const DOWN = '\x1b[B';
    const ENTER = '\r';

    const emittedAt = this.observer.takePromptEmittedAt(promptId) ?? Date.now();
    const waitMore = Math.max(
      0,
      PICKER_READY_DELAY_MS - (Date.now() - emittedAt),
    );
    if (waitMore > 0) {
      dbg('respondToPrompt: waiting', waitMore, 'ms for picker to render');
      await new Promise<void>((r) => setTimeout(r, waitMore));
    }

    // Multi-question picker has a top tab-bar [Q1] [Q2] ... [Submit].
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
      // appends a "Type something" row at index = model-options.length.
      // Navigate there, press Enter to switch the picker into text-input
      // mode, type the user's text, press Enter to submit / auto-advance.
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
        await press(ENTER, SELECT_SETTLE_MS);
        await press(answer.customText!, SELECT_SETTLE_MS);
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

  // AUDITARIA_CLAUDE_PROVIDER: Wait for the SessionStart hook after spawn,
  // accepting the workspace-trust dialog when it shows. The dialog lists
  // "No, exit" FIRST (verified live on 2.1.261 — a bare Enter exits Claude
  // with code 1), so we move the ❯ cursor onto the "Yes, I trust this
  // folder" line before pressing Enter.
  private async waitForSessionStart(
    pty: MinimalPty,
    getRecent: () => string,
    isExited: () => boolean,
    signal: AbortSignal,
  ): Promise<HookEvent | null> {
    const deadline = Date.now() + SESSION_START_TIMEOUT_MS;
    let trustAccepted = false;
    let trustDowns = 0;
    let lastTrustScan = 0;
    while (Date.now() < deadline) {
      if (signal.aborted) return null;
      if (isExited()) return null;

      if (
        !trustAccepted &&
        Date.now() - lastTrustScan > TRUST_DIALOG_SCAN_INTERVAL_MS
      ) {
        lastTrustScan = Date.now();
        // The dialog is drawn with cursor-positioning escapes, so once the
        // escapes are stripped both options sit on ONE text line — line-based
        // checks fail. What is reliable: the ❯ glyph is emitted immediately
        // before the option it marks, and the LAST ❯ is the current render.
        const flat = stripAnsi(getRecent()).replace(/\s+/g, ' ');
        const dialog = /trust/i.test(flat) && /folder/i.test(flat);
        if (dialog) {
          const cursor = flat.lastIndexOf('❯');
          const marked =
            cursor >= 0 ? flat.slice(cursor + 1, cursor + 40).trim() : '';
          if (/^yes/i.test(marked)) {
            dbg('trust dialog: cursor on the Yes option — pressing Enter');
            try {
              pty.write('\r');
            } catch {
              /* ignore */
            }
            trustAccepted = true;
            this.externalEmitter.emit('notice', {
              kind: 'info',
              text: `Accepted Claude Code's workspace trust prompt for ${this.config.cwd}.`,
            } satisfies ProviderNotice);
          } else if (trustDowns < 4) {
            dbg('trust dialog: moving cursor down to the Yes option');
            trustDowns++;
            try {
              pty.write('\x1b[B');
            } catch {
              /* ignore */
            }
          }
        }
      }

      const events = await this.drainHooks();
      for (const ev of events) {
        if (ev.event === 'SessionStart') return ev;
      }

      await delay(OBSERVER_TICK_MS);
    }
    return null;
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

  private ptyTail(chars: number): string {
    return stripAnsi(this.recentPtyOutput).replace(/\s+/g, ' ').slice(-chars);
  }

  /** Does the live PTY tail show Claude's idle input prompt (❯)? Checking
   *  only the LAST few lines avoids matching a stale ❯ deep in the buffer
   *  (e.g. a selection-list cursor mid-turn). */
  private ptyShowsInputPrompt(): boolean {
    if (PTY_SCRAPE_DISABLED) return false;
    const lines = stripAnsi(this.recentPtyOutput)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    return lines.slice(-3).some((l) => l.includes('❯'));
  }

  /** Is a TUI dialog/menu (/model, /mcp, /help, trust, …) on screen instead
   *  of the input box? Those all carry an "Esc to cancel/close" footer. */
  private ptyShowsDialog(): boolean {
    if (PTY_SCRAPE_DISABLED) return false;
    const tail = stripAnsi(this.recentPtyOutput).slice(-2000);
    return (
      /esc\s+to\s+(cancel|close|exit|go back|dismiss)/i.test(tail) &&
      !this.ptyShowsInputPrompt()
    );
  }

  // AUDITARIA_CLAUDE_PROVIDER: PTY-scrape fallback for the Claude 2.1.169+
  // transcript-writing regression (Claude answered on screen but persisted
  // nothing). Extracts Claude's last assistant text from the rolling PTY
  // buffer. Heuristic: the TUI prefixes assistant text with `●` (U+25CF);
  // after the text comes a status line with spinner glyphs / elapsed time.
  private scrapeAssistantTextFromPTY(): string | null {
    const stripped = stripAnsi(this.recentPtyOutput);
    const lastIdx = stripped.lastIndexOf('●');
    if (lastIdx < 0) return null;
    let chunk = stripped.slice(lastIdx + 1);
    const endPattern = /[✻✶✽✢✣✤✥✦✧✩✪⚫]|\s\(\d+s\s*[·]|\n\s*❯\s/;
    const endIdx = chunk.search(endPattern);
    if (endIdx >= 0) chunk = chunk.slice(0, endIdx);
    const text = chunk
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => l.length > 0 || (arr[i - 1] ?? '').length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 0 ? text : null;
  }
}

// ─── module-private utilities ─────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// AUDITARIA_CLAUDE_PROVIDER: On Windows, npm installs `claude` as a .cmd shim
// that calls the real `claude.exe` deep inside node_modules. Spawning the
// .cmd via PTY ends up wrapped in cmd.exe, which closes the foreground
// TTY before Ink can set raw mode. Read the shim and spawn the real exe
// directly. On Unix, resolveExecutable returns the right thing.
async function resolveClaudeExecutable(): Promise<string | undefined> {
  const shim = resolveExecutable('claude');
  if (!shim) return undefined;
  if (process.platform !== 'win32') return shim;
  if (!shim.toLowerCase().endsWith('.cmd')) return shim;
  try {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(shim, 'utf-8');
    // Match "...\claude.exe" — npm shims always wrap the path in double quotes.
    const m = text.match(/"([^"]+\\claude\.exe)"/i);
    if (m && m[1]) {
      const { dirname, join, normalize } = await import('node:path');
      const dp0 = dirname(shim);
      const resolved = normalize(
        m[1].replace(/%dp0%\\?/i, dp0.endsWith('\\') ? dp0 : dp0 + '\\'),
      );
      const { existsSync } = await import('node:fs');
      if (existsSync(resolved)) return resolved;
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
