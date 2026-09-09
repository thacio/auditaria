/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CODEX_PROVIDER: Interactive Codex driver — the REAL Codex TUI in
 * a persistent PTY, mirrored live to the web terminal, one turn pipeline for
 * chat-typed, terminal-typed and self-started turns (see `codexTurnObserver`).
 *
 * Verified on Codex CLI 0.153.4 (Windows), see `.auditaria/codex-tui-sync-plan.md`:
 *   - the session rollout JSONL is created at the first prompt and written
 *     live; its path arrives in the SessionStart hook (`transcript_path`);
 *   - hooks fire inside the TUI and can be injected per session with
 *     `-c hooks.<Event>=[…]` (plus `--dangerously-bypass-hook-trust`), MCP
 *     servers with `-c mcp_servers.<name>={…}`, and directory trust with
 *     `-c projects.'<cwd>'.trust_level="trusted"` — nothing in the user's
 *     `~/.codex/config.toml` is touched;
 *   - the TUI runs in the alternate screen with focus reporting and bracketed
 *     paste on; the input prompt reads `› Ask Codex to do anything`;
 *   - Esc aborts a turn (Interrupt hook + `turn_aborted`); the Windows
 *     "elevated" sandbox stalls shell tools ~90 s, so approvals/sandbox are
 *     bypassed by default (parity with the headless driver), keep them with
 *     `AUDITARIA_CODEX_SANDBOX=1`;
 *   - `codex resume <id>` resumes a session after a restart.
 */

import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  statSync,
  unlinkSync,
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
import type { CodexDriverConfig } from './types.js';
import { CodexTurnObserver } from './codexTurnObserver.js';
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
import { resolveCodexExecutable } from './codexExecutable.js';

const DEBUG = process.env['AUDITARIA_PROVIDER_DEBUG'] === '1';
function dbg(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  if (DEBUG) console.log('[DEBUG][CODEX_PTY]', ...args);
}

const PTY_COLS = 200;
const PTY_ROWS = 50;
const OBSERVER_TICK_MS = 100;
/** Startup: the input prompt must show (or a dialog we can name). */
const READY_TIMEOUT_MS = 60_000;
/** A startup dialog the user must answer in the terminal. */
const DIALOG_WAIT_MS = 10 * 60_000;
/** CR resend cadence while the typed prompt is not accepted. */
const PROMPT_ACCEPT_TIMEOUT_MS = 3_000;
const MAX_PROMPT_RESUBMITS = 3;
/** After the retries, keep waiting this long before giving up visibly. */
const PROMPT_ACCEPT_CEILING_MS = 60_000;
const SLASH_ACCEPT_TIMEOUT_MS = 8_000;
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Interrupt',
] as const;
const FOCUS_IN = '\x1b[I';
const ESC = '\x1b';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface CodexPtyDriverConfig extends CodexDriverConfig {
  /** Register with the web-terminal mirror (false for headless contexts). */
  mirrorPty?: boolean;
}

/** What the TUI screen shows besides the idle input box. */
export type CodexScreenState =
  | 'starting'
  | 'input'
  | 'trust'
  | 'migration'
  | 'login'
  | 'approval'
  | 'picker'
  | 'working'
  | 'unknown';

