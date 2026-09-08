/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER + AUDITARIA_PROVIDER_TERMINAL: Interactive Antigravity
 * driver — the REAL `agy` TUI in a persistent PTY, mirrored live to the web
 * terminal, one turn pipeline for chat-typed, terminal-typed and self-started
 * turns (see `agyTurnObserver`). The one-shot `--print` driver
 * (`agyCLIDriver.ts`) stays for headless contexts.
 *
 * Verified on agy 1.1.27 (Windows), see `.auditaria/agy-tui-sync-plan.md`:
 *   - the TUI is ready ~5 s after spawn (`? for shortcuts` footer); a cold
 *     start can sit on "Signing in..." much longer — never type before the
 *     footer shows;
 *   - the conversation and its transcript appear at the FIRST prompt; the
 *     SessionStart hook names them (`conversationId`, `transcriptPath`), the
 *     brain directory diff is the fallback;
 *   - hooks load from an owned global plugin dir
 *     `~/.gemini/config/plugins/auditaria-observer/` (written at spawn,
 *     removed on dispose; the relay no-ops for the user's own sessions).
 *     agy runs hook commands through cmd.exe and breaks on ANY double quote,
 *     so the command is `node <space-free path> <event>`;
 *   - Esc interrupts generation (screen `⎿ Interrupted`), Ctrl+C interrupts
 *     a running tool; the TUI survives both.
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
import type { AgyDriverConfig } from './types.js';
import { AgyTurnObserver } from './agyTurnObserver.js';
import {
  classifyAgyFailure,
  mergeAgyMcpConfig,
  removeAgyMcpConfig,
  resolveAgyExecutable,
} from './agyCLIDriver.js';
import { PtySession } from '../terminal/ptySession.js';
import { JsonlFileTail } from '../terminal/jsonlTail.js';
import { ProviderScreenMirror } from '../terminal/screenMirror.js';
import { ensureHookRelayScript, quoteFreePath } from '../terminal/hookRelay.js';
import {
  isPlainObject,
  pickString,
  type HookEvent,
  type ObservedTurn,
} from '../terminal/turnObserver.js';

const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  if (DEBUG) console.log('[DEBUG][AGY_PTY]', ...args);
}

const PTY_COLS = 200;
const PTY_ROWS = 50;
const OBSERVER_TICK_MS = 150;
const READY_TIMEOUT_MS = 180_000; // "Signing in..." can take minutes cold
const DIALOG_WAIT_MS = 10 * 60_000;
const PROMPT_ACCEPT_TIMEOUT_MS = 4_000;
const MAX_PROMPT_RESUBMITS = 2;
const PROMPT_ACCEPT_CEILING_MS = 60_000;
const SLASH_ACCEPT_TIMEOUT_MS = 8_000;
const FOCUS_IN = '\x1b[I';
const ESC = '\x1b';
const CTRL_C = '\x03';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** Inline system context above this goes to a spill file (argv/typing cap). */
const MAX_PROMPT_CHARS = 28_000;
export const AGY_HOOK_FILE_ENV = 'AUDITARIA_AGY_HOOK_FILE';
export const AGY_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'PreInvocation',
  'PostInvocation',
  'Stop',
] as const;
const AGY_HOME = join(homedir(), '.gemini', 'antigravity-cli');
const BRAIN_DIR = join(AGY_HOME, 'brain');
const PLUGIN_DIR = join(
  homedir(),
  '.gemini',
  'config',
  'plugins',
  'auditaria-observer',
);

/** What the TUI screen shows besides the idle input box. */
export type AgyScreenState =
  | 'starting'
  | 'input'
  | 'working'
  | 'picker'
  | 'login'
  | 'permission'
  | 'unknown';

