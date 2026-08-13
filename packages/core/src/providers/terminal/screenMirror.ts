/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Server-side "screen oracle" for the provider
 * terminal mirror — the engine behind the web viewer's "Live screen" mode.
 *
 * Why: Claude Code's TUI has an inline-mode redraw leak that emits duplicated
 * frames (anthropics/claude-code#49086, #51828 — reproduces across emulators
 * and platforms, so no PTY/terminal swap fixes it; see memory
 * terminal-backend.md). Replaying the raw byte stream into the web viewer's
 * xterm.js therefore accumulates the duplicates forever in its scrollback.
 *
 * The fix: let a HEADLESS terminal absorb the raw stream server-side. A
 * terminal's *visible grid* always converges to the correct screen — the TUI
 * repaints it every frame — while duplication only pollutes scrollback
 * history, which this terminal is configured not to keep (scrollback: 0).
 * The viewer then renders serialized snapshots of that grid instead of the
 * raw stream: whatever garbage the TUI emits, the mirror always shows what a
 * real terminal's screen would show.
 *
 * Uses @xterm/headless (already a core dependency, same engine as
 * shellExecutionService) + @xterm/addon-serialize (ANSI-string snapshots the
 * client xterm.js can just write()).
 */

import xtermHeadlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';

const { Terminal } = xtermHeadlessPkg;
// @xterm/addon-serialize ships UMD/CJS; interop differs between direct node
// (named export on the namespace) and bundlers. Resolve both shapes.
const SerializeAddon =
  (serializePkg as { SerializeAddon?: unknown }).SerializeAddon ??
  (serializePkg as unknown);

export const SCREEN_MIRROR_DEFAULT_COLS = 200;
export const SCREEN_MIRROR_DEFAULT_ROWS = 50;

interface SerializeAddonLike {
  serialize(options?: { scrollback?: number }): string;
  dispose(): void;
}

export class ProviderScreenMirror {
  private term: InstanceType<typeof Terminal>;
  private serializeAddon: SerializeAddonLike;
  private disposed = false;

  constructor(
    cols: number = SCREEN_MIRROR_DEFAULT_COLS,
    rows: number = SCREEN_MIRROR_DEFAULT_ROWS,
  ) {
    this.term = new Terminal({
      cols,
      rows,
      // Viewport-only by design: duplicated frames scroll off the top and
      // are discarded instead of accumulating.
      scrollback: 0,
      allowProposedApi: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- UMD interop; structurally an ITerminalAddon
    const addon = new (SerializeAddon as new () => SerializeAddonLike)();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion, @typescript-eslint/no-explicit-any -- headless ITerminalAddon structural match
    this.term.loadAddon(addon as any);
    this.serializeAddon = addon;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** Feed raw PTY bytes. Parsing is asynchronous; snapshot() sequences after. */
  write(bytes: string): void {
    if (this.disposed) return;
    this.term.write(bytes);
  }

  /**
   * Clear everything (new PTY / provider switch). Sent through the write
   * queue as RIS (ESC c) — a synchronous term.reset() would run BEFORE
   * still-queued bytes finish parsing, and those bytes would then
   * resurrect after the reset (xterm parses writes asynchronously).
   */
  reset(): void {
    if (this.disposed) return;
    this.term.write('\x1bc');
  }

  /** Keep geometry in lock-step with the real PTY (viewer-driven resize). */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(2, Math.floor(rows));
    if (c === this.term.cols && r === this.term.rows) return;
    this.term.resize(c, r);
  }

  /**
   * Serialize the CURRENT screen (viewport only) to an ANSI string that
   * reproduces it when written to a fresh/reset xterm.js. Resolved after all
   * previously written bytes have been parsed (xterm parses asynchronously —
   * an empty write's callback is the ordering barrier).
   */
  snapshot(): Promise<string> {
    if (this.disposed) return Promise.resolve('');
    return new Promise((resolve) => {
      this.term.write('', () => {
        try {
          resolve(this.serializeAddon.serialize({ scrollback: 0 }));
        } catch {
          resolve('');
        }
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.serializeAddon.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.term.dispose();
    } catch {
      /* ignore */
    }
  }
}