/** Classify the TUI's current screen (plain text). Exported for tests. */
export function classifyCodexScreen(screen: string): CodexScreenState {
  const s = screen.replace(/\s+/g, ' ');
  if (/Do you trust the contents of this directory/i.test(s)) return 'trust';
  // Model nudges: deprecation ("Try new model / Use existing model") and the
  // rate-limit one ("Approaching rate limits … Switch to gpt-…?"). Enter on
  // either silently switches the session's model — never type into them.
  if (
    /Try new model|Use existing model|Approaching rate limits|Switch to gpt-/i.test(
      s,
    )
  )
    return 'migration';
  if (
    /Would you like to run the following command|Yes, proceed|approve this/i.test(
      s,
    )
  )
    return 'approval';
  if (
    /Sign in|Log in to Codex|Welcome to Codex.*(sign|log) in|not logged in/i.test(
      s,
    )
  )
    return 'login';
  if (
    /Press enter to confirm or esc to go back|Select Model and Effort|Use ↑\/↓ to move/i.test(
      s,
    )
  )
    return 'picker';
  // Still initialising: the composer is drawn but the TUI drops part of a
  // burst typed now (verified: a 170-char prompt arrived truncated).
  if (
    /model: loading|directory: loading|Booting MCP server|MCP startup/i.test(s)
  )
    return 'starting';
  if (
    /esc to interrupt/i.test(s) &&
    /Working|Running|Booting|Thinking/i.test(s)
  )
    return 'working';
  if (/Ask Codex to do anything/i.test(s)) return 'input';
  return 'unknown';
}