/** Classify the TUI's current screen (plain text). Exported for tests. */
export function classifyAgyScreen(screen: string): AgyScreenState {
  const s = screen.replace(/\s+/g, ' ');
  if (
    /Signing in\.\.\.|not signed in|visit the URL|sign in to continue/i.test(
      s,
    ) &&
    !/\? for shortcuts/.test(s)
  ) {
    return 'login';
  }
  if (
    /Generating\.\.\.|Running command|esc to cancel(?! Gemini| Claude| GPT)/i.test(
      s,
    ) &&
    !/Navigate · enter Select/.test(s)
  ) {
    return 'working';
  }
  if (/↑\/↓ Navigate|enter Select|esc Go Back|Switch Model/i.test(s))
    return 'picker';
  if (
    /Allow|Deny|\(y\/n\)|permission/i.test(s) &&
    /\?/.test(s) &&
    !/\? for shortcuts/.test(s)
  ) {
    return 'permission';
  }
  if (/\? for shortcuts/.test(s)) return 'input';
  if (/Antigravity CLI|Accessing workspace/i.test(s)) return 'starting';
  return 'unknown';
}

/** CLI args for the interactive TUI. Exported for tests. */
export function buildAgyPtyArgs(opts: {
  model?: string;
  conversationId?: string;
}): string[] {
  const args: string[] = [];
  if (opts.model && opts.model !== 'auto') args.push('--model', opts.model);
  if (opts.conversationId) args.push('--conversation', opts.conversationId);
  args.push('--dangerously-skip-permissions');
  return args;
}

/** The plugin's hooks.json: quote-free commands. Exported for tests. */
export function buildAgyHooksFile(
  nodeCommand: string,
  relayPath: string,
): string {
  const hooks: Record<string, unknown> = { enabled: true };
  for (const event of AGY_HOOK_EVENTS) {
    hooks[event] = [
      {
        type: 'command',
        command: `${nodeCommand} ${relayPath} ${event}`,
        timeout: 10,
      },
    ];
  }
  return JSON.stringify({ 'auditaria-observer': hooks }, null, 2);
}

export { quoteFreePath } from '../terminal/hookRelay.js';

