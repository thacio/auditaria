/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_PROVIDER_TERMINAL: live mirror of a provider CLI's PTY (Claude,
// Copilot, …) to the web terminal viewer.

import type { WebSocket } from 'ws';
import {
  providerPtyMirror,
  ProviderScreenMirror,
} from '@google/gemini-cli-core';
import { webTerminalBridge } from '../../webTerminalBridge.js';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import { readNumber, readString } from '../protocol.js';

/** Recent raw output replayed to late joiners so xterm.js can redraw. */
const REPLAY_BUFFER_MAX = 64 * 1024;

/**
 * Trailing-edge throttle for "Live screen" snapshots: bursts of PTY output
 * collapse into one serialize + broadcast per window.
 */
const SNAPSHOT_THROTTLE_MS = 80;

const toBase64 = (text: string): string =>
  Buffer.from(text, 'utf-8').toString('base64');

/**
 * Fans the provider PTY out to web clients in two representations:
 *
 *  - `provider_pty_data`: the raw byte stream (base64 so control bytes
 *    survive JSON), plus a ring buffer replayed to late joiners;
 *  - `provider_screen_data`: viewport snapshots from a headless terminal
 *    (`ProviderScreenMirror`) — the "Live screen" mode that is immune to
 *    Claude Code's inline-mode redraw duplication, which lives in
 *    scrollback the oracle never keeps.
 *
 * Inbound: keystrokes and resizes from the viewer go straight to the PTY;
 * `provider_pty_refresh` re-sends both representations to ONE client
 * (a broadcast replay would append duplicate history into every other
 * raw-mode viewer).
 *
 * Also keeps `webTerminalBridge` informed so CLI hooks can route Claude's
 * AskUserQuestion to the web terminal instead of the modal.
 */
export class ProviderTerminalFeature extends WebFeature {
  readonly name = 'provider-terminal';

  private active = false;
  private label: string | undefined;
  private replayBuffer = '';
  private screenMirror: ProviderScreenMirror | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];

  protected onAttach(ctx: WebFeatureContext): void {
    // Seed from the mirror: the PTY may already be alive when the web
    // interface starts (e.g. `/web` mid-session).
    this.active = providerPtyMirror.isActive();
    this.label = providerPtyMirror.getActiveLabel();
    this.screenMirror = new ProviderScreenMirror();

    this.unsubscribers.push(
      providerPtyMirror.onData((bytes) => this.handlePtyData(bytes)),
      providerPtyMirror.onActive((isActive) => this.handlePtyActive(isActive)),
      ctx.clients.onConnected(() => this.syncClientCount()),
      ctx.clients.onDisconnected(() => this.syncClientCount()),
    );

    webTerminalBridge.setOpenTerminalHandler(() => {
      this.broadcast('provider_pty_open', {});
    });
    this.syncClientCount();

    ctx.inbound.on('provider_pty_input', (message) => {
      const bytes = readString(message, 'bytes');
      if (bytes === undefined) return;
      try {
        const decoded = Buffer.from(bytes, 'base64').toString('utf-8');
        void providerPtyMirror.writeInput(decoded);
      } catch {
        /* swallow malformed payload */
      }
    });

    ctx.inbound.on('provider_pty_resize', (message) => {
      const cols = readNumber(message, 'cols');
      const rows = readNumber(message, 'rows');
      if (cols === undefined || rows === undefined) return;
      providerPtyMirror.resize(cols, rows);
      // Keep the screen oracle in lock-step with the real PTY, else the
      // snapshots wrap at the wrong width.
      this.screenMirror?.resize(cols, rows);
      this.scheduleSnapshot();
    });

    ctx.inbound.on('provider_pty_refresh', (_message, ws) => this.refresh(ws));
  }

  protected onDetach(): void {
    for (const unsubscribe of this.unsubscribers) {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
    }
    this.unsubscribers = [];
    this.active = false;
    this.label = undefined;
    this.replayBuffer = '';
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.screenMirror?.dispose();
    this.screenMirror = null;
    // Server down → CLI hooks fall back to the modal.
    webTerminalBridge.setOpenTerminalHandler(null);
    webTerminalBridge.setClientCount(0);
  }

  /**
   * Late-joiner snapshot: the active flag always (so the viewer can show or
   * hide), then the raw replay and a fresh screen snapshot when alive.
   */
  override sendInitialState(ws: WebSocket): void {
    this.send(ws, 'provider_pty_state', {
      active: this.active,
      label: this.label,
    });
    if (!this.active) return;
    if (this.replayBuffer.length > 0) {
      this.send(ws, 'provider_pty_data', {
        bytes: toBase64(this.replayBuffer),
      });
    }
    this.sendScreenSnapshot(ws);
  }

  private syncClientCount(): void {
    webTerminalBridge.setClientCount(this.ctx?.clients.size ?? 0);
  }

  private handlePtyData(bytes: string): void {
    this.replayBuffer += bytes;
    if (this.replayBuffer.length > REPLAY_BUFFER_MAX) {
      this.replayBuffer = this.replayBuffer.slice(-REPLAY_BUFFER_MAX);
    }
    this.broadcast('provider_pty_data', { bytes: toBase64(bytes) });
    // Feed the oracle ALWAYS so the grid stays current even with no clients;
    // broadcasting snapshots is throttled and client-gated.
    this.screenMirror?.write(bytes);
    this.scheduleSnapshot();
  }

  private handlePtyActive(isActive: boolean): void {
    this.active = isActive;
    this.label = providerPtyMirror.getActiveLabel();
    if (!isActive) {
      // PTY died — a new turn must start clean.
      this.replayBuffer = '';
    }
    // Either transition means a different PTY owns the screen next.
    this.screenMirror?.reset();
    this.broadcast('provider_pty_state', {
      active: isActive,
      label: this.label,
    });
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.broadcastSnapshot();
    }, SNAPSHOT_THROTTLE_MS);
  }

  private async broadcastSnapshot(): Promise<void> {
    const mirror = this.screenMirror;
    const ctx = this.ctx;
    if (!mirror || !this.active || !ctx || ctx.clients.size === 0) return;
    const snapshot = await mirror.snapshot();
    this.broadcast('provider_screen_data', {
      snapshot: toBase64(snapshot),
      cols: mirror.cols,
      rows: mirror.rows,
    });
  }

  /** Async (headless parse barrier) — the socket is checked on delivery. */
  private sendScreenSnapshot(ws: WebSocket): void {
    const mirror = this.screenMirror;
    if (!mirror) return;
    void mirror.snapshot().then((snapshot) => {
      this.send(ws, 'provider_screen_data', {
        snapshot: toBase64(snapshot),
        cols: mirror.cols,
        rows: mirror.rows,
      });
    });
  }

  /** Viewer asks for a fresh paint (mode toggle, panel reopen). Unicast. */
  private refresh(ws: WebSocket): void {
    if (!this.active) return;
    if (this.replayBuffer.length > 0) {
      this.send(ws, 'provider_pty_data', {
        bytes: toBase64(this.replayBuffer),
      });
    }
    this.sendScreenSnapshot(ws);
  }
}