/** TOML basic string with backslashes/quotes escaped. */
function tomlString(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Windows path as TOML literal string key: `projects.'C:\dir'` */
function tomlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export class CodexPtyDriver
  implements
    ProviderDriver,
    ExternalTurnCapableDriver,
    ProviderRecoveryCapableDriver
{
  readonly canResume = true;
  private session: PtySession | null = null;
  private sessionId: string | undefined;
  private hookDir: string | null = null;
  private hookFilePath: string | null = null;
  private hookRelayPath: string | null = null;
  private instructionsPath: string | null = null;
  private rolloutPath: string | undefined;
  private codexExe: { file: string; argsPrefix: string[] } | null = null;
  private lastSystemContext: string | undefined;
  private started = false;
  private hadAcceptedTurn = false;
  private promptAccepted = false;
  /** The prompt `sendMessage` typed, until the TUI accepts it (truncation guard). */
  private typedPrompt: string | null = null;
  private truncatedPrompt: { got: number; typed: number } | null = null;
  private readonly hookTail = new JsonlFileTail(
    () => this.hookFilePath ?? undefined,
  );
  private readonly rolloutTail = new JsonlFileTail(() => this.rolloutPath);
  private lastRolloutScanAt = 0;
  /** When we last typed a chat prompt: the fallback only looks for rollouts
   *  written after it, and only while such a prompt is unanswered. */
  private rolloutExpectedSince = 0;
  private readonly boundRollouts = new Set<string>();
  private readonly observer: CodexTurnObserver;
  private observerTimer: NodeJS.Timeout | null = null;
  private readonly externalEmitter = new EventEmitter();
  private screenMirror: ProviderScreenMirror | null = null;
  /** Latest plain-text screen grid (refreshed each observer tick). */
  private lastScreen: string | null = null;
  /** Old session ids whose `/new` farewell line was already handled. */
  private readonly endedSessions = new Set<string>();

  constructor(private readonly config: CodexPtyDriverConfig) {
    this.observer = new CodexTurnObserver({
      drainHooks: () => this.drainHooks(),
      drainTranscript: async () => {
        if (!this.rolloutPath) this.discoverRollout();
        const { entries, grew } = await this.rolloutTail.drain();
        if (DEBUG && entries.length) {
          dbg(
            'rollout',
            entries.map((e) => {
              const o = isPlainObject(e) ? e : {};
              const p = isPlainObject(o['payload']) ? o['payload'] : {};
              return `${String(o['type'])}:${String(p['type'] ?? p['role'] ?? '')}`;
            }),
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
        this.promptAccepted = true;
        this.hadAcceptedTurn = true;
      },
    });
  }

  // ── ProviderDriver ─────────────────────────────────────────────────────────

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  setSessionId(id: string): void {
    if (this.sessionId === id) return;
    this.stopObserver();
    this.sessionId = id;
    this.rolloutPath = undefined;
    this.rolloutTail.reset(0);
    this.rolloutExpectedSince = 0;
    // The next message resumes it: kill the live TUI (a resume needs a spawn).
    if (this.session?.isAlive()) this.killSession();
  }

  resetSession(): void {
    this.sessionId = undefined;
    this.rolloutPath = undefined;
    this.rolloutTail.reset(0);
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
    for (const f of [this.hookFilePath, this.instructionsPath]) {
      if (f) {
        try {
          unlinkSync(f);
        } catch {
          /* ignore */
        }
      }
    }
    this.hookFilePath = null;
    this.instructionsPath = null;
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
          'Image attachments are not supported by the interactive Codex terminal driver yet. ' +
          'Drop the image, or set AUDITARIA_CODEX_EXEC=1 to use the headless driver.',
      };
      return;
    }
    if (this.lastSystemContext === undefined && systemContext !== undefined) {
      this.lastSystemContext = systemContext;
    }
    const spawnError = await this.ensureSpawned(signal);
    if (spawnError) {
      yield { type: ProviderEventType.Error, message: spawnError };
      return;
    }
    const session = this.session!;
    if (signal.aborted) return;

    // Never type into a dialog: dismiss a picker once, otherwise fail visibly.
    let state = this.screenState();
    if (state === 'picker') {
      await session.writeSystem(ESC);
      await delay(400);
      state = this.screenState();
    }
    if (
      state === 'trust' ||
      state === 'migration' ||
      state === 'login' ||
      state === 'approval' ||
      state === 'picker'
    ) {
      yield {
        type: ProviderEventType.Error,
        message: `Codex's terminal is showing a ${describeState(state)}, so the message was not sent. Answer it in the provider terminal (/provider terminal, or the web terminal) and send again.`,
      };
      return;
    }

    dbg('sendMessage: claiming', {
      prompt: prompt.slice(0, 60),
      active: this.observer.isTurnActive(),
    });
    const claim = this.observer.claimNextTurn(prompt);
    this.promptAccepted = false;
    this.typedPrompt = prompt;
    this.truncatedPrompt = null;
    const isSlash = prompt.trimStart().startsWith('/');
    if (!this.rolloutPath) this.rolloutExpectedSince = Date.now();
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
      // While Codex is visibly busy the prompt sits in its queue: neither
      // resend Enter nor give up.
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
      if (resubmits >= MAX_PROMPT_RESUBMITS) return; // keep waiting until the ceiling
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
              text: `Ran \`${prompt.trim()}\` in Codex's terminal.`,
            };
            yield { type: ProviderEventType.Finished };
            return;
          }
          if (event.reason === 'pty-exit') {
            yield {
              type: ProviderEventType.Error,
              message: `Codex exited (code ${session.exitCode}) before finishing the turn. The next message restarts it.`,
            };
            return;
          }
          if (this.truncatedPrompt) {
            const { got, typed } = this.truncatedPrompt;
            this.truncatedPrompt = null;
            yield {
              type: ProviderEventType.Error,
              message: `Codex received only ${got} of the ${typed} characters typed (its terminal was still initialising), so the turn was cancelled. Send the message again.`,
            };
            return;
          }
          yield {
            type: ProviderEventType.Error,
            message: claim.accepted
              ? 'The turn was interrupted in the provider terminal.'
              : `Codex did not accept the prompt after ${Math.round(PROMPT_ACCEPT_CEILING_MS / 1000)} s. Check the provider terminal (screen: ${this.screenTail(160)}).`,
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
      throw new Error('Codex is not running — send a message to start it.');
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
      this.rolloutPath = undefined;
    }
    this.externalEmitter.emit('notice', {
      kind: 'info',
      text: 'Codex restarted — the next message starts it again.',
    } satisfies ProviderNotice);
  }

  getStatus(): ProviderDriverStatus {
    return {
      ptyAlive: !!this.session?.isAlive(),
      sessionId: this.sessionId,
      turn: this.observer.activeTurn ?? undefined,
      pendingPrompts: 0,
    };
  }

  // ── Spawn ──────────────────────────────────────────────────────────────────

  private async ensureSpawned(signal: AbortSignal): Promise<string | null> {
    if (this.session?.isAlive()) return null;
    this.stopObserver();
    // AUDITARIA_CODEX_PROVIDER: Snapshot the resumed rollout BEFORE spawning.
    // SessionStart then binds the same path without replaying its old turns.
    if (this.sessionId) {
      const { validateCodexSessionId } = await import(
        './codexSessionBrowser.js'
      );
      const { valid, filePath } = await validateCodexSessionId(
        this.config.cwd,
        this.sessionId,
        this.config.codexConfigHome,
      );
      if (valid) {
        this.rolloutPath = filePath;
        this.rolloutExpectedSince = 0;
        await this.rolloutTail.seekToEnd();
      }
    }
    this.ensureHookInfra();
    try {
      writeFileSync(this.hookFilePath!, '');
      this.hookTail.reset(0);
    } catch (e) {
      return `Failed to reset the Codex hook file: ${String(e)}`;
    }
    if (!this.codexExe) {
      const resolved = resolveCodexExecutable();
      if (!resolved) {
        return 'Could not locate the `codex` executable on PATH. Install Codex CLI: npm install -g @openai/codex';
      }
      this.codexExe = resolved;
    }
    const args = [...this.codexExe.argsPrefix, ...this.buildArgs()];
    const mirror = this.config.mirrorPty !== false;
    this.lastScreen = null;
    if (mirror) {
      this.screenMirror ??= new ProviderScreenMirror(PTY_COLS, PTY_ROWS);
      this.screenMirror.reset();
    }
    const session = new PtySession({
      cwd: this.config.cwd,
      cols: PTY_COLS,
      rows: PTY_ROWS,
      env: {
        AUDITARIA_CODEX_HOOK_FILE: this.hookFilePath!,
        ...(this.config.codexConfigHome
          ? { CODEX_HOME: this.config.codexConfigHome }
          : {}),
      },
      mirror,
      mirrorLabel: 'OpenAI Codex',
      onData: (data) => this.screenMirror?.write(data),
    });
    dbg('spawning', { file: this.codexExe.file, args });
    const err = await session.spawn(this.codexExe.file, args);
    if (err) return err;
    this.session = session;
    this.started = false;
    session.onExit((code) => {
      dbg('pty exit', code);
      this.observer.abortCurrentTurn('pty-exit');
      if (this.started) {
        this.externalEmitter.emit('notice', {
          kind: 'error',
          message: `Codex exited (code ${code}). The next message restarts it.`,
        } satisfies ProviderNotice);
      }
    });

    // Readiness: the input prompt, or a dialog the user must answer.
    const readyError = await this.waitForReady(session, signal);
    if (readyError) return readyError;
    this.started = true;
    await this.hookTail.seekToEnd();
    this.startObserver();
    return null;
  }

  private async waitForReady(
    session: PtySession,
    signal: AbortSignal,
  ): Promise<string | null> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let announced: CodexScreenState | null = null;
    let dialogDeadline = 0;
    let trustAnswered = false;
    while (
      Date.now() < deadline ||
      (announced && Date.now() < dialogDeadline)
    ) {
      if (signal.aborted) return 'Aborted while Codex was starting.';
      if (!session.isAlive()) {
        return `Codex exited during startup (code ${session.exitCode}). Terminal: ${this.screenTail(300)}`;
      }
      await this.refreshScreen();
      const state = this.screenState();
      if (state === 'input') {
        // Settle: the composer must stay idle for a moment before we type.
        await delay(700);
        await this.refreshScreen();
        if (this.screenState() !== 'input') continue;
        if (announced) this.emitAttention('end', announced);
        return null;
      }
      if (state === 'trust' && !trustAnswered) {
        // "1. Yes, continue" is the default option: one Enter accepts.
        // Anything still on screen afterwards is announced below.
        trustAnswered = true;
        await delay(300);
        await session.writeSystem('\r');
        await delay(800);
        continue;
      }
      if (
        (state === 'trust' || state === 'migration' || state === 'login') &&
        announced !== state
      ) {
        // Do not answer other dialogs on the user's behalf: announce + hand over.
        if (announced) this.emitAttention('end', announced);
        announced = state;
        dialogDeadline = Date.now() + DIALOG_WAIT_MS;
        this.emitAttention('start', state);
      }
      await delay(250);
    }
    return `Codex did not show its input prompt within ${Math.round(READY_TIMEOUT_MS / 1000)} s. Terminal: ${this.screenTail(300)}`;
  }

  private emitAttention(phase: 'start' | 'end', state: CodexScreenState): void {
    this.externalEmitter.emit('notice', {
      kind: 'attention',
      phase,
      id: `startup:${state}`,
      what: state === 'trust' ? 'trust' : 'dialog',
      detail: phase === 'start' ? describeState(state) : undefined,
    } satisfies ProviderNotice);
  }

  private buildArgs(): string[] {
    const args: string[] = [];
    if (this.sessionId) args.push('resume', this.sessionId);
    if (this.config.model) args.push('-m', this.config.model);
    if (this.config.reasoningEffort) {
      args.push(
        '-c',
        `model_reasoning_effort=${tomlString(this.config.reasoningEffort)}`,
      );
    }
    // Sandbox / approvals: parity with the headless driver's danger-full-access.
    if (process.env['AUDITARIA_CODEX_SANDBOX'] !== '1') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else if (this.config.sandboxMode) {
      args.push('-s', this.config.sandboxMode);
    }
    // Directory trust: Codex keys projects by a canonical form of the path
    // (it persists `c:\users\…` in lowercase, and `\\?\C:\…` elsewhere) and
    // the `-c projects.'…'` override did not match any form we tried
    // (verified), so the dialog is answered at startup instead — the
    // workspace is already trusted by Auditaria's own folder-trust gate, as
    // the Claude driver does with Claude's dialog. The override stays as a
    // harmless hint for versions that honour it.
    args.push(
      '-c',
      `projects.${tomlLiteral(this.config.cwd)}.trust_level="trusted"`,
    );
    // Session-scoped hooks (relay → JSONL file the observer tails).
    args.push('--dangerously-bypass-hook-trust');
    // The command is split on whitespace by Codex's hook executor: an
    // unquoted `C:\Program Files\nodejs\node.exe` ran `C:\Program` and every
    // hook failed with exit code 1 — use quote-free (8.3) paths, else `node`.
    const node = quoteFreePath(process.execPath) ?? 'node';
    const relay = quoteFreePath(this.hookRelayPath!) ?? this.hookRelayPath!;
    for (const event of HOOK_EVENTS) {
      const command = `${node} ${relay} ${event}`;
      args.push(
        '-c',
        `hooks.${event}=[{hooks=[{type="command",command=${tomlString(command)},commandWindows=${tomlString(command)},timeout=20}]}]`,
      );
    }
    // Tool bridge + Auditaria-configured MCP servers, session-scoped.
    if (this.config.toolBridgePort && this.config.toolBridgeScript) {
      const bridgeArgs = [
        this.config.toolBridgeScript,
        '--port',
        String(this.config.toolBridgePort),
      ];
      for (const name of this.config.toolBridgeExclude ?? [])
        bridgeArgs.push('--exclude', name);
      args.push(
        '-c',
        `mcp_servers.auditaria-tools={command=${tomlString(process.execPath)},args=[${bridgeArgs.map(tomlString).join(',')}]}`,
      );
    }
    for (const [name, server] of Object.entries(this.config.mcpServers ?? {})) {
      if (!server.command) continue;
      const parts = [`command=${tomlString(server.command)}`];
      if (server.args?.length)
        parts.push(`args=[${server.args.map(tomlString).join(',')}]`);
      if (server.env && Object.keys(server.env).length) {
        parts.push(
          `env={${Object.entries(server.env)
            .map(([k, v]) => `${tomlString(k)}=${tomlString(String(v))}`)
            .join(',')}}`,
        );
      }
      args.push(
        '-c',
        `mcp_servers.${name.replace(/[^A-Za-z0-9_-]/g, '_')}={${parts.join(',')}}`,
      );
    }
    // System context (audit rules, memory, skills) as the model instructions.
    if (this.lastSystemContext) {
      this.instructionsPath ??= join(this.hookDir!, 'instructions.md');
      writeFileSync(this.instructionsPath, this.lastSystemContext, 'utf8');
      args.push(
        '-c',
        `model_instructions_file=${tomlString(this.instructionsPath)}`,
      );
    }
    return args;
  }

  private ensureHookInfra(): void {
    if (this.hookDir) return;
    this.hookDir = mkdtempSync(join(tmpdir(), 'auditaria-codex-'));
    this.hookFilePath = join(this.hookDir, 'hooks.jsonl');
    this.hookRelayPath = ensureHookRelayScript(
      'codex',
      'AUDITARIA_CODEX_HOOK_FILE',
    );
  }

  /** Type body + CR. Multi-line prompts go as a bracketed paste so the TUI
   *  does not submit at the first newline. Focus-in first: the viewer sends
   *  focus-out when the user clicks away and the TUI then ignores Enter. */
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
      const ev: HookEvent = { event, payload };
      if (ev.event === 'SessionStart') this.bindSession(payload);
      if (ev.event === 'UserPromptSubmit') this.checkTruncation(payload);
      dbg(
        'hook',
        ev.event,
        pickString(payload, 'turn_id')?.slice(0, 8),
        pickString(payload, 'tool_use_id'),
      );
      events.push(ev);
    }
    return events;
  }

  /** The TUI accepted only a strict prefix of what we typed (it drops part
   *  of a burst while still initialising): cancel the garbled turn at once
   *  and say so, instead of letting Codex answer half a prompt. */
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

  /**
   * Without the SessionStart hook (a failing hook command, a hooks-less
   * Codex build) the rollout is still findable: the newest
   * `sessions/YYYY/MM/DD/rollout-*.jsonl` written after our spawn.
   */
  private discoverRollout(): void {
    if (!this.session?.isAlive() || !this.rolloutExpectedSince) return;
    const now = Date.now();
    if (now - this.lastRolloutScanAt < 1_000) return;
    this.lastRolloutScanAt = now;
    const root = join(
      this.config.codexConfigHome ??
        process.env['CODEX_HOME'] ??
        join(homedir(), '.codex'),
      'sessions',
    );
    let newest: { file: string; m: number } | undefined;
    const since = this.rolloutExpectedSince - 2_000;
    // sessions/YYYY/MM/DD/rollout-*.jsonl — only the newest year/month and
    // the two newest days (a session can straddle midnight).
    const newestNames = (dir: string, take: number): string[] => {
      try {
        return readdirSync(dir).sort().reverse().slice(0, take);
      } catch {
        return [];
      }
    };
    for (const year of newestNames(root, 1)) {
      for (const month of newestNames(join(root, year), 1)) {
        for (const day of newestNames(join(root, year, month), 2)) {
          const dir = join(root, year, month, day);
          for (const f of newestNames(dir, 50)) {
            if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
            if (this.boundRollouts.has(join(dir, f))) continue; // never re-bind an old session
            try {
              const m = statSync(join(dir, f)).mtimeMs;
              if (m >= since && (!newest || m > newest.m)) {
                newest = { file: join(dir, f), m };
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
    if (newest) {
      this.rolloutPath = newest.file;
      this.boundRollouts.add(newest.file);
      this.rolloutTail.reset(0);
      this.rolloutExpectedSince = 0;
      dbg('rollout discovered without hooks', newest.file);
    }
  }

  /** SessionStart carries the rollout path: re-arm the tail on it. */
  private bindSession(payload: Record<string, unknown>): void {
    const sessionId = pickString(payload, 'session_id');
    const transcript = pickString(payload, 'transcript_path');
    if (sessionId) this.sessionId = sessionId;
    if (transcript && transcript !== this.rolloutPath) {
      this.rolloutPath = transcript;
      this.boundRollouts.add(transcript);
      this.rolloutExpectedSince = 0;
      this.rolloutTail.reset(0);
      dbg('rollout bound', { session: sessionId?.slice(0, 8), transcript });
    }
  }

  private handleSessionChange(sessionId: string, source: string): void {
    this.sessionId = sessionId;
    this.externalEmitter.emit('notice', {
      kind: 'session',
      source,
      sessionId,
      transcriptPath: this.rolloutPath,
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
        .then(() => this.observer.tick())
        .catch((e) => dbg('observer tick error', e));
    }, OBSERVER_TICK_MS);
  }

  /** Snapshot the current grid from the headless mirror (the alternate-screen
   *  TUI redraws in place, so the raw output tail is NOT the screen). */
  private async refreshScreen(): Promise<void> {
    if (!this.screenMirror) return;
    try {
      this.lastScreen = await this.screenMirror.plainScreen();
    } catch {
      /* keep the previous snapshot */
      return;
    }
    this.detectNewSession(this.lastScreen);
  }

  /** `/new` typed in the terminal fires no hook and writes no file (the next
   *  session's rollout is created lazily at its first prompt); the only
   *  timely witness is the farewell line the TUI prints:
   *  "To continue this session, run codex resume, then select <title> (<id>)". */
  private detectNewSession(screen: string): void {
    const m = screen
      .replace(/\s+/g, ' ')
      .match(/run codex resume, then select[^(]*\(([0-9a-f-]{36})\)/i);
    if (!m) return;
    const endedId = m[1];
    if (this.endedSessions.has(endedId)) return;
    this.endedSessions.add(endedId);
    if (this.observer.isTurnActive()) this.observer.abortCurrentTurn('aborted');
    dbg('session ended in the terminal (/new)', {
      endedId: endedId.slice(0, 8),
    });
    this.sessionId = undefined;
    this.rolloutPath = undefined;
    this.rolloutTail.reset(0);
    this.hadAcceptedTurn = false;
    this.externalEmitter.emit('notice', {
      kind: 'session',
      source: 'clear',
      sessionId: endedId,
    } satisfies ProviderNotice);
  }

  private stopObserver(): void {
    if (this.observerTimer) {
      clearInterval(this.observerTimer);
      this.observerTimer = null;
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

  private screenState(): CodexScreenState {
    const session = this.session;
    if (!session) return 'unknown';
    // Prefer the real grid (headless mirror); headless contexts fall back to
    // the recent raw output, which the TUI's in-place redraws make fuzzy.
    const text = this.lastScreen ?? session.strippedOutput().slice(-4000);
    return classifyCodexScreen(text);
  }

  private screenTail(chars: number): string {
    const grid = (this.lastScreen ?? '').replace(/\s+/g, ' ').trim();
    const text =
      grid ||
      (this.session?.strippedOutput() ?? '').replace(/\s+/g, ' ').trim();
    return text.slice(-chars);
  }
}

function describeState(state: CodexScreenState): string {
  switch (state) {
    case 'trust':
      return 'directory trust dialog';
    case 'migration':
      return 'model migration dialog';
    case 'login':
      return 'login prompt';
    case 'approval':
      return 'command approval dialog';
    case 'picker':
      return 'selection menu';
    default:
      return 'dialog';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
