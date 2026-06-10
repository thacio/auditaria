/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Live xterm.js mirror of the Claude PTY.
 *
 * Subscribes to `claude_pty_state` and `claude_pty_data` WebSocket events.
 * When the server reports the Claude PTY is active (a turn is running):
 *
 *   - mounts an xterm.js Terminal inside a modal overlay
 *   - feeds it raw bytes (base64-decoded) so all VT100/xterm escape
 *     sequences are emulated correctly (cursor positioning, alt-buffer,
 *     full-screen redraws — none of which the legacy ANSI->HTML modal
 *     gets right for Claude's Ink-based TUI)
 *   - forwards every keystroke back to the server as `claude_pty_input`
 *     (also base64) so the user can drive Claude directly
 *
 * When the server reports inactive (turn ended), tears the terminal down.
 *
 * Theme: explicit dark palette. Does NOT follow the app theme — a TUI
 * meant for a dark terminal renders unreadable text on a light surface.
 */

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-fit';
import { Unicode11Addon } from 'xterm-unicode11';

const MIRROR_BG = '#1e1e1e';
const MIRROR_FG = '#d4d4d4';

function encodeBytes(str) {
  // Use the page's btoa via TextEncoder so multi-byte chars survive intact.
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBytes(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

export class ClaudePtyViewer {
  constructor(wsManager) {
    this.wsManager = wsManager;
    this.modal = null;
    this.containerElement = null;
    this.term = null;
    this.fitAddon = null;
    this.isVisible = false;
    this.initializeModal();
    this.bindWsEvents();
  }

  initializeModal() {
    this.modal = document.createElement('div');
    this.modal.className = 'claude-pty-modal';
    this.modal.style.display = 'none';
    this.modal.style.position = 'fixed';
    this.modal.style.inset = '0';
    this.modal.style.background = 'rgba(0,0,0,0.65)';
    this.modal.style.zIndex = '10000';
    this.modal.style.alignItems = 'center';
    this.modal.style.justifyContent = 'center';
    this.modal.innerHTML = `
      <div style="
        width: min(95vw, 1200px);
        height: min(85vh, 800px);
        background: ${MIRROR_BG};
        border-radius: 8px;
        box-shadow: 0 12px 48px rgba(0,0,0,0.6);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      ">
        <div style="
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 14px;
          background: #111;
          color: #ddd;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 13px;
        ">
          <span style="font-weight: 600;">Claude Terminal</span>
          <span style="opacity: 0.6; font-size: 11px;">
            keystrokes go directly to the Claude PTY
          </span>
          <button id="claude-pty-close" style="
            background: transparent;
            border: 1px solid #444;
            color: #ddd;
            border-radius: 4px;
            padding: 2px 10px;
            cursor: pointer;
            font-size: 12px;
          ">Close</button>
        </div>
        <div id="claude-pty-content" style="
          flex: 1 1 auto;
          background: ${MIRROR_BG};
          padding: 8px;
          overflow: hidden;
        "></div>
      </div>
    `;
    document.body.appendChild(this.modal);
    this.containerElement = this.modal.querySelector('#claude-pty-content');
    this.modal.querySelector('#claude-pty-close').addEventListener('click', () => {
      // Closing only hides the modal locally — the PTY keeps running so
      // the user can reopen via reconnect/snapshot if needed. To actually
      // kill the PTY they should abort the turn from the chat UI.
      this.hide();
    });
  }

  bindWsEvents() {
    this.wsManager.addEventListener('claude_pty_state', (e) => {
      const active = !!(e.detail && e.detail.active);
      if (active) {
        this.show();
      } else {
        this.hide();
      }
    });
    this.wsManager.addEventListener('claude_pty_data', (e) => {
      if (!this.term || !e.detail || typeof e.detail.bytes !== 'string') return;
      try {
        const decoded = decodeBytes(e.detail.bytes);
        this.term.write(decoded);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ClaudePtyViewer] decode error:', err);
      }
    });
  }

  ensureTerminal() {
    if (this.term) return;
    this.term = new Terminal({
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      // Pin to the same geometry the driver pins on the PTY (200x50).
      // FitAddon will adjust if the layout supports more — but the driver
      // doesn't yet forward resize, so this matches at boot.
      cols: 200,
      rows: 50,
      scrollback: 5000,
      theme: {
        background: MIRROR_BG,
        foreground: MIRROR_FG,
        cursor: MIRROR_FG,
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    try {
      const u11 = new Unicode11Addon();
      this.term.loadAddon(u11);
      this.term.unicode.activeVersion = '11';
    } catch {
      // unicode11 is optional — emoji widths will be slightly off without
      // it but everything else works.
    }
    this.term.open(this.containerElement);
    try {
      this.fitAddon.fit();
    } catch {
      /* container might not be sized yet */
    }

    // Forward every keystroke as base64-encoded raw bytes.
    this.term.onData((data) => {
      this.wsManager.send({
        type: 'claude_pty_input',
        bytes: encodeBytes(data),
      });
    });
  }

  show() {
    this.ensureTerminal();
    this.modal.style.display = 'flex';
    this.isVisible = true;
    // Refit on each show in case the container resized while hidden.
    requestAnimationFrame(() => {
      try {
        this.fitAddon.fit();
      } catch {
        /* ignore */
      }
      this.term.focus();
    });
  }

  hide() {
    this.modal.style.display = 'none';
    this.isVisible = false;
  }

  destroy() {
    this.hide();
    if (this.term) {
      try {
        this.term.dispose();
      } catch {
        /* ignore */
      }
      this.term = null;
      this.fitAddon = null;
    }
  }
}
