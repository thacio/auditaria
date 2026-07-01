/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Generic "drive an interactive TUI through a
 * PTY" runner — the shared mechanics every PTY-driven provider needs:
 *
 *   - spawn via node-pty (@lydell/node-pty through utils/getPty)
 *   - rolling recent-output buffer (for readiness scraping / fallbacks)
 *   - PtyWriteQueue for keystroke serialisation (system > cli > web typist)
 *   - registration with providerPtyMirror so the web terminal mirrors the
 *     TUI bidirectionally (opt-in via `mirror` — headless drivers skip it)
 *   - typeSubmit(): atomic prompt-body + pause + CR (Ink/TUI burst-input
 *     heuristics otherwise swallow the CR into the input buffer)
 *   - exit tracking, resize, kill
 *
 * Provider-specific concerns (readiness detection, turn completion,
 * transcript parsing, interactive prompts) stay in each driver. First
 * consumer: CopilotPtyDriver. The Claude driver predates this class and
 * keeps its own battle-tested wiring; it shares the mirror + write queue.
 */

import stripAnsi from 'strip-ansi';
import { getPty } from '../../utils/getPty.js';
import { PtyWriteQueue } from './ptyWriteQueue.js';
import { providerPtyMirror, type PtyMirrorSource } from './ptyMirror.js';

/** Minimal subset of @lydell/node-pty's IPty surface we use. */
export interface MinimalPty {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
  kill(signal?: string): void;
}

export interface PtySessionOptions {
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string | undefined>;
  /** Register with providerPtyMirror so the web terminal mirrors this PTY. */
  mirror?: boolean;
  /** Provider display name for the viewer title (e.g. "GitHub Copilot"). */
  mirrorLabel?: string;
  /** Rolling output buffer cap (default 128 KiB). */
  recentOutputMax?: number;
}

const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;
const DEFAULT_RECENT_MAX = 128 * 1024;
const PROMPT_TYPE_DELAY_MS = 150;

export class PtySession implements PtyMirrorSource {
  private pty: MinimalPty | null = null;
  private queue: PtyWriteQueue | null = null;
  private recent = '';
  private exited = false;
  private exitCodeVal = 0;
  private exitListeners: Array<(exitCode: number) => void> = [];
  // True from kill() until the next spawn(). pty.kill() is asynchronous
  // (onExit lands later, noticeably so on Windows ConPTY) — without this
  // flag, isAlive() reports true for a dying PTY and callers spawn-gate on
  // a corpse (e.g. resetSession() followed immediately by sendMessage()).
  private killRequested = false;

  constructor(private readonly options: PtySessionOptions) {}

  /**
   * Spawn `exe args` inside a fresh PTY. Returns an error message string on
   * failure, or null on success. A previous dead PTY is cleaned up first;
   * spawning over a LIVE PTY kills it (callers normally guard with
   * isAlive()).
   */
  async spawn(exe: string, args: string[]): Promise<string | null> {
    if (this.pty && !this.exited) this.kill();

    const ptyInfo = await getPty();
    if (!ptyInfo) {
      return (
        'node-pty is not available. PTY-driven providers require a PTY ' +
        'backend (@lydell/node-pty or node-pty). On Windows ARM64 install ' +
        'via WSL2 or use the x64 Node build.'
      );
    }

    let pty: MinimalPty;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- node-pty module returns a structurally-compatible IPty
      pty = ptyInfo.module.spawn(exe, args, {
        name: 'xterm-256color',
        cols: this.options.cols ?? DEFAULT_COLS,
        rows: this.options.rows ?? DEFAULT_ROWS,
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env },
        handleFlowControl: true,
      }) as MinimalPty;
    } catch (e) {
      return `Failed to spawn ${exe} in a PTY: ${String(e)}`;
    }

    this.pty = pty;
    this.exited = false;
    this.exitCodeVal = 0;
    this.killRequested = false;
    this.recent = '';
    this.queue = new PtyWriteQueue((bytes) => pty.write(bytes));

    const recentMax = this.options.recentOutputMax ?? DEFAULT_RECENT_MAX;
    pty.onData((data) => {
      this.recent += data;
      if (this.recent.length > recentMax) {
        this.recent = this.recent.slice(this.recent.length - recentMax);
      }
      if (this.options.mirror) providerPtyMirror.emitData(this, data);
    });

    if (this.options.mirror) {
      providerPtyMirror.setActive(this, this.options.mirrorLabel);
    }

    pty.onExit((e) => {
      this.exited = true;
      this.exitCodeVal = e.exitCode ?? 0;
      if (this.options.mirror) providerPtyMirror.setInactive(this);
      for (const cb of this.exitListeners) {
        try {
          cb(this.exitCodeVal);
        } catch {
          /* listener errors must not break the exit path */
        }
      }
    });

    return null;
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }

  isAlive(): boolean {
    return this.pty !== null && !this.exited && !this.killRequested;
  }

  hasExited(): boolean {
    return this.exited;
  }

  get exitCode(): number {
    return this.exitCodeVal;
  }

  onExit(cb: (exitCode: number) => void): () => void {
    this.exitListeners.push(cb);
    return () => {
      this.exitListeners = this.exitListeners.filter((l) => l !== cb);
    };
  }

  /** Raw rolling output buffer (ANSI included). */
  recentOutput(): string {
    return this.recent;
  }

  /** Rolling output with ANSI stripped. */
  strippedOutput(): string {
    return stripAnsi(this.recent);
  }

  /** Clear the rolling buffer (per-turn isolation for scrape heuristics). */
  clearRecentOutput(): void {
    this.recent = '';
  }

  /**
   * Type a prompt into the TUI's input box and submit it: body, brief gap,
   * then CR as a separate write, all under the write-queue gate so a
   * web-typist keystroke can't slip between body and CR.
   */
  async typeSubmit(text: string): Promise<void> {
    const queue = this.queue;
    if (!queue) return;
    await queue.withAtomicBlock(async () => {
      await queue.writeAtomic(text, 'system');
      await new Promise<void>((r) => setTimeout(r, PROMPT_TYPE_DELAY_MS));
      await queue.writeAtomic('\r', 'system');
    });
  }

  /** Highest-priority write (driver-internal keystrokes: Esc, Ctrl+U, …). */
  async writeSystem(bytes: string): Promise<void> {
    await this.queue?.writeAtomic(bytes, 'system');
  }

  /**
   * PtyMirrorSource: web-terminal keystrokes. Lowest priority so they never
   * preempt a typeSubmit burst or a driver response keystroke.
   */
  async writeRawInput(bytes: string): Promise<void> {
    if (!bytes) return;
    await this.queue?.writeAtomic(bytes, 'web-typist');
  }

  /** PtyMirrorSource: viewer geometry change. */
  resize(cols: number, rows: number): void {
    if (!this.pty || this.exited) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      /* PTY died — onExit will tell the mirror */
    }
  }

  /** Write directly, bypassing the queue. For pre-queue rescue paths only. */
  writeUnqueued(bytes: string): void {
    try {
      this.pty?.write(bytes);
    } catch {
      /* ignore */
    }
  }

  kill(): void {
    if (!this.pty) return;
    this.killRequested = true;
    try {
      this.pty.kill();
    } catch {
      /* ignore */
    }
    // Ensure the mirror sees the death even if onExit doesn't fire promptly
    // (kill races onExit on Windows).
    if (this.options.mirror) providerPtyMirror.setInactive(this);
  }
}
