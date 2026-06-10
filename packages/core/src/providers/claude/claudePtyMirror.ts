/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: PTY broadcast bus for the web-terminal mirror.
 *
 * The Claude driver spawns a fresh PTY per turn, drives `claude` interactively
 * inside it, and tears it down after Stop. This module turns that ordinarily-
 * private PTY into a publish/subscribe surface so any consumer (today: the
 * web client via WebInterfaceService) can mirror the live TUI bidirectionally:
 *
 *   data direction:
 *     pty.onData -> driver -> claudePtyMirror.emitData(bytes)
 *                                ↘ (web client renders into xterm.js)
 *
 *   input direction:
 *     web client keystroke -> claudePtyMirror.writeInput(bytes)
 *                                ↘ driver.writeRawInput -> PtyWriteQueue -> pty.write
 *
 * Lifecycle hooks (`active` event) let consumers show/hide their viewer in
 * lockstep with the actual PTY existing. We deliberately use a free-standing
 * EventEmitter rather than the broader CoreEvent bus so the surface is
 * minimal and the merge footprint with upstream gemini-cli stays nil.
 *
 * Single-typist coordination is NOT enforced here — the queue inside the
 * driver already serialises writes by priority, so simultaneous CLI and web
 * input will interleave but won't tear individual key sequences.
 */

import { EventEmitter } from 'node:events';

export interface ClaudePtyMirrorEvents {
  /** Raw PTY output bytes (UTF-8 string from node-pty's onData). */
  data: [string];
  /**
   * Becomes true when a driver registers (PTY spawned + ready for input)
   * and false when it deregisters (PTY exited or driver disposed).
   */
  active: [boolean];
}

/**
 * Minimal interface the driver presents to the mirror. Kept narrow so the
 * mirror doesn't depend on the full ClaudeCLIDriver type (would create a
 * cycle).
 */
export interface ClaudePtyMirrorSource {
  /** Push raw bytes into the active PTY's stdin. */
  writeRawInput(bytes: string): Promise<void>;
}

class ClaudePtyMirror extends EventEmitter {
  private currentSource: ClaudePtyMirrorSource | null = null;
  private currentActive = false;

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

  /** Whether a PTY is currently registered (i.e. a Claude turn is alive). */
  isActive(): boolean {
    return this.currentActive;
  }

  /**
   * Called by the driver immediately after `pty.spawn(...)` returns. Marks
   * the mirror as active and stores the driver handle for routing inbound
   * keystrokes.
   */
  setActive(source: ClaudePtyMirrorSource): void {
    // If a previous driver didn't deregister cleanly (crash / abort), flush
    // it now so we don't keep writing into a dead PTY.
    if (this.currentSource && this.currentSource !== source) {
      this.currentSource = null;
    }
    this.currentSource = source;
    if (!this.currentActive) {
      this.currentActive = true;
      this.emit('active', true);
    }
  }

  /**
   * Called by the driver on PTY exit / kill / dispose. Drops the source
   * reference and emits `active: false` exactly once.
   */
  setInactive(source: ClaudePtyMirrorSource): void {
    // Guard against the driver-being-replaced case: only deactivate if the
    // CURRENT source is the one calling.
    if (this.currentSource !== source) return;
    this.currentSource = null;
    if (this.currentActive) {
      this.currentActive = false;
      this.emit('active', false);
    }
  }

  /** Driver pushes new bytes from pty.onData. No-op if no listeners. */
  emitData(bytes: string): void {
    if (!bytes) return;
    this.emit('data', bytes);
  }

  /**
   * Web client (or any external consumer) pushes keystrokes into the active
   * PTY. Silently drops if no PTY is active — between turns there's
   * nothing to write to.
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
}

/**
 * Singleton instance shared across the process. Imported by the Claude
 * driver (publisher) and by WebInterfaceService (subscriber).
 */
export const claudePtyMirror = new ClaudePtyMirror();
