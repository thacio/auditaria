/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_COPILOT_PROVIDER + AUDITARIA_PROVIDER_TERMINAL: Interactive
 * Copilot driver — the REAL GitHub Copilot TUI in a persistent PTY, mirrored
 * live to the web terminal, one turn pipeline for chat-typed, terminal-typed
 * and self-started turns (see `copilotTurnObserver`).
 *
 * Verified on Copilot CLI 1.0.83 (Windows), see `.auditaria/copilot-tui-sync-plan.md`:
 *   - `--session-id <uuid>` pre-assigns the session, so
 *     `~/.copilot/session-state/<id>/events.jsonl` is known before the first
 *     prompt (the file appears AT the first prompt); respawns `--resume <id>`;
 *   - hooks are loaded at CLI start; `--plugin-dir <dir>` loads a local
 *     plugin (plugin.json + hooks.json with exec/args entries) for THIS
 *     process only, so our observational hooks never touch the user's own
 *     configuration or sessions. Never a `preToolUse` hook (fail-closed);
 *   - `--no-auto-update` makes the launcher run the OLD vendored build
 *     (1.0.79 here) instead of the newest cached release — never pass it;
 *   - `userPromptSubmitted` confirms a typed prompt within ~0.3 s;
 *     `agentStop` marks the true end of an agent run; `sessionEnd` = `/clear`
 *     (the next prompt's `sessionStart` carries the new id);
 *   - the TUI enables focus reporting and ignores Enter while "unfocused":
 *     focus-in is asserted before every typed prompt; the input is cleared
 *     with a double Esc; Esc aborts a running turn (no file witness).
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AttachmentFile,
  ExternalTurn,
  ExternalTurnCapableDriver,
  ProviderDriver,
  ProviderDriverStatus,
  ProviderEvent,
  ProviderNotice,
  ProviderRecoveryCapableDriver,
} from '../types.js';
import { ProviderEventType } from '../types.js';
import type { CopilotDriverConfig } from './types.js';
import { CopilotTurnObserver } from './copilotTurnObserver.js';
import { PtySession } from '../terminal/ptySession.js';
import { JsonlFileTail } from '../terminal/jsonlTail.js';
import { ProviderScreenMirror } from '../terminal/screenMirror.js';
import { ensureHookRelayScript } from '../terminal/hookRelay.js';
import {
  isPlainObject,
  pickString,
  type HookEvent,
  type ObservedTurn,
} from '../terminal/turnObserver.js';
import {
  injectAgentsMd,
  buildMcpConfigArg,
  resolveCopilotExecutable,
} from './shared.js';

const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  if (DEBUG) console.log('[DEBUG][COPILOT_PTY]', ...args);
}

const PTY_COLS = 200;
const PTY_ROWS = 50;
const OBSERVER_TICK_MS = 100;
/** Startup: the footer must show (a first launch after an update takes ~45 s). */
const READY_TIMEOUT_MS = 90_000;
const DIALOG_WAIT_MS = 10 * 60_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 3_000;
const MAX_PROMPT_RESUBMITS = 3;
/** A cold first prompt (session creation, hooks/MCP loading) can take ~40 s. */
const PROMPT_ACCEPT_CEILING_MS = 90_000;
const SLASH_ACCEPT_TIMEOUT_MS = 8_000;
const FOCUS_IN = '\x1b[I';
const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
export const COPILOT_HOOK_FILE_ENV = 'AUDITARIA_COPILOT_HOOK_FILE';
/** Command hooks we relay. `preToolUse` is deliberately absent (fail-closed). */
export const COPILOT_HOOK_EVENTS = [
  'sessionStart',
  'sessionEnd',
  'userPromptSubmitted',
  'postToolUse',
  'postToolUseFailure',
  'permissionRequest',
  'agentStop',
  'subagentStart',
  'subagentStop',
  'errorOccurred',
  'preCompact',
  'notification',
] as const;

/** What the TUI screen shows besides the idle input box. */
export type CopilotScreenState =
  | 'starting'
  | 'input'
  | 'working'
  | 'trust'
  | 'login'
  | 'picker'
  | 'unknown';

