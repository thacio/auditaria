/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Live xterm.js mirror of the Claude PTY.
 *
 * Three display modes the user can flip between at any time, independent
 * of whether a Claude PTY is currently alive:
 *
 *   - hidden  : nothing on screen. The data stream still arrives and
 *               feeds xterm.js if the terminal was ever opened (so the
 *               buffer stays current even while hidden), and the toggle
 *               button shows a small "active" pulse when a PTY is alive.
 *   - modal   : full-screen centred panel with a dark backdrop.
 *   - pip     : small floating window, no backdrop, draggable by the
 *               header. Pin it anywhere on screen and keep working in
 *               the chat behind it.
 *
 * A bottom-right floating button lets the user cycle hidden → modal,
 * and inside the panel itself live buttons for "PiP" (shrink/float) and
 * "Expand" (restore from PiP) and "Close" (hide).
 *
 * Theme: explicit dark palette. Does NOT follow the app theme — a TUI
 * built for a dark terminal renders unreadably on a light surface.
 */

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-fit';
import { Unicode11Addon } from 'xterm-unicode11';

const MIRROR_BG = '#1e1e1e';
const MIRROR_FG = '#d4d4d4';

// PiP window geometry. Modest defaults; future work could let the user
// resize the corners.
const PIP_WIDTH = 560;
const PIP_HEIGHT = 320;
const PIP_DEFAULT_X = 24;
const PIP_DEFAULT_Y = 24;

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
    this.toggleButton = null;
    this.modal = null;
    this.panel = null; // inner panel — the thing we resize/drag
    this.containerElement = null;
    this.header = null;
    this.pipBtn = null;
    this.expandBtn = null;
    this.closeBtn = null;
    this.activeDot = null;
    this.term = null;
    this.fitAddon = null;
    /** @type {'hidden'|'modal'|'pip'} */
    this.mode = 'hidden';
    this.pipPosition = { x: PIP_DEFAULT_X, y: PIP_DEFAULT_Y };
    this.ptyActive = false;
    this.dragging = false;
    this.dragOffset = { x: 0, y: 0 };

    this.initializeToggleButton();
    this.initializeModal();
    this.bindWsEvents();
    this.bindDocumentDragHandlers();
  }

  // ─── Toggle button ────────────────────────────────────────────────────

  initializeToggleButton() {
    const btn = document.createElement('button');
    btn.className = 'claude-pty-toggle';
    btn.title = 'Toggle Claude terminal (>_)';
    btn.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: #1e1e1e;
      border: 2px solid #444;
      color: #d4d4d4;
      cursor: pointer;
      font-family: Menlo, Consolas, monospace;
      font-weight: bold;
      font-size: 16px;
      z-index: 9998;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      transition: transform 0.12s ease, background-color 0.12s ease;
    `;
    btn.textContent = '>_';
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'scale(1.06)';
      btn.style.background = '#2a2a2a';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'scale(1)';
      btn.style.background = '#1e1e1e';
    });
    btn.addEventListener('click', () => this.toggle());

    // Small "pulsing dot" indicator that lights up when a Claude PTY is alive.
    const dot = document.createElement('span');
    dot.className = 'claude-pty-active-dot';
    dot.style.cssText = `
      position: absolute;
      top: 4px;
      right: 4px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #4caf50;
      box-shadow: 0 0 6px #4caf50;
      display: none;
    `;
    btn.appendChild(dot);
    this.activeDot = dot;

    document.body.appendChild(btn);
    this.toggleButton = btn;
  }

  // ─── Modal/panel structure ────────────────────────────────────────────

  initializeModal() {
    // The outer modal is the backdrop. We hide it in PiP mode.
    this.modal = document.createElement('div');
    this.modal.className = 'claude-pty-modal';
    this.modal.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      z-index: 10000;
      display: none;
      align-items: center;
      justify-content: center;
    `;

    // The inner panel — geometry of this is what changes between
    // modal mode (centered, large) and PiP mode (small, floating).
    this.panel = document.createElement('div');
    this.panel.style.cssText = `
      background: ${MIRROR_BG};
      border-radius: 8px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      transition: width 0.12s ease, height 0.12s ease;
    `;

    this.header = document.createElement('div');
    this.header.className = 'claude-pty-header';
    this.header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: #111;
      color: #ddd;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      user-select: none;
      cursor: default;
    `;
    this.header.innerHTML = `
      <span style="font-weight: 600;">Claude Terminal</span>
      <span class="cpy-hint" style="opacity: 0.6; font-size: 11px;">
        keystrokes go directly to the Claude PTY
      </span>
      <div style="display: flex; gap: 6px;">
        <button class="cpy-btn cpy-pip" style="
          background: transparent;
          border: 1px solid #444;
          color: #ddd;
          border-radius: 4px;
          padding: 2px 10px;
          cursor: pointer;
          font-size: 12px;
        ">PiP</button>
        <button class="cpy-btn cpy-expand" style="
          background: transparent;
          border: 1px solid #444;
          color: #ddd;
          border-radius: 4px;
          padding: 2px 10px;
          cursor: pointer;
          font-size: 12px;
          display: none;
        ">Expand</button>
        <button class="cpy-btn cpy-close" style="
          background: transparent;
          border: 1px solid #444;
          color: #ddd;
          border-radius: 4px;
          padding: 2px 10px;
          cursor: pointer;
          font-size: 12px;
        ">Close</button>
      </div>
    `;

    this.containerElement = document.createElement('div');
    this.containerElement.style.cssText = `
      flex: 1 1 auto;
      background: ${MIRROR_BG};
      padding: 8px;
      overflow: hidden;
    `;

    this.panel.appendChild(this.header);
    this.panel.appendChild(this.containerElement);
    this.modal.appendChild(this.panel);
    document.body.appendChild(this.modal);

    this.pipBtn = this.header.querySelector('.cpy-pip');
    this.expandBtn = this.header.querySelector('.cpy-expand');
    this.closeBtn = this.header.querySelector('.cpy-close');

    this.pipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.enterPip();
    });
    this.expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exitPip();
    });
    this.closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hide();
    });

    // Backdrop click closes only in modal mode (not when we've collapsed
    // the backdrop for PiP).
    this.modal.addEventListener('click', (e) => {
      if (this.mode === 'modal' && e.target === this.modal) {
        this.hide();
      }
    });

    // Apply the default layout for modal mode.
    this.applyModalLayout();
  }

  // ─── Layout switching ─────────────────────────────────────────────────

  applyModalLayout() {
    this.panel.style.position = 'static';
    this.panel.style.left = '';
    this.panel.style.top = '';
    this.panel.style.width = 'min(95vw, 1200px)';
    this.panel.style.height = 'min(85vh, 800px)';
    this.modal.style.background = 'rgba(0,0,0,0.65)';
    this.modal.style.pointerEvents = 'auto';
    this.modal.style.alignItems = 'center';
    this.modal.style.justifyContent = 'center';
    this.header.style.cursor = 'default';
    this.pipBtn.style.display = '';
    this.expandBtn.style.display = 'none';
    this.refit();
  }

  applyPipLayout() {
    // Tear away from the centred flex layout: anchor the panel absolutely
    // and zero the backdrop. The OUTER modal still hosts the panel so all
    // event wiring is unchanged.
    this.panel.style.position = 'fixed';
    this.panel.style.left = `${this.pipPosition.x}px`;
    this.panel.style.top = `${this.pipPosition.y}px`;
    this.panel.style.width = `${PIP_WIDTH}px`;
    this.panel.style.height = `${PIP_HEIGHT}px`;
    this.modal.style.background = 'transparent';
    this.modal.style.pointerEvents = 'none';
    this.panel.style.pointerEvents = 'auto';
    this.header.style.cursor = 'move';
    this.pipBtn.style.display = 'none';
    this.expandBtn.style.display = '';
    this.refit();
  }

  refit() {
    // FitAddon needs the container to have a settled size; defer.
    if (!this.term || !this.fitAddon) return;
    requestAnimationFrame(() => {
      try {
        this.fitAddon.fit();
      } catch {
        /* container not laid out yet */
      }
    });
  }

  // ─── Public mode controls ────────────────────────────────────────────

  toggle() {
    if (this.mode === 'hidden') {
      this.show();
    } else {
      this.hide();
    }
  }

  show() {
    this.ensureTerminal();
    this.mode = 'modal';
    this.applyModalLayout();
    this.modal.style.display = 'flex';
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
  }

  enterPip() {
    if (this.mode === 'hidden') this.show();
    this.mode = 'pip';
    this.applyPipLayout();
    this.modal.style.display = 'flex';
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
  }

  exitPip() {
    this.mode = 'modal';
    this.applyModalLayout();
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
  }

  hide() {
    this.mode = 'hidden';
    this.modal.style.display = 'none';
  }

  // ─── Drag handling for PiP mode ───────────────────────────────────────

  bindDocumentDragHandlers() {
    this.header.addEventListener('mousedown', (e) => {
      if (this.mode !== 'pip') return;
      // Don't start a drag if the user clicked a button inside the header.
      if (e.target.closest('button')) return;
      this.dragging = true;
      const rect = this.panel.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const x = Math.max(
        0,
        Math.min(window.innerWidth - PIP_WIDTH, e.clientX - this.dragOffset.x),
      );
      const y = Math.max(
        0,
        Math.min(
          window.innerHeight - PIP_HEIGHT,
          e.clientY - this.dragOffset.y,
        ),
      );
      this.pipPosition.x = x;
      this.pipPosition.y = y;
      this.panel.style.left = `${x}px`;
      this.panel.style.top = `${y}px`;
    });
    document.addEventListener('mouseup', () => {
      this.dragging = false;
    });
  }

  // ─── xterm + WS plumbing ─────────────────────────────────────────────

  ensureTerminal() {
    if (this.term) return;
    this.term = new Terminal({
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
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
      // unicode11 is optional.
    }
    this.term.open(this.containerElement);
    try {
      this.fitAddon.fit();
    } catch {
      /* container might not be sized yet */
    }
    this.term.onData((data) => {
      this.wsManager.send({
        type: 'claude_pty_input',
        bytes: encodeBytes(data),
      });
    });
  }

  bindWsEvents() {
    // claude_pty_state controls the toggle-button indicator only — the
    // viewer's own visibility is driven by the user clicking the button.
    this.wsManager.addEventListener('claude_pty_state', (e) => {
      this.ptyActive = !!(e.detail && e.detail.active);
      if (this.activeDot) {
        this.activeDot.style.display = this.ptyActive ? 'block' : 'none';
      }
    });
    // PTY data is fed into xterm.js whether the viewer is visible or not,
    // so opening the viewer mid-turn shows the current screen with no
    // catch-up dance (plus the late-joiner snapshot the server replays
    // already covers refresh).
    this.wsManager.addEventListener('claude_pty_data', (e) => {
      if (!e.detail || typeof e.detail.bytes !== 'string') return;
      this.ensureTerminal();
      try {
        this.term.write(decodeBytes(e.detail.bytes));
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ClaudePtyViewer] decode error:', err);
      }
    });
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
    if (this.toggleButton && this.toggleButton.parentNode) {
      this.toggleButton.parentNode.removeChild(this.toggleButton);
    }
    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}