export class AgyPtyDriver
  implements
    ProviderDriver,
    ExternalTurnCapableDriver,
    ProviderRecoveryCapableDriver
{
  readonly canResume = true;
  private session: PtySession | null = null;
  private conversationId: string | undefined;
  private transcriptPath: string | undefined;
  private started = false;
  private hadAcceptedTurn = false;
  private firstTurnDone = false;
  private mcpConfigInjected = false;
  private hookDir: string | null = null;
  private hookFilePath: string | null = null;
  private pluginInstalled = false;
  private readonly hookTail = new JsonlFileTail(
    () => this.hookFilePath ?? undefined,
  );
  private transcriptSize = -1;
  private readonly observer: AgyTurnObserver;
  private observerTimer: NodeJS.Timeout | null = null;
  private readonly externalEmitter = new EventEmitter();
  private screenMirror: ProviderScreenMirror | null = null;
  private lastScreen: string | null = null;
  private brainsBefore = new Set<string>();
  private lastBrainScanAt = 0;
  private interruptedSeenAt = 0;

  constructor(private readonly config: AgyDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
    this.observer = new AgyTurnObserver({
      drainHooks: () => this.drainHooks(),
      drainTranscript: async () => this.readTranscript(),
      ptyShowsInputPrompt: () => this.screenState() === 'input',
      onExternalTurn: (turn) => {
        this.hadAcceptedTurn = true;
        this.externalEmitter.emit('turn', this.toExternalTurn(turn));
      },
      onNotice: (notice) => this.externalEmitter.emit('notice', notice),
      onSessionChange: (id, source) => this.handleSessionChange(id, source),
      onPromptAccepted: () => {
        this.hadAcceptedTurn = true;
        this.firstTurnDone = true;
      },
    });
  }

  // ── ProviderDriver ─────────────────────────────────────────────────────────

  getSessionId(): string | undefined {
    return this.conversationId;
  }

  setSessionId(id: string): void {
    if (id === this.conversationId) return;
    this.bindConversation(id);
    this.firstTurnDone = true; // a resumed conversation already carries the context
    if (this.session?.isAlive()) this.killSession();
  }

  resetSession(): void {
    this.conversationId = undefined;
    this.transcriptPath = undefined;
    this.transcriptSize = -1;
    this.firstTurnDone = false;
    this.observer.resetConversation(undefined);
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
    if (this.mcpConfigInjected) {
      this.mcpConfigInjected = false;
      removeAgyMcpConfig();
    }
    this.removeHookInfra();
  }

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
    attachmentFiles?: AttachmentFile[],
  ): AsyncGenerator<ProviderEvent> {
    if (signal.aborted) return;
    this.mcpConfigInjected =
      mergeAgyMcpConfig(this.config) || this.mcpConfigInjected;

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
    if (state === 'login' || state === 'permission' || state === 'picker') {
      yield {
        type: ProviderEventType.Error,
        message: `Antigravity's terminal is showing a ${describeState(state)}, so the message was not sent. Answer it in the provider terminal (/provider terminal, or the web terminal) and send again.`,
      };
      return;
    }

    const effective = this.buildEffectivePrompt(
      prompt,
      systemContext,
      attachmentFiles,
    );
    dbg('sendMessage: claiming', {
      prompt: prompt.slice(0, 60),
      active: this.observer.isTurnActive(),
    });
    const claim = this.observer.claimNextTurn(effective);
    const isSlash = prompt.trimStart().startsWith('/');
    void this.typePrompt(session, effective);
    let typedAt = Date.now();
    const firstTypedAt = typedAt;
    let resubmits = 0;
    let userAborted = false;

    const abortHandler = () => {
      userAborted = true;
      void this.sendInterruptKeys();
      this.observer.abortCurrentTurn('aborted');
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    const acceptanceTimer = setInterval(() => {
      if (claim.accepted || claim.done || !session.isAlive()) return;
      const st = this.screenState();
      if (st === 'starting' || st === 'working' || st === 'login') {
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
              text: `Ran \`${prompt.trim()}\` in Antigravity's terminal.`,
            };
            yield { type: ProviderEventType.Finished };
            return;
          }
          if (event.reason === 'pty-exit') {
            yield {
              type: ProviderEventType.Error,
              message:
                classifyAgyFailure(this.screenTail(600)) ??
                `Antigravity exited (code ${session.exitCode}) before finishing the turn. The next message restarts it.`,
            };
            return;
          }
          yield {
            type: ProviderEventType.Error,
            message: claim.accepted
              ? 'The turn was interrupted in the provider terminal.'
              : (classifyAgyFailure(this.screenTail(600)) ??
                `Antigravity did not accept the prompt after ${Math.round(PROMPT_ACCEPT_CEILING_MS / 1000)} s. Check the provider terminal (screen: ${this.screenTail(160)}).`),
          };
          return;
        }
        yield event;
      }
    } finally {
      clearInterval(acceptanceTimer);
      signal.removeEventListener('abort', abortHandler);
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
      throw new Error(
        'Antigravity is not running — send a message to start it.',
      );
    }
    await this.session.writeRawInput(bytes);
  }

  resize(cols: number, rows: number): void {
    this.session?.resize(cols, rows);
    this.screenMirror?.resize(cols, rows);
  }

  interruptCurrentTurn(): void {
    void this.sendInterruptKeys();
    this.observer.abortCurrentTurn('aborted');
  }

  restart(): void {
    this.observer.abortCurrentTurn('pty-exit');
    this.killSession();
    if (!this.hadAcceptedTurn) {
      this.conversationId = undefined;
      this.transcriptPath = undefined;
      this.firstTurnDone = false;
    }
    this.externalEmitter.emit('notice', {
      kind: 'info',
      text: 'Antigravity restarted — the next message starts it again.',
    } satisfies ProviderNotice);
  }

  getStatus(): ProviderDriverStatus {
    return {
      ptyAlive: !!this.session?.isAlive(),
      sessionId: this.conversationId,
      turn: this.observer.activeTurn ?? undefined,
      pendingPrompts: this.observer.hasPendingPrompts() ? 1 : 0,
    };
  }

  // ── Spawn ──────────────────────────────────────────────────────────────────

  private async ensureSpawned(signal: AbortSignal): Promise<string | null> {
    if (this.session?.isAlive()) return null;
    this.stopObserver();
    this.ensureHookInfra();
    try {
      writeFileSync(this.hookFilePath!, '');
      this.hookTail.reset(0);
    } catch (e) {
      return `Failed to reset the Antigravity hook file: ${String(e)}`;
    }
    const exe = resolveAgyExecutable();
    const args = buildAgyPtyArgs({
      model: this.config.model,
      conversationId: this.conversationId,
    });
    const mirror = this.config.mirrorPty !== false;
    this.lastScreen = null;
    this.brainsBefore = listBrainDirs();
    if (mirror) {
      this.screenMirror ??= new ProviderScreenMirror(PTY_COLS, PTY_ROWS);
      this.screenMirror.reset();
    }
    const session = new PtySession({
      cwd: this.config.cwd,
      cols: PTY_COLS,
      rows: PTY_ROWS,
      env: { [AGY_HOOK_FILE_ENV]: this.hookFilePath! },
      mirror,
      mirrorLabel: 'Google Antigravity',
      onData: (data) => this.screenMirror?.write(data),
    });
    dbg('spawning', { exe, args, resume: !!this.conversationId });
    const err = await session.spawn(exe, args);
    if (err) {
      return `Could not start Antigravity (${exe}): ${err}. Install it from https://antigravity.google and run \`agy\` once to sign in.`;
    }
    this.session = session;
    this.started = false;
    session.onExit((code) => {
      dbg('pty exit', code);
      this.observer.abortCurrentTurn('pty-exit');
      if (this.started) {
        this.externalEmitter.emit('notice', {
          kind: 'error',
          message:
            classifyAgyFailure(this.screenTail(600)) ??
            `Antigravity exited (code ${code}). The next message restarts it.`,
        } satisfies ProviderNotice);
      }
    });
    const readyError = await this.waitForReady(session, signal);
    if (readyError) {
      this.killSession();
      return readyError;
    }
    this.started = true;
    await this.hookTail.seekToEnd();
    this.transcriptSize = -1;
    this.startObserver();
    return null;
  }

  private async waitForReady(
    session: PtySession,
    signal: AbortSignal,
  ): Promise<string | null> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let announced: AgyScreenState | null = null;
    let dialogDeadline = 0;
    while (
      Date.now() < deadline ||
      (announced && Date.now() < dialogDeadline)
    ) {
      if (signal.aborted) return 'Aborted while Antigravity was starting.';
      if (!session.isAlive()) {
        return (
          classifyAgyFailure(this.screenTail(600)) ??
          `Antigravity exited during startup (code ${session.exitCode}). Run \`agy\` in a terminal to check it is installed and signed in. Terminal: ${this.screenTail(300)}`
        );
      }
      await this.refreshScreen();
      const state = this.screenState();
      if (state === 'input') {
        await delay(700);
        await this.refreshScreen();
        if (this.screenState() !== 'input') continue;
        if (announced) this.emitAttention('end', announced);
        return null;
      }
      if (state === 'login' && announced !== state) {
        announced = state;
        dialogDeadline = Date.now() + DIALOG_WAIT_MS;
        this.emitAttention('start', state);
      }
      await delay(300);
    }
    return `Antigravity did not show its input prompt within ${Math.round(READY_TIMEOUT_MS / 1000)} s. Terminal: ${this.screenTail(300)}`;
  }

  private emitAttention(phase: 'start' | 'end', state: AgyScreenState): void {
    this.externalEmitter.emit('notice', {
      kind: 'attention',
      phase,
      id: `startup:${state}`,
      what: 'dialog',
      detail: phase === 'start' ? describeState(state) : undefined,
    } satisfies ProviderNotice);
  }

  /** Per-driver hook file + the owned global plugin dir carrying hooks.json. */
  private ensureHookInfra(): void {
    if (this.hookDir) return;
    this.hookDir = mkdtempSync(join(tmpdir(), 'auditaria-agy-'));
    this.hookFilePath = join(this.hookDir, 'hooks.jsonl');
    const relay = quoteFreePath(
      ensureHookRelayScript('agy', AGY_HOOK_FILE_ENV, { stable: true }),
    );
    const node = quoteFreePath(process.execPath) ?? 'node';
    if (!relay) {
      dbg('hooks skipped: no quote-free relay path');
      return;
    }
    try {
      mkdirSync(PLUGIN_DIR, { recursive: true });
      writeFileSync(
        join(PLUGIN_DIR, 'plugin.json'),
        JSON.stringify({
          name: 'auditaria-observer',
          version: '1.0.0',
          description:
            'Auditaria observational hooks (no-op outside Auditaria sessions)',
        }),
        'utf8',
      );
      writeFileSync(
        join(PLUGIN_DIR, 'hooks.json'),
        buildAgyHooksFile(node, relay),
        'utf8',
      );
      this.pluginInstalled = true;
      dbg('hooks plugin written', PLUGIN_DIR);
    } catch (e) {
      dbg('hooks plugin NOT written (hooks disabled)', e);
    }
  }

  private removeHookInfra(): void {
    if (this.pluginInstalled) {
      this.pluginInstalled = false;
      try {
        rmSync(PLUGIN_DIR, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (this.hookDir) {
      try {
        rmSync(this.hookDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.hookDir = null;
      this.hookFilePath = null;
    }
  }

  /** First turn carries the system context inline (or via a spill file agy reads). */
  private buildEffectivePrompt(
    prompt: string,
    systemContext: string | undefined,
    attachmentFiles?: AttachmentFile[],
  ): string {
    let body = prompt;
    if (attachmentFiles?.length) {
      const refs = attachmentFiles.map((f) => `- ${f.filePath}`).join('\n');
      body = `${body}\n\n[Attached files — view them as needed]\n${refs}`;
    }
    if (this.firstTurnDone || !systemContext) return body;
    const inline = `${systemContext}\n\n---\n\n${body}`;
    if (inline.length <= MAX_PROMPT_CHARS) return inline;
    try {
      const dir = join(this.config.cwd, '.auditaria');
      mkdirSync(dir, { recursive: true });
      const file = join(
        dir,
        this.config.promptFileId
          ? `.agy-system-${this.config.promptFileId}.md`
          : '.agy-system-context.md',
      );
      writeFileSync(file, systemContext, 'utf-8');
      return `Before responding, read your full operating instructions from this file using your view-file tool: ${file}\n\nThen handle this request:\n\n${body}`;
    } catch {
      return inline.slice(0, MAX_PROMPT_CHARS);
    }
  }

  private async typePrompt(session: PtySession, prompt: string): Promise<void> {
    await session.writeSystem(FOCUS_IN);
    const body = prompt.includes('\n')
      ? PASTE_START + prompt + PASTE_END
      : prompt;
    await session.typeSubmit(body);
  }

  /** Esc stops generation; a running tool needs Ctrl+C (verified). */
  private async sendInterruptKeys(): Promise<void> {
    const session = this.session;
    if (!session?.isAlive()) return;
    await session.writeSystem(ESC);
    await delay(400);
    await this.refreshScreen();
    if (this.screenState() === 'working') await session.writeSystem(CTRL_C);
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
      if (event === 'SessionStart') {
        const id = pickString(payload, 'conversationId');
        const transcript = pickString(payload, 'transcriptPath');
        if (id && id !== this.conversationId)
          this.bindConversation(id, transcript);
      }
      dbg('hook', event);
      events.push({ event, payload });
    }
    return events;
  }

  /** The whole transcript, every tick (steps are rewritten in place). */
  private async readTranscript(): Promise<{
    entries: unknown[];
    grew: boolean;
  }> {
    this.discoverConversation();
    const path = this.transcriptPath;
    if (!path) return { entries: [], grew: false };
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return { entries: [], grew: false };
    }
    const grew = raw.length !== this.transcriptSize;
    this.transcriptSize = raw.length;
    if (!grew) return { entries: [], grew: false };
    const entries: unknown[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* partial last line */
      }
    }
    return { entries, grew: true };
  }

  /**
   * A new brain directory created after our spawn is the TUI's conversation:
   * the first one binds (fallback when no SessionStart hook arrives), a later
   * one means the TUI moved on (`/fork`, `/resume`, a new conversation) — the
   * transcript switches and the chat is told.
   */
  private discoverConversation(): void {
    if (!this.session?.isAlive()) return;
    const now = Date.now();
    if (now - this.lastBrainScanAt < 1_000) return;
    this.lastBrainScanAt = now;
    let newest: { id: string; m: number } | undefined;
    for (const id of listBrainDirs()) {
      if (this.brainsBefore.has(id) || id === this.conversationId) continue;
      // The directory appears at once (fork/new); its transcript only with
      // the next prompt — bind now, reads stay empty until the file exists.
      try {
        const m = statSync(join(BRAIN_DIR, id)).mtimeMs;
        if (!newest || m > newest.m) newest = { id, m };
      } catch {
        /* ignore */
      }
    }
    if (!newest) return;
    const previous = this.conversationId;
    if (previous) {
      this.brainsBefore.add(previous);
      if (this.observer.isTurnActive())
        this.observer.abortCurrentTurn('aborted');
    }
    this.bindConversation(newest.id);
    if (previous) {
      this.externalEmitter.emit('notice', {
        kind: 'session',
        source: 'fork',
        sessionId: newest.id,
        transcriptPath: this.transcriptPath,
      } satisfies ProviderNotice);
    }
  }

  private bindConversation(id: string, transcript?: string): void {
    dbg('conversation bound', {
      id: id.slice(0, 8),
      via: transcript ? 'hook' : 'dir',
    });
    this.conversationId = id;
    this.transcriptPath = transcript ?? transcriptPathOf(id);
    this.transcriptSize = -1;
    this.observer.resetConversation(id);
  }

  private handleSessionChange(sessionId: string, source: string): void {
    if (sessionId && sessionId !== this.conversationId)
      this.bindConversation(sessionId);
    this.externalEmitter.emit('notice', {
      kind: 'session',
      source,
      sessionId,
      transcriptPath: this.transcriptPath,
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
          this.noticeInterrupted();
          return this.observer.tick();
        })
        .catch((e) => dbg('observer tick error', e));
    }, OBSERVER_TICK_MS);
  }

  /** The TUI's "Interrupted" banner: end an open turn as aborted (once). */
  private noticeInterrupted(): void {
    const screen = this.lastScreen ?? '';
    if (!/Interrupted · What should Antigravity CLI do instead/.test(screen))
      return;
    if (Date.now() - this.interruptedSeenAt < 5_000) return;
    this.interruptedSeenAt = Date.now();
    if (this.observer.isTurnActive()) this.observer.abortCurrentTurn('aborted');
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

  private screenState(): AgyScreenState {
    const session = this.session;
    if (!session) return 'unknown';
    const text = this.lastScreen ?? session.strippedOutput().slice(-4000);
    return classifyAgyScreen(text);
  }

  private screenTail(chars: number): string {
    const grid = (this.lastScreen ?? '').replace(/\s+/g, ' ').trim();
    const text =
      grid ||
      (this.session?.strippedOutput() ?? '').replace(/\s+/g, ' ').trim();
    return text.slice(-chars);
  }
}

function transcriptPathOf(id: string): string {
  return join(
    BRAIN_DIR,
    id,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  );
}

function listBrainDirs(): Set<string> {
  try {
    return new Set(readdirSync(BRAIN_DIR));
  } catch {
    return new Set();
  }
}

function describeState(state: AgyScreenState): string {
  switch (state) {
    case 'login':
      return 'sign-in prompt';
    case 'permission':
      return 'permission prompt';
    case 'picker':
      return 'selection menu';
    default:
      return 'dialog';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