/** Classify the TUI's current screen (plain text). Exported for tests. */
export function classifyCopilotScreen(screen: string): CopilotScreenState {
  const s = screen.replace(/\s+/g, ' ');
  if (/trust (this |the )?(folder|directory|files)|do you trust/i.test(s))
    return 'trust';
  if (/sign in|log in|\/login|not (logged|signed) in|device code/i.test(s))
    return 'login';
  if (/esc interrupt|Working/i.test(s)) return 'working';
  if (/Loading: \d+ hooks|Loading MCP|Connecting to MCP/i.test(s))
    return 'starting';
  if (
    /↑\/↓ (to )?(navigate|select)|enter to (select|confirm)/i.test(s) &&
    !/\/ commands/i.test(s.slice(-200))
  )
    return 'picker';
  if (/\? help|\/ commands/i.test(s)) return 'input';
  return 'unknown';
}

/** `inuse.<pid>.lock` — the TUI marks every session directory it owns. */
export function parseLockPid(names: readonly string[]): number | null {
  for (const name of names) {
    const m = /^inuse\.(\d+)\.lock$/.exec(name);
    if (m) return Number(m[1]);
  }
  return null;
}

/** CLI args for the interactive TUI. Exported for tests. */
export function buildCopilotPtyArgs(opts: {
  sessionId: string;
  resume: boolean;
  model?: string;
  reasoningEffort?: string;
  mcpConfigArg?: string;
  /** Local plugin directory carrying our hooks.json (per process). */
  pluginDir?: string;
}): string[] {
  const args: string[] = [];
  if (opts.resume) {
    args.push('--resume', opts.sessionId);
  } else {
    args.push('--session-id', opts.sessionId);
  }
  args.push('--allow-all');
  if (opts.pluginDir) {
    args.push('--plugin-dir', opts.pluginDir);
  }
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

/** The plugin's hooks.json for `relayPath` (exec/args: no shell quoting). Exported for tests. */
export function buildCopilotHooksFile(relayPath: string): string {
  const hooks: Record<string, unknown[]> = {};
  for (const event of COPILOT_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: 'command',
        exec: process.execPath,
        args: [relayPath, event],
        timeoutSec: 10,
      },
    ];
  }
  return JSON.stringify({ version: 1, hooks }, null, 2);
}

