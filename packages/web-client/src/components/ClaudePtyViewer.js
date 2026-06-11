/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Live xterm.js mirror of the Claude PTY.
 *
 * Three display modes, user-driven via the bottom-right ">_" button and
 * the in-header buttons. None of the modes block the chat behind them.
 *
 *   - hidden  : nothing on screen. Data still streams into xterm.js in
 *               the background so reopening doesn't reset the buffer.
 *               The toggle button has a small green pulse when a PTY
 *               is alive so the user knows there's something to look at.
 *   - modal   : 70vw × 70vh centered panel with a click-through dim
 *               backdrop. The chat input below stays visible/usable
 *               (backdrop is `pointer-events: none`).
 *   - pip     : ~560×320 floating window, no backdrop, draggable by
 *               the header. Pin it anywhere and keep working in the
 *               chat behind it.
 *
 * Both the backdrop and the panel are direct children of body so there's
 * no wrapping element with awkward `pointer-events: none` propagation —
 * xterm.js's internal scroll, mouse-wheel, and selection all work
 * naturally inside the panel.
 *
 * Theme: explicit dark palette. Does NOT follow the app theme.
 */

import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-fit';
import { Unicode11Addon } from 'xterm-unicode11';

const MIRROR_BG = '#1e1e1e';
const MIRROR_FG = '#d4d4d4';

const PIP_DEFAULT_WIDTH = 560;
const PIP_DEFAULT_HEIGHT = 320;
const PIP_MIN_WIDTH = 320;
const PIP_MIN_HEIGHT = 180;
const PIP_DEFAULT_X = 24;
const PIP_DEFAULT_Y = 24;

// AUDITARIA_CLAUDE_PROVIDER: persist a tiny blob of viewer state across
// page reloads so the user doesn't have to re-toggle the terminal and
// re-position the PiP every time they refresh.
const STORAGE_KEY = 'auditaria.claudePtyViewer.v1';
function loadViewerState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}
function saveViewerState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota — silently skip */
  }
}

