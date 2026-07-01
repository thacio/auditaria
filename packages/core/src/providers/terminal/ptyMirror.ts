/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_PROVIDER_TERMINAL: Provider-agnostic PTY broadcast bus for the
 * web-terminal mirror.
 *
 * Generalized from the original Claude-only `claudePtyMirror`. Any PTY-driven
 * provider driver (Claude, Copilot, and later Codex/agy) registers its live
 * PTY here so consumers (today: the web client via WebInterfaceService) can
 * mirror the interactive TUI bidirectionally:
 *
 *   data direction:
 *     pty.onData -> driver -> providerPtyMirror.emitData(source, bytes)
 *                                ↘ (web client renders into xterm.js)
 *
 *   input direction:
 *     web client keystroke -> providerPtyMirror.writeInput(bytes)
 *                                ↘ driver.writeRawInput -> PtyWriteQueue -> pty.write
 *
 * Only ONE source is mirrored at a time (the main session's active provider).
 * `emitData` is source-guarded: bytes from a PTY that is not the current
 * source are dropped, so a stray driver (sub-agent session, Teams thread,
 * a corpse that missed its onExit) can never interleave output into the
 * viewer. Drivers spawned for headless contexts should not register at all —
 * they pass `mirrorPty: false` in their config and skip the mirror entirely.
 *
 * Lifecycle (`active` event) lets consumers show/hide their viewer in
 * lockstep with the PTY existing. `label` carries a human-readable provider
 * name ("Claude Code", "GitHub Copilot") for the viewer's title bar.
 *
 * Free-standing EventEmitter (not the CoreEvent bus) to keep the surface
 * minimal and the upstream merge footprint nil.
 */

import { EventEmitter } from 'node:events';

/**
 * Minimal interface a driver presents to the mirror. Kept narrow so the
 * mirror doesn't depend on any concrete driver type (would create cycles).
 */
export interface PtyMirrorSource {
  /** Push raw bytes into the active PTY's stdin. */
  writeRawInput(bytes: string): Promise<void>;
  /**
   * Resize the underlying PTY's cols×rows. Required so the web terminal
   * can match the TUI's rendering to its actual viewport — without it the
   * server-side pinned geometry spills outside the smaller xterm and lines
   * misalign.
   */
  resize?(cols: number, rows: number): void;
}

class ProviderPtyMirror extends EventEmitter {
  private currentSource: PtyMirrorSource | null = null;
  private currentActive = false;
  private currentLabel: string | undefined = undefined;

  /** Subscribe to PTY output. Returns the unsubscribe function. */
  onData(listener: (bytes: string) => void): () => void {
    this.on('data', listener);
    return () => this.off('data', listener);
  }

  /** Subscribe to active-state changes (true on spawn, false on exit). */
  onActive(listener: (active: boolean) => void): () => void {
    this.on('active', listener);
    return () => this.off('active', listener);
  }

  /** Whether a PTY is currently registered (a provider turn/session is alive). */
  isActive(): boolean {
    return this.currentActive;
  }

  /** Human-readable name of the active provider ("Claude Code", "GitHub Copilot"). */
  getActiveLabel(): string | undefined {
    return this.currentActive ? this.currentLabel : undefined;
  }

  /**
   * Called by a driver immediately after its PTY spawn. Marks the mirror as
   * active and stores the driver handle for routing inbound keystrokes.
   * A newer registration displaces an older one (crash / abort that missed
   * its deregister) — the old source's emitData calls are dropped from then
   * on by the source guard.
   */
  setActive(source: PtyMirrorSource, label?: string): void {
    if (this.currentSource && this.currentSource !== source) {
      this.currentSource = null;
    }
    this.currentSource = source;
    this.currentLabel = label;
    if (!this.currentActive) {
      this.currentActive = true;
      this.emit('active', true);
    } else {
      // Already active but the source/label changed — re-emit so viewers
      // refresh their title.
      this.emit('active', true);
    }
  }

  /**
   * Called by a driver on PTY exit / kill / dispose. Only deactivates when
   * the CURRENT source is the one calling (a displaced driver can't tear
   * down its replacement).
   */
  setInactive(source: PtyMirrorSource): void {
    if (this.currentSource !== source) return;
    this.currentSource = null;
    this.currentLabel = undefined;
    if (this.currentActive) {
      this.currentActive = false;
      this.emit('active', false);
    }
  }

  /**
   * Driver pushes new bytes from pty.onData. Source-guarded: bytes from a
   * driver that is not the registered source are dropped so two live PTYs
   * can never interleave in the viewer.
   */
  emitData(source: PtyMirrorSource, bytes: string): void {
    if (!bytes) return;
    if (this.currentSource !== source) return;
    this.emit('data', bytes);
  }

  /**
   * Web client (or any external consumer) pushes keystrokes into the active
   * PTY. Silently drops if no PTY is active.
   */
  async writeInput(bytes: string): Promise<void> {
    if (!this.currentSource || !bytes) return;
    try {
      await this.currentSource.writeRawInput(bytes);
    } catch {
      // PTY died between active check and write — drop silently. A
      // subsequent `active: false` event will tell consumers to clean up.
    }
  }

  /** Forward a viewer-side cols×rows change to the active PTY. */
  resize(cols: number, rows: number): void {
    if (!this.currentSource || !this.currentSource.resize) return;
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols < 1 || rows < 1) return;
    try {
      this.currentSource.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      /* PTY died between active check and resize — drop silently. */
    }
  }
}

/**
 * Singleton instance shared across the process. Imported by PTY-driven
 * provider drivers (publishers) and by WebInterfaceService (subscriber).
 */
export const providerPtyMirror = new ProviderPtyMirror();