export class CopilotPtyDriver
  implements
    ProviderDriver,
    ExternalTurnCapableDriver,
    ProviderRecoveryCapableDriver
{
  readonly canResume = true;
  private session: PtySession | null = null;
  private sessionId: string | undefined;
  /** True once the current sessionId exists on disk → respawns use --resume. */
  private useResume = false;
  private exePath: string | null = null;
  private hookDir: string | null = null;
  private hookFilePath: string | null = null;
  private pluginDir: string | null = null;
  private started = false;
  private hadAcceptedTurn = false;
  private typedPrompt: string | null = null;
  private truncatedPrompt: { got: number; typed: number } | null = null;
  private readonly hookTail = new JsonlFileTail(
    () => this.hookFilePath ?? undefined,
  );
  private readonly eventsTail = new JsonlFileTail(() => this.eventsPath());
  private readonly observer: CopilotTurnObserver;
  private observerTimer: NodeJS.Timeout | null = null;
  private readonly externalEmitter = new EventEmitter();
  private screenMirror: ProviderScreenMirror | null = null;
  private lastScreen: string | null = null;
  /** The TUI process pid (from `inuse.<pid>.lock` in our session dir). */
  private tuiPid: number | null = null;
  /** Session directories already classified (not ours) — scanned once. */
  private readonly knownSessionDirs = new Set<string>();
  private lastSessionScanAt = 0;
  private clearAnnouncedAt = 0;

  constructor(private readonly config: CopilotDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
    this.observer = new CopilotTurnObserver({
      drainHooks: () => this.drainHooks(),
      drainTranscript: async () => {
        const { entries, grew } = await this.eventsTail.drain();
        if (DEBUG && entries.length) {
          dbg(
            'events',
            entries.map((e) => (isPlainObject(e) ? String(e['type']) : '?')),
          );
        }
        return { entries, grew };
      },
      ptyShowsInputPrompt: () => this.screenState() === 'input',
      onExternalTurn: (turn) => {
        this.hadAcceptedTurn = true;
        this.externalEmitter.emit('turn', this.toExternalTurn(turn));
      },
      onNotice: (notice) => this.externalEmitter.emit('notice', notice),
      onSessionChange: (sessionId, source) =>
        this.handleSessionChange(sessionId, source),
      onPromptAccepted: () => {
        this.hadAcceptedTurn = true;
      },
    });
  }

  // ── ProviderDriver ─────────────────────────────────────────────────────────

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    const previous = this.sessionId;
    this.sessionId = id;
    this.useResume = true;
    this.eventsTail.reset(0);
    if (previous !== id && this.session?.isAlive()) this.killSession();
  }

  resetSession(): void {
    this.sessionId = undefined;
    this.useResume = false;
    this.eventsTail.reset(0);
    if (this.session?.isAlive()) this.killSession();
  }

  async interrupt(): Promise<void> {
    this.interruptCurrentTurn();
  }

  dispose(): void {
    this.stopObserver();
    this.observer.dispose();
    this.externalEmitter.removeAllListeners();
    this.screenMirror?.dispose();
    this.screenMirror = null;
    this.killSession();
    if (this.hookDir) {
      try {
        rmSync(this.hookDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.hookDir = null;
      this.hookFilePath = null;
      this.pluginDir = null;
    }
  }

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
    if (systemContext) injectAgentsMd(this.config.cwd, systemContext);

    const spawnError = await this.ensureSpawned(signal);
    if (spawnError) {
      yield { type: ProviderEventType.Error, message: spawnError };
      return;
    }
    const session = this.session!;
    if (signal.aborted) return;

    let state = this.screenState();
    if (state === 'picker') {
      await session.writeSystem(ESC);
      await delay(400);
      state = this.screenState();
    }
    if (state === 'trust' || state === 'login' || state === 'picker') {
      yield {
        type: ProviderEventType.Error,
        message: `Copilot's terminal is showing a ${describeState(state)}, so the message was not sent. Answer it in the provider terminal (/provider terminal, or the web terminal) and send again.`,
      };
      return;
    }

    dbg('sendMessage: claiming', {
      prompt: prompt.slice(0, 60),
      active: this.observer.isTurnActive(),
    });
    const claim = this.observer.claimNextTurn(prompt);
    this.typedPrompt = prompt;
    this.truncatedPrompt = null;
    const isSlash = prompt.trimStart().startsWith('/');
    void this.typePrompt(session, prompt);
    let typedAt = Date.now();
    const firstTypedAt = typedAt;
    let resubmits = 0;
    let userAborted = false;

    const abortHandler = () => {
      userAborted = true;
      void session.writeSystem(ESC);
      this.observer.abortCurrentTurn('aborted');
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    const acceptanceTimer = setInterval(() => {
      if (claim.accepted || claim.done || !session.isAlive()) return;
      // While the TUI is visibly busy (loading hooks/MCP, "Working"), the
      // prompt is queued inside it: neither resend Enter nor give up.
      const st = this.screenState();
      if (st === 'starting' || st === 'working') {
        typedAt = Date.now();
        return;
      }
      const waited = Date.now() - typedAt;
      if (isSlash) {
        if (waited >= SLASH_ACCEPT_TIMEOUT_MS)
          this.observer.releaseClaim('local');
        return;
      }
      if (waited < PROMPT_ACCEPT_TIMEOUT_MS) return;
      if (Date.now() - firstTypedAt >= PROMPT_ACCEPT_CEILING_MS) {
        this.observer.releaseClaim('timeout');
        return;
      }
      if (resubmits >= MAX_PROMPT_RESUBMITS) return;
      resubmits++;
      typedAt = Date.now();
      dbg('prompt not accepted — re-asserting focus-in + CR', {
        attempt: resubmits,
      });
      void session.writeSystem(FOCUS_IN + '\r');
    }, 500);

    try {
      for await (const event of claim.events) {
        if (signal.aborted) return;
        if (event.type === ProviderEventType.Aborted) {
          dbg('sendMessage: claim ended', {
            reason: event.reason,
            accepted: claim.accepted,
            userAborted,
          });
          if (userAborted) return;
          if (event.reason === 'local') {
            yield {
              type: ProviderEventType.Content,
              text: `Ran \`${prompt.trim()}\` in Copilot's terminal.`,
            };
            yield { type: ProviderEventType.Finished };
            return;
          }
          if (event.reason === 'pty-exit') {
            yield {
              type: ProviderEventType.Error,
              message: `Copilot exited (code ${session.exitCode}) before finishing the turn. The next message restarts it.`,
            };
            return;
          }
          if (this.truncatedPrompt) {
            const { got, typed } = this.truncatedPrompt;
            this.truncatedPrompt = null;
            yield {
              type: ProviderEventType.Error,
              message: `Copilot received only ${got} of the ${typed} characters typed, so the turn was cancelled. Send the message again.`,
            };
            return;
          }
          yield {
            type: ProviderEventType.Error,
            message: claim.accepted
              ? 'The turn was interrupted in the provider terminal.'
              : `Copilot did not accept the prompt after ${Math.round(PROMPT_ACCEPT_CEILING_MS / 1000)} s. Check the provider terminal (screen: ${this.screenTail(160)}).`,
          };
          return;
        }
        yield event;
      }
    } finally {
      clearInterval(acceptanceTimer);
      signal.removeEventListener('abort', abortHandler);
      this.typedPrompt = null;
    }
  }

  // ── ExternalTurnCapableDriver ──────────────────────────────────────────────

  onExternalTurn(listener: (turn: ExternalTurn) => void): () => void {
    this.externalEmitter.on('turn', listener);
    return () => this.externalEmitter.off('turn', listener);
  }

  onNotice(listener: (notice: ProviderNotice) => void): () => void {
    this.externalEmitter.on('notice', listener);
    return () => this.externalEmitter.off('notice', listener);
  }

  isTurnActive(): boolean {
    return this.observer.isTurnActive();
  }

  // ── ProviderRecoveryCapableDriver ──────────────────────────────────────────

  async screen(): Promise<string> {
    if (!this.screenMirror) return '';
    return this.screenMirror.plainScreen();
  }

  async writeRawInput(bytes: string): Promise<void> {
    if (!bytes) return;
    if (!this.session?.isAlive()) {
      throw new Error('Copilot is not running — send a message to start it.');
    }
    await this.session.writeRawInput(bytes);
  }

  resize(cols: number, rows: number): void {
    this.session?.resize(cols, rows);
    this.screenMirror?.resize(cols, rows);
  }

  interruptCurrentTurn(): void {
    void this.session?.writeSystem(ESC);
    this.observer.abortCurrentTurn('aborted');
  }

  restart(): void {
    this.observer.abortCurrentTurn('pty-exit');
    this.killSession();
    if (!this.hadAcceptedTurn) {
      this.sessionId = undefined;
      this.useResume = false;
    }
    this.externalEmitter.emit('notice', {
      kind: 'info',
      text: 'Copilot restarted — the next message starts it again.',
    } satisfies ProviderNotice);
  }

  getStatus(): ProviderDriverStatus {
    return {
      ptyAlive: !!this.session?.isAlive(),
      sessionId: this.sessionId,
      turn: this.observer.activeTurn ?? undefined,
      pendingPrompts: this.observer.hasPendingPrompts() ? 1 : 0,
    };
  }

  // ── Spawn ──────────────────────────────────────────────────────────────────

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

  private async ensureSpawned(signal: AbortSignal): Promise<string | null> {
    if (this.session?.isAlive()) return null;
    this.stopObserver();
    this.ensureHookInfra();
    try {
      writeFileSync(this.hookFilePath!, '');
      this.hookTail.reset(0);
    } catch (e) {
      return `Failed to reset the Copilot hook file: ${String(e)}`;
    }
    if (!this.exePath) this.exePath = resolveCopilotExecutable() ?? null;
    if (!this.exePath) {
      return 'Could not locate the `copilot` executable on PATH. Install the GitHub Copilot CLI: npm install -g @github/copilot';
    }
    const resume = this.useResume && !!this.sessionId;
    if (!this.sessionId) this.sessionId = randomUUID();
    this.observer.sessionId = this.sessionId;
    const args = buildCopilotPtyArgs({
      sessionId: this.sessionId,
      resume,
      model: this.config.model,
      reasoningEffort: this.config.reasoningEffort,
      mcpConfigArg: buildMcpConfigArg(this.config),
      pluginDir: this.pluginDir ?? undefined,
    });
    const mirror = this.config.mirrorPty !== false;
    this.lastScreen = null;
    this.tuiPid = null;
    this.snapshotSessionDirs();
    if (mirror) {
      this.screenMirror ??= new ProviderScreenMirror(PTY_COLS, PTY_ROWS);
      this.screenMirror.reset();
    }
    const session = new PtySession({
      cwd: this.config.cwd,
      cols: PTY_COLS,
      rows: PTY_ROWS,
      env: { [COPILOT_HOOK_FILE_ENV]: this.hookFilePath! },
      mirror,
      mirrorLabel: 'GitHub Copilot',
      onData: (data) => this.screenMirror?.write(data),
    });
    dbg('spawning', { exe: this.exePath, args, resume });
    const err = await session.spawn(this.exePath, args);
    if (err) return err;
    this.session = session;
    this.started = false;
    session.onExit((code) => {
      dbg('pty exit', code);
      this.observer.abortCurrentTurn('pty-exit');
      if (this.started) {
        this.externalEmitter.emit('notice', {
          kind: 'error',
          message: `Copilot exited (code ${code}). The next message restarts it.`,
        } satisfies ProviderNotice);
      }
    });
    const readyError = await this.waitForReady(session, signal);
    if (readyError) {
      this.killSession();
      if (!this.useResume) this.sessionId = undefined;
      return readyError;
    }
    this.useResume = true;
    this.started = true;
    await this.hookTail.seekToEnd();
    await this.eventsTail.seekToEnd();
    this.startObserver();
    return null;
  }

  private async waitForReady(
    session: PtySession,
    signal: AbortSignal,
  ): Promise<string | null> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let announced: CopilotScreenState | null = null;
    let dialogDeadline = 0;
    let trustAnswered = false;
    while (
      Date.now() < deadline ||
      (announced && Date.now() < dialogDeadline)
    ) {
      if (signal.aborted) return 'Aborted while Copilot was starting.';
      if (!session.isAlive()) {
        return `Copilot exited during startup (code ${session.exitCode}). Check that the CLI is installed and authenticated (copilot /login). Terminal: ${this.screenTail(300)}`;
      }
      await this.refreshScreen();
      const state = this.screenState();
      if (state === 'input') {
        await delay(600);
        await this.refreshScreen();
        if (this.screenState() !== 'input') continue;
        if (announced) this.emitAttention('end', announced);
        return null;
      }
      if (state === 'trust' && !trustAnswered) {
        // The workspace is already trusted by Auditaria's own folder-trust gate.
        trustAnswered = true;
        await delay(300);
        await session.writeSystem('\r');
        await delay(800);
        continue;
      }
      if ((state === 'trust' || state === 'login') && announced !== state) {
        if (announced) this.emitAttention('end', announced);
        announced = state;
        dialogDeadline = Date.now() + DIALOG_WAIT_MS;
        this.emitAttention('start', state);
      }
      await delay(250);
    }
    return `Copilot did not show its input prompt within ${Math.round(READY_TIMEOUT_MS / 1000)} s. Terminal: ${this.screenTail(300)}`;
  }

  private emitAttention(
    phase: 'start' | 'end',
    state: CopilotScreenState,
  ): void {
    this.externalEmitter.emit('notice', {
      kind: 'attention',
      phase,
      id: `startup:${state}`,
      what: state === 'trust' ? 'trust' : 'dialog',
      detail: phase === 'start' ? describeState(state) : undefined,
    } satisfies ProviderNotice);
  }

  /** Hook file (per driver) + a local plugin dir carrying our hooks.json. */
  private ensureHookInfra(): void {
    if (this.hookDir) return;
    this.hookDir = mkdtempSync(join(tmpdir(), 'auditaria-copilot-'));
    this.hookFilePath = join(this.hookDir, 'hooks.jsonl');
    const relay = ensureHookRelayScript('copilot', COPILOT_HOOK_FILE_ENV);
    const pluginDir = join(this.hookDir, 'plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'auditaria-observer',
        version: '1.0.0',
        description: 'Auditaria observational hooks for this session',
      }),
      'utf8',
    );
    writeFileSync(
      join(pluginDir, 'hooks.json'),
      buildCopilotHooksFile(relay),
      'utf8',
    );
    this.pluginDir = pluginDir;
  }

  /** Type body + CR; multi-line prompts as a bracketed paste. Focus-in first:
   *  the TUI ignores Enter while it believes the terminal is unfocused. */
  private async typePrompt(session: PtySession, prompt: string): Promise<void> {
    await session.writeSystem(FOCUS_IN);
    const body = prompt.includes('\n')
      ? PASTE_START + prompt + PASTE_END
      : prompt;
    await session.typeSubmit(body);
  }

  // ── Observer plumbing ──────────────────────────────────────────────────────

  private async drainHooks(): Promise<HookEvent[]> {
    const { entries } = await this.hookTail.drain();
    const events: HookEvent[] = [];
    for (const e of entries) {
      if (!isPlainObject(e)) continue;
      const event = pickString(e, 'event');
      if (!event) continue;
      const payload = isPlainObject(e['payload']) ? e['payload'] : {};
      if (event === 'sessionStart') this.bindSession(payload);
      if (event === 'userPromptSubmitted') this.checkTruncation(payload);
      dbg('hook', event, pickString(payload, 'sessionId')?.slice(0, 8));
      events.push({ event, payload });
    }
    return events;
  }

  /** The TUI accepted only a strict prefix of what we typed: cancel at once. */
  private checkTruncation(payload: Record<string, unknown>): void {
    const typed = this.typedPrompt;
    const got = pickString(payload, 'prompt');
    if (!typed || got === undefined) return;
    const norm = (v: string) => v.replace(/\s+/g, ' ').trim();
    const a = norm(typed);
    const b = norm(got);
    this.typedPrompt = null;
    if (b.length < a.length && a.startsWith(b) && a.length - b.length > 3) {
      this.truncatedPrompt = { got: b.length, typed: a.length };
      dbg('truncated prompt accepted — cancelling', this.truncatedPrompt);
      void this.session?.writeSystem(ESC);
    }
  }

  /** sessionStart carries the session id: after `/clear` it is a NEW one. */
  private bindSession(payload: Record<string, unknown>): void {
    const id =
      pickString(payload, 'sessionId') ?? pickString(payload, 'session_id');
    if (!id || id === this.sessionId) return;
    dbg('session id changed', {
      from: this.sessionId?.slice(0, 8),
      to: id.slice(0, 8),
    });
    this.sessionId = id;
    this.useResume = true;
    this.eventsTail.reset(0);
  }

  private handleSessionChange(sessionId: string, source: string): void {
    if (source === 'clear') {
      // 1.0.79: the sessionEnd hook; the directory scan (1.0.83) or the next
      // prompt's sessionStart rebinds the new id.
      this.clearAnnouncedAt = Date.now();
      this.externalEmitter.emit('notice', {
        kind: 'session',
        source: 'clear',
        sessionId: sessionId || this.sessionId || '',
      } satisfies ProviderNotice);
      this.hadAcceptedTurn = false;
      return;
    }
    this.externalEmitter.emit('notice', {
      kind: 'session',
      source,
      sessionId,
      transcriptPath: this.eventsPath(),
    } satisfies ProviderNotice);
  }

  private toExternalTurn(turn: ObservedTurn): ExternalTurn {
    return {
      promptId: turn.promptId,
      source: turn.source,
      userText: turn.userText,
      events: turn.events,
      interrupt: () => this.interruptCurrentTurn(),
    };
  }

  private startObserver(): void {
    if (this.observerTimer) return;
    this.observerTimer = setInterval(() => {
      void this.refreshScreen()
        .then(() => {
          this.scanSessionSwitch();
          return this.observer.tick();
        })
        .catch((e) => dbg('observer tick error', e));
    }, OBSERVER_TICK_MS);
  }

  private sessionRoot(): string {
    return join(homedir(), '.copilot', 'session-state');
  }

  /** Remember the session directories that exist before we start: only
   *  directories created afterwards can be ours. */
  private snapshotSessionDirs(): void {
    this.knownSessionDirs.clear();
    try {
      for (const name of readdirSync(this.sessionRoot()))
        this.knownSessionDirs.add(name);
    } catch {
      /* no sessions yet */
    }
  }

  /**
   * `/clear` typed in the terminal (1.0.83): no hook, no events line — the
   * TUI just creates a NEW session directory (events.jsonl only at the next
   * prompt) and marks it, like ours, with `inuse.<its pid>.lock`. Learn that
   * pid from our own directory, then follow the TUI to any new directory it
   * marks. Throttled; each foreign directory is classified once.
   */
  private scanSessionSwitch(): void {
    if (!this.sessionId || !this.session?.isAlive()) return;
    const now = Date.now();
    if (now - this.lastSessionScanAt < 1_500) return;
    this.lastSessionScanAt = now;
    const root = this.sessionRoot();
    if (this.tuiPid === null) {
      try {
        this.tuiPid = parseLockPid(readdirSync(join(root, this.sessionId)));
      } catch {
        return;
      }
      if (this.tuiPid === null) return;
    }
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === this.sessionId || this.knownSessionDirs.has(name)) continue;
      const dir = join(root, name);
      if (existsSync(join(dir, `inuse.${this.tuiPid}.lock`))) {
        this.followNewSession(name);
        return;
      }
      // A directory still being created may not carry its lock yet: retry
      // it while it is younger than 10 s, classify it as foreign afterwards.
      try {
        if (now - statSync(dir).mtimeMs > 10_000)
          this.knownSessionDirs.add(name);
      } catch {
        this.knownSessionDirs.add(name);
      }
    }
  }

  private followNewSession(newId: string): void {
    dbg('TUI switched to a new session', {
      from: this.sessionId?.slice(0, 8),
      to: newId.slice(0, 8),
    });
    if (this.sessionId) this.knownSessionDirs.add(this.sessionId);
    if (this.observer.isTurnActive()) this.observer.abortCurrentTurn('aborted');
    this.sessionId = newId;
    this.observer.sessionId = newId;
    this.useResume = true;
    this.eventsTail.reset(0);
    this.hadAcceptedTurn = false;
    if (Date.now() - this.clearAnnouncedAt > 5_000) {
      this.externalEmitter.emit('notice', {
        kind: 'session',
        source: 'clear',
        sessionId: newId,
      } satisfies ProviderNotice);
    }
  }

  private stopObserver(): void {
    if (this.observerTimer) {
      clearInterval(this.observerTimer);
      this.observerTimer = null;
    }
  }

  private async refreshScreen(): Promise<void> {
    if (!this.screenMirror) return;
    try {
      this.lastScreen = await this.screenMirror.plainScreen();
    } catch {
      /* keep the previous snapshot */
    }
  }

  private killSession(): void {
    const session = this.session;
    if (!session) return;
    const pid = session.pid;
    try {
      session.kill();
    } catch {
      /* ignore */
    }
    if (process.platform === 'win32' && pid) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        /* already gone */
      }
    }
    this.session = null;
  }

  // ── Screen ────────────────────────────────────────────────────────────────

  private screenState(): CopilotScreenState {
    const session = this.session;
    if (!session) return 'unknown';
    const text = this.lastScreen ?? session.strippedOutput().slice(-4000);
    return classifyCopilotScreen(text);
  }

  private screenTail(chars: number): string {
    const grid = (this.lastScreen ?? '').replace(/\s+/g, ' ').trim();
    const text =
      grid ||
      (this.session?.strippedOutput() ?? '').replace(/\s+/g, ' ').trim();
    return text.slice(-chars);
  }
}

function describeState(state: CopilotScreenState): string {
  switch (state) {
    case 'trust':
      return 'folder trust dialog';
    case 'login':
      return 'login prompt';
    case 'picker':
      return 'selection menu';
    default:
      return 'dialog';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