function encodeBytes(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBytes(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// AUDITARIA_CLAUDE_PROVIDER: Ensure xterm's viewport shows a visible
// scrollbar rather than relying on OS overlay scrollbars (which are
// invisible until you scroll). Injected once on first viewer construction.
let scrollbarStyleInjected = false;
function injectXtermScrollbarStyle() {
  if (scrollbarStyleInjected) return;
  scrollbarStyleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .claude-pty-panel .xterm-viewport {
      scrollbar-width: thin;
      scrollbar-color: #555 #1e1e1e;
    }
    .claude-pty-panel .xterm-viewport::-webkit-scrollbar {
      width: 10px;
    }
    .claude-pty-panel .xterm-viewport::-webkit-scrollbar-track {
      background: #1e1e1e;
    }
    .claude-pty-panel .xterm-viewport::-webkit-scrollbar-thumb {
      background: #555;
      border-radius: 5px;
    }
    .claude-pty-panel .xterm-viewport::-webkit-scrollbar-thumb:hover {
      background: #777;
    }
  `;
  document.head.appendChild(style);
}

export class ClaudePtyViewer {
  constructor(wsManager) {
    this.wsManager = wsManager;
    this.toggleButton = null;
    this.backdrop = null;
    this.panel = null;
    this.containerElement = null;
    this.header = null;
    this.pipBtn = null;
    this.expandBtn = null;
    this.closeBtn = null;
    this.activeDot = null;
    this.term = null;
    this.fitAddon = null;
    this.termOpened = false;
    /**
     * Pre-open data buffer. PTY bytes may arrive before the user has
     * clicked the toggle. If we call xterm.open() into a `display:none`
     * container the underlying textarea never becomes a real DOM node and
     * input focus is broken forever after. So we buffer until the panel
     * is genuinely visible, then open + replay.
     */
    this.pendingBytes = '';
    /** @type {'hidden'|'modal'|'pip'} */
    this.mode = 'hidden';
    this.pipPosition = { x: PIP_DEFAULT_X, y: PIP_DEFAULT_Y };
    this.pipSize = { width: PIP_DEFAULT_WIDTH, height: PIP_DEFAULT_HEIGHT };
    // Load persisted state. Mode is restored opportunistically — if it
    // was 'modal' or 'pip', we'll open the panel on construction so a
    // page reload mid-conversation isn't disruptive.
    const persisted = loadViewerState();
    let restoreMode = null;
    if (persisted) {
      if (
        persisted.pipPosition &&
        typeof persisted.pipPosition.x === 'number' &&
        typeof persisted.pipPosition.y === 'number'
      ) {
        this.pipPosition = persisted.pipPosition;
      }
      if (
        persisted.pipSize &&
        typeof persisted.pipSize.width === 'number' &&
        typeof persisted.pipSize.height === 'number'
      ) {
        this.pipSize = {
          width: Math.max(PIP_MIN_WIDTH, persisted.pipSize.width),
          height: Math.max(PIP_MIN_HEIGHT, persisted.pipSize.height),
        };
      }
      if (persisted.mode === 'modal' || persisted.mode === 'pip') {
        restoreMode = persisted.mode;
      }
    }
    this._restoreMode = restoreMode;
    this.ptyActive = false;
    this.dragging = false;
    this.resizing = false;
    this.resizeStart = { x: 0, y: 0, width: 0, height: 0 };
    this.dragOffset = { x: 0, y: 0 };

    injectXtermScrollbarStyle();
    this.initializeToggleButton();
    this.initializeBackdrop();
    this.initializePanel();
    this.initializeResizeHandle();
    this.bindWsEvents();
    this.bindDocumentDragHandlers();

    // Restore the previously persisted mode now that the DOM is ready.
    if (this._restoreMode === 'modal') {
      Promise.resolve().then(() => this.show());
    } else if (this._restoreMode === 'pip') {
      Promise.resolve().then(() => this.enterPip());
    }
  }

  // ─── Toggle button (bottom-right, always visible) ────────────────────

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
      z-index: 10001;
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

  // ─── Click-through dim backdrop ──────────────────────────────────────

  initializeBackdrop() {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'claude-pty-backdrop';
    // pointer-events: none so the chat input behind it stays usable in
    // modal mode. The user closes the panel via the explicit Close button.
    this.backdrop.style.cssText = `
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 9999;
      display: none;
      pointer-events: none;
    `;
    document.body.appendChild(this.backdrop);
  }

  // ─── Panel (fixed-positioned terminal window) ────────────────────────

  initializePanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'claude-pty-panel';
    this.panel.style.cssText = `
      position: fixed;
      background: ${MIRROR_BG};
      border-radius: 8px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.6);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 10000;
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
      flex: 0 0 auto;
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
    this.containerElement.className = 'claude-pty-body';
    // overflow: hidden is correct here — xterm renders into a child
    // .xterm-viewport which has its own scroll handling (we styled its
    // scrollbar above so it's visible).
    this.containerElement.style.cssText = `
      flex: 1 1 auto;
      min-height: 0;
      background: ${MIRROR_BG};
      padding: 8px;
      overflow: hidden;
    `;

    this.panel.appendChild(this.header);
    this.panel.appendChild(this.containerElement);
    document.body.appendChild(this.panel);

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

    // AUDITARIA_CLAUDE_PROVIDER: Any click on the body area re-focuses
    // xterm — its hidden textarea sometimes loses focus to surrounding
    // page handlers when the modal first opens, and the user's only
    // visual cue would be that nothing types.
    this.containerElement.addEventListener('mousedown', () => {
      this.term?.focus();
    });
    // Re-focus when clicking anywhere on the panel chrome too (except
    // buttons — those handle themselves).
    this.panel.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      this.term?.focus();
    });
  }

  // ─── Layout switching ────────────────────────────────────────────────

  applyModalLayout() {
    this.panel.style.width = '70vw';
    this.panel.style.height = '70vh';
    this.panel.style.left = '50%';
    this.panel.style.top = '50%';
    this.panel.style.transform = 'translate(-50%, -50%)';
    this.header.style.cursor = 'default';
    this.pipBtn.style.display = '';
    this.expandBtn.style.display = 'none';
    this.backdrop.style.display = 'block';
    if (this.resizeHandle) this.resizeHandle.style.display = 'none';
    this.refit();
  }

  applyPipLayout() {
    this.panel.style.width = `${this.pipSize.width}px`;
    this.panel.style.height = `${this.pipSize.height}px`;
    this.panel.style.left = `${this.pipPosition.x}px`;
    this.panel.style.top = `${this.pipPosition.y}px`;
    this.panel.style.transform = 'none';
    this.header.style.cursor = 'move';
    this.pipBtn.style.display = 'none';
    this.expandBtn.style.display = '';
    this.backdrop.style.display = 'none';
    if (this.resizeHandle) this.resizeHandle.style.display = 'block';
    this.refit();
  }

  refit() {
    if (!this.term || !this.fitAddon) return;
    requestAnimationFrame(() => {
      try {
        this.fitAddon.fit();
      } catch {
        /* container not yet sized */
      }
    });
  }

  // ─── Mode controls ───────────────────────────────────────────────────

  toggle() {
    if (this.mode === 'hidden') {
      this.show();
    } else {
      this.hide();
    }
  }

  show() {
    this.mode = 'modal';
    // Panel must be visible BEFORE xterm.open() so the container has a
    // real layout — otherwise xterm's hidden textarea never enters the
    // DOM and input is dead forever after.
    this.panel.style.display = 'flex';
    this.applyModalLayout();
    this.ensureTerminalOpen();
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
    this.persistState();
  }

  enterPip() {
    if (this.mode === 'hidden') {
      this.show();
    }
    this.mode = 'pip';
    this.panel.style.display = 'flex';
    this.applyPipLayout();
    this.ensureTerminalOpen();
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
    this.persistState();
  }

  exitPip() {
    this.mode = 'modal';
    this.applyModalLayout();
    this.ensureTerminalOpen();
    requestAnimationFrame(() => {
      this.refit();
      this.term?.focus();
    });
    this.persistState();
  }

  hide() {
    this.mode = 'hidden';
    this.persistState();
    this.panel.style.display = 'none';
    this.backdrop.style.display = 'none';
  }

  // ─── PiP drag ────────────────────────────────────────────────────────

  bindDocumentDragHandlers() {
    this.header.addEventListener('mousedown', (e) => {
      if (this.mode !== 'pip') return;
      if (e.target.closest('button')) return;
      this.dragging = true;
      const rect = this.panel.getBoundingClientRect();
      this.dragOffset.x = e.clientX - rect.left;
      this.dragOffset.y = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (this.dragging) {
        const w = this.pipSize.width;
        const h = this.pipSize.height;
        const x = Math.max(
          0,
          Math.min(window.innerWidth - w, e.clientX - this.dragOffset.x),
        );
        const y = Math.max(
          0,
          Math.min(window.innerHeight - h, e.clientY - this.dragOffset.y),
        );
        this.pipPosition.x = x;
        this.pipPosition.y = y;
        this.panel.style.left = `${x}px`;
        this.panel.style.top = `${y}px`;
      } else if (this.resizing) {
        const dx = e.clientX - this.resizeStart.x;
        const dy = e.clientY - this.resizeStart.y;
        const width = Math.max(
          PIP_MIN_WIDTH,
          Math.min(
            window.innerWidth - this.pipPosition.x,
            this.resizeStart.width + dx,
          ),
        );
        const height = Math.max(
          PIP_MIN_HEIGHT,
          Math.min(
            window.innerHeight - this.pipPosition.y,
            this.resizeStart.height + dy,
          ),
        );
        this.pipSize.width = width;
        this.pipSize.height = height;
        this.panel.style.width = `${width}px`;
        this.panel.style.height = `${height}px`;
        this.refit();
      }
    });
    document.addEventListener('mouseup', () => {
      if (this.dragging || this.resizing) {
        this.dragging = false;
        this.resizing = false;
        this.persistState();
      }
    });
  }

  /**
   * Add a 14×14 grip square at the bottom-right of the panel that the
   * user can drag to resize in PiP mode. Hidden in modal mode (the
   * fixed centred sizing handles itself there).
   */
  initializeResizeHandle() {
    this.resizeHandle = document.createElement('div');
    this.resizeHandle.className = 'claude-pty-resize-handle';
    this.resizeHandle.title = 'Drag to resize';
    this.resizeHandle.style.cssText = `
      position: absolute;
      bottom: 0;
      right: 0;
      width: 14px;
      height: 14px;
      cursor: nwse-resize;
      background: linear-gradient(
        135deg,
        transparent 0%,
        transparent 50%,
        #555 50%,
        #555 60%,
        transparent 60%,
        transparent 70%,
        #555 70%,
        #555 80%,
        transparent 80%
      );
      z-index: 2;
      display: none;
    `;
    this.resizeHandle.addEventListener('mousedown', (e) => {
      if (this.mode !== 'pip') return;
      this.resizing = true;
      const rect = this.panel.getBoundingClientRect();
      this.resizeStart = {
        x: e.clientX,
        y: e.clientY,
        width: rect.width,
        height: rect.height,
      };
      e.preventDefault();
      e.stopPropagation();
    });
    this.panel.appendChild(this.resizeHandle);
  }

  persistState() {
    saveViewerState({
      mode: this.mode,
      pipPosition: this.pipPosition,
      pipSize: this.pipSize,
    });
  }

  // ─── xterm + WS plumbing ─────────────────────────────────────────────

  /**
   * Create the xterm.js instance (no DOM mount yet). Safe to call even
   * while the panel is hidden.
   */
  ensureTerminalCreated() {
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
      /* unicode11 optional */
    }
    // onData fires whenever the underlying textarea sees a keystroke.
    // We attach this BEFORE open() so any racy initial keys don't get
    // dropped on the floor.
    this.term.onData((data) => {
      this.wsManager.send({
        type: 'claude_pty_input',
        bytes: encodeBytes(data),
      });
    });

    // AUDITARIA_CLAUDE_PROVIDER: When xterm's geometry changes (FitAddon
    // ran on a layout shift, user dragged the modal corner one day,
    // viewer was just opened in a different mode), tell the server-side
    // PTY about the new cols×rows so Claude redraws to fit. Without
    // this, lines wrap at the server-pinned 200 cols and overflow /
    // misalign in the smaller xterm — the classic "resize garbage"
    // discussed in xtermjs/xterm.js#1914 and #3584. Debounce 200ms to
    // dodge the resize race that creates duplicate prompt lines on
    // rapid drags.
    let resizeTimer = null;
    this.term.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        this.wsManager.send({
          type: 'claude_pty_resize',
          cols,
          rows,
        });
      }, 200);
    });
  }

  /**
   * Mount the xterm.js instance into the (now visible) container. Only
   * call when the panel is `display: flex` so the container has a
   * computed layout — otherwise xterm's internal sizing pass produces a
   * 0×0 viewport and the hidden textarea never becomes focusable.
   */
  ensureTerminalOpen() {
    this.ensureTerminalCreated();
    if (this.termOpened) return;
    try {
      this.term.open(this.containerElement);
      this.termOpened = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ClaudePtyViewer] xterm.open failed:', err);
      return;
    }
    try {
      this.fitAddon.fit();
    } catch {
      /* container might not be sized yet */
    }
    // Replay any data that arrived while we were hidden.
    if (this.pendingBytes) {
      try {
        this.term.write(this.pendingBytes);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ClaudePtyViewer] replay write failed:', err);
      }
      this.pendingBytes = '';
    }
  }

  bindWsEvents() {
    this.wsManager.addEventListener('claude_pty_state', (e) => {
      this.ptyActive = !!(e.detail && e.detail.active);
      if (this.activeDot) {
        this.activeDot.style.display = this.ptyActive ? 'block' : 'none';
      }
    });
    this.wsManager.addEventListener('claude_pty_data', (e) => {
      if (!e.detail || typeof e.detail.bytes !== 'string') return;
      let decoded = '';
      try {
        decoded = decodeBytes(e.detail.bytes);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ClaudePtyViewer] decode error:', err);
        return;
      }
      // Always also keep a buffer copy so a *later* show() can replay
      // what arrived while hidden. Bounded by xterm's scrollback after
      // open(); pre-open we cap manually.
      if (!this.termOpened) {
        this.pendingBytes += decoded;
        const cap = 256 * 1024;
        if (this.pendingBytes.length > cap) {
          this.pendingBytes = this.pendingBytes.slice(
            this.pendingBytes.length - cap,
          );
        }
        return;
      }
      try {
        this.term.write(decoded);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[ClaudePtyViewer] write failed:', err);
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
    for (const node of [this.toggleButton, this.backdrop, this.panel]) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
  }
}
