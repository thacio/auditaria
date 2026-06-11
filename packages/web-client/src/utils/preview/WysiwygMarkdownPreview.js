/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: WYSIWYG markdown preview (TCU document editor)

import { BasePreview } from './BasePreview.js';
import { showErrorToast } from '../../components/Toast.js';

/**
 * WYSIWYG Markdown Preview
 *
 * A Word-like editor for .md files, available when the docx parser skill is
 * installed (and its binary supports the AST flags). It reuses the proven
 * editor modules ported from the tcu-writing spike (./wysiwyg/) and keeps ALL
 * markdown syntax knowledge in the Python parser:
 *
 *   load:  Monaco buffer .md  --(md_to_ast_request)-->  AST  --> editor
 *   save:  editor AST  --(ast_to_md_request)-->  .md  --> Monaco buffer
 *
 * The Monaco model stays the source of truth — Ctrl+S saves the model as
 * usual. Conversions are async server round-trips, so they are debounced and
 * guarded against the echo loop:
 *
 * - `applyingToModel` is set while the WYSIWYG writes model.setValue(); any
 *   render()/model-change triggered by that write is ignored.
 * - `lastSetValue` remembers the exact model text the editor agrees with;
 *   render() calls carrying that text are no-ops.
 * - External edits (Monaco typing, file auto-reload) reload the WYSIWYG via
 *   a debounced md->AST round-trip — unless the WYSIWYG itself has pending
 *   unsaved changes (last writer wins).
 *
 * Round-tripping is canonical, not byte-identical (md_ast normalizes like
 * Prettier), so comparisons are always against `lastSetValue`, never against
 * the user's original text.
 *
 * @extends BasePreview
 */

const SAVE_BACK_DEBOUNCE_MS = 700;
const EXTERNAL_RELOAD_DEBOUNCE_MS = 500;
const STATUS_FADE_MS = 2500;

export class WysiwygMarkdownPreview extends BasePreview {
  constructor() {
    super();

    // Lazily-loaded editor modules (TipTap comes from the CDN import map,
    // so nothing is fetched until the first actual WYSIWYG render).
    this.editorModules = null;
    this.editorModulesPromise = null;

    // Active editor session (one at a time — previews are singletons)
    this.session = null;

    // Mount sequencing: invalidates in-flight async mounts
    this.mountSeq = 0;
    this.mounting = null; // { path, container, token }

    // Echo-loop guard: true while the WYSIWYG writes into the Monaco model
    this.applyingToModel = false;
  }

  canPreview(language, filename) {
    const isMarkdown =
      language === 'markdown' ||
      filename.toLowerCase().endsWith('.md') ||
      filename.toLowerCase().endsWith('.markdown');

    const em = this.settings && this.settings.editorManager;
    return isMarkdown && !!(em && em.isWysiwygAvailable());
  }

  getType() {
    return 'wysiwyg-markdown';
  }

  getName() {
    return 'WYSIWYG Editor';
  }

  getSecurityLevel() {
    return 'safe';
  }

  /**
   * Higher than the marked.js markdown preview (100) so the WYSIWYG wins
   * whenever the parser is installed; marked.js remains the fallback.
   */
  getPriority() {
    return 150;
  }

  isLoaded() {
    return true;
  }

  /**
   * Load the ported editor modules on first use
   */
  loadEditorModules() {
    if (this.editorModules) {
      return Promise.resolve(this.editorModules);
    }
    if (this.editorModulesPromise) {
      return this.editorModulesPromise;
    }

    this.editorModulesPromise = Promise.all([
      import('./wysiwyg/editor-core.js'),
      import('./wysiwyg/ui.js'),
    ])
      .then(([core, ui]) => {
        this.editorModules = {
          createDocEditor: core.createDocEditor,
          closePopover: ui.closePopover,
        };
        this.editorModulesPromise = null;
        return this.editorModules;
      })
      .catch((error) => {
        this.editorModulesPromise = null;
        throw error;
      });

    return this.editorModulesPromise;
  }

  /**
   * Render entry point. Called by PreviewManager:
   * - on mode switch (Preview/Split) and file open/switch
   * - on EVERY Monaco keystroke while in Split mode (no upstream debounce)
   * Must therefore be cheap and guarded for the common no-op cases.
   */
  render(content, container, options = {}) {
    const em = this.settings && this.settings.editorManager;
    if (!em) {
      this.showError(container, 'WYSIWYG editor is not wired to the editor manager.');
      return;
    }

    const path = options.filePath || options.filename || '';

    // Same file already mounted in this container → treat as buffer update
    if (
      this.session &&
      this.session.path === path &&
      this.session.container === container &&
      container.contains(this.session.root)
    ) {
      this.handleExternalText(content);
      return;
    }

    // Same mount already in progress → let it finish (post-mount reconcile
    // picks up any buffer changes that happened meanwhile)
    if (
      this.mounting &&
      this.mounting.path === path &&
      this.mounting.container === container
    ) {
      return;
    }

    // Different file (or first render): tear down and mount fresh
    this.teardownSession({ flushPending: true });
    void this.mountEditor(content, container, { ...options, path });
  }

  /**
   * Mount a new editor session for `path` (async: spec + AST round-trips)
   */
  async mountEditor(content, container, options) {
    const em = this.settings.editorManager;
    const token = ++this.mountSeq;
    this.mounting = { path: options.path, container, token };

    container.innerHTML = '';
    container.className = 'preview-container wysiwyg-preview-container';
    this.showLoading(container, 'Loading WYSIWYG editor…');

    let modules, spec, ast;
    try {
      [modules, spec] = await Promise.all([
        this.loadEditorModules(),
        em.requestAstSpec(),
      ]);
      ast = await em.requestMdToAst(content);
    } catch (error) {
      if (token === this.mountSeq) {
        this.mounting = null;
        this.showError(
          container,
          `Failed to load the WYSIWYG editor: ${error.message}`,
        );
      }
      return;
    }

    // A newer mount/teardown superseded us while awaiting
    if (token !== this.mountSeq) {
      return;
    }
    this.mounting = null;

    // Build the DOM the editor factory expects
    container.innerHTML = '';
    const root = document.createElement('div');
    root.className = 'wysiwyg-preview-root';

    const ribbonWrap = document.createElement('div');
    ribbonWrap.className = 'wys-ribbon-wrap';
    const ribbonRow = document.createElement('div');
    ribbonRow.style.display = 'flex';
    ribbonRow.style.alignItems = 'stretch';
    const ribbonEl = document.createElement('div');
    ribbonEl.className = 'wys-ribbon';
    ribbonEl.style.flex = '1';
    ribbonEl.setAttribute('role', 'toolbar');
    const commentsToggle = document.createElement('button');
    commentsToggle.className = 'wys-comments-toggle';
    commentsToggle.textContent = '💬';
    commentsToggle.title = 'Painel de comentários';

    // Zoom controls (- 100% +)
    const zoomWrap = document.createElement('div');
    zoomWrap.className = 'wys-zoom';
    const zoomOut = document.createElement('button');
    zoomOut.className = 'wys-zoom-btn';
    zoomOut.textContent = '−';
    zoomOut.title = 'Diminuir zoom (Ctrl+roda do mouse)';
    const zoomLabel = document.createElement('button');
    zoomLabel.className = 'wys-zoom-label';
    zoomLabel.title = 'Restaurar zoom (100%)';
    const zoomIn = document.createElement('button');
    zoomIn.className = 'wys-zoom-btn';
    zoomIn.textContent = '+';
    zoomIn.title = 'Aumentar zoom (Ctrl+roda do mouse)';
    zoomWrap.appendChild(zoomOut);
    zoomWrap.appendChild(zoomLabel);
    zoomWrap.appendChild(zoomIn);

    // Maximize toggle (host-provided — expands the editor panel)
    let maximizeBtn = null;
    if (this.settings.onToggleMaximize) {
      maximizeBtn = document.createElement('button');
      maximizeBtn.className = 'wys-comments-toggle wys-maximize-btn';
      maximizeBtn.title = 'Maximizar / restaurar o painel do editor';
      const isMax = this.settings.isMaximized && this.settings.isMaximized();
      maximizeBtn.innerHTML = `<span class="codicon codicon-${isMax ? 'screen-normal' : 'screen-full'}"></span>`;
      maximizeBtn.addEventListener('click', () => {
        const nowMax = this.settings.onToggleMaximize();
        maximizeBtn.innerHTML = `<span class="codicon codicon-${nowMax ? 'screen-normal' : 'screen-full'}"></span>`;
      });
    }

    ribbonRow.appendChild(ribbonEl);
    ribbonRow.appendChild(zoomWrap);
    if (maximizeBtn) {
      ribbonRow.appendChild(maximizeBtn);
    }
    ribbonRow.appendChild(commentsToggle);
    const tableRibbonEl = document.createElement('div');
    tableRibbonEl.className = 'wys-table-ribbon ribbon-context';
    tableRibbonEl.hidden = true;
    ribbonWrap.appendChild(ribbonRow);
    ribbonWrap.appendChild(tableRibbonEl);

    const main = document.createElement('div');
    main.className = 'wys-main';
    const canvas = document.createElement('div');
    canvas.className = 'wys-canvas';
    const page = document.createElement('div');
    page.className = 'wys-page';
    const editorElement = document.createElement('div');
    editorElement.className = 'wys-editor';
    page.appendChild(editorElement);
    canvas.appendChild(page);

    // Comments review panel (hidden until toggled or a comment is focused)
    const commentsPanel = document.createElement('aside');
    commentsPanel.className = 'wys-comments-panel';
    commentsPanel.hidden = true;
    const cpResize = document.createElement('div');
    cpResize.className = 'cp-resize';
    cpResize.title = 'Arraste para redimensionar';
    const cpHead = document.createElement('div');
    cpHead.className = 'cp-head';
    const cpTitle = document.createElement('span');
    cpTitle.textContent = 'Comentários';
    const cpClose = document.createElement('button');
    cpClose.className = 'wys-cp-close';
    cpClose.title = 'Fechar';
    cpClose.textContent = '✕';
    cpHead.appendChild(cpTitle);
    cpHead.appendChild(cpClose);
    const cpAuthor = document.createElement('label');
    cpAuthor.className = 'cp-author';
    cpAuthor.appendChild(document.createTextNode('Você '));
    const cpAuthorInput = document.createElement('input');
    cpAuthorInput.value = 'Revisor';
    cpAuthor.appendChild(cpAuthorInput);
    const cpBody = document.createElement('div');
    cpBody.className = 'wys-cp-body';
    commentsPanel.appendChild(cpResize);
    commentsPanel.appendChild(cpHead);
    commentsPanel.appendChild(cpAuthor);
    commentsPanel.appendChild(cpBody);

    main.appendChild(canvas);
    main.appendChild(commentsPanel);

    const statusEl = document.createElement('div');
    statusEl.className = 'wys-status';

    root.appendChild(ribbonWrap);
    root.appendChild(main);
    root.appendChild(statusEl);
    container.appendChild(root);

    const session = {
      path: options.path,
      container,
      root,
      statusEl,
      commentsPanel,
      commentsToggle,
      page,
      zoomLabel,
      zoom: 100,
      api: null,
      model: null,
      modelSub: null,
      lastSetValue: content,
      pendingChanges: false,
      saveTimer: null,
      reloadTimer: null,
      statusTimer: null,
      saveSeq: 0,
      keydownHandler: null,
      docMouseMove: null,
      docMouseUp: null,
    };

    // Zoom: buttons, label reset, and Ctrl+wheel on the canvas
    this.applyZoom(session, this.getStoredZoom());
    zoomIn.addEventListener('click', () => this.applyZoom(session, session.zoom + 10));
    zoomOut.addEventListener('click', () => this.applyZoom(session, session.zoom - 10));
    zoomLabel.addEventListener('click', () => this.applyZoom(session, 100));
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.applyZoom(session, session.zoom + (e.deltaY < 0 ? 10 : -10));
      },
      { passive: false },
    );

    const showCommentsPanel = (on) => {
      commentsPanel.hidden = !on;
      commentsToggle.classList.toggle('on', on);
    };
    commentsToggle.addEventListener('click', () =>
      showCommentsPanel(commentsPanel.hidden),
    );
    cpClose.addEventListener('click', () => showCommentsPanel(false));

    // Comments panel resize (drag the left edge)
    let dragging = false;
    let startX = 0;
    let startW = 0;
    cpResize.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = commentsPanel.offsetWidth;
      e.preventDefault();
    });
    session.docMouseMove = (e) => {
      if (!dragging) return;
      commentsPanel.style.flexBasis =
        Math.max(220, Math.min(620, startW + (startX - e.clientX))) + 'px';
    };
    session.docMouseUp = () => {
      dragging = false;
    };
    document.addEventListener('mousemove', session.docMouseMove);
    document.addEventListener('mouseup', session.docMouseUp);

    // Create the editor (the factory is the spike's public API — unchanged)
    try {
      session.api = modules.createDocEditor({
        editorElement,
        ribbonEl,
        tableRibbonEl,
        spec,
        notify: (msg, kind) => this.showStatus(session, msg, kind),
        uploadImage: null, // v1: image insertion via URL/path dialog only
        onChange: () => this.scheduleSaveBack(session),
        commentsPanelEl: cpBody,
        getReviewer: () => cpAuthorInput.value.trim() || 'Revisor',
        onCommentFocus: () => showCommentsPanel(true),
      });
      session.api.setAst(ast);
    } catch (error) {
      this.showError(container, `Failed to start the WYSIWYG editor: ${error.message}`);
      return;
    }

    // setAst fires the editor's onUpdate → a save-back got scheduled for the
    // initial content load. Cancel it: nothing user-made changed yet.
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }
    session.pendingChanges = false;

    // Subscribe to the Monaco model so external changes (typing in Split
    // mode, file auto-reload, AI collaborative writing) reach the WYSIWYG
    // in ANY view mode — render() is not re-invoked in Preview-only mode.
    const fileInfo = em.openFiles.get(options.path);
    if (fileInfo && fileInfo.model) {
      session.model = fileInfo.model;
      session.modelSub = fileInfo.model.onDidChangeContent(() => {
        if (this.applyingToModel) return;
        if (this.session !== session) return;
        this.handleExternalText(session.model.getValue());
      });
    }

    // Ctrl+S inside the WYSIWYG: flush pending edits to the buffer, then save
    session.keydownHandler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        void this.flushThenSave(session);
      }
    };
    root.addEventListener('keydown', session.keydownHandler, true);

    this.session = session;

    // Reconcile: the buffer may have changed while the mount was in flight
    if (session.model) {
      const current = session.model.getValue();
      if (current !== session.lastSetValue) {
        this.handleExternalText(current);
      }
    }

    this.emit('preview-loaded', {
      type: 'wysiwyg-markdown',
      contentSize: content.length,
    });
  }

  /**
   * Buffer text changed from outside the WYSIWYG (or render() re-invoked).
   * Skips echoes and debounces a md→AST reload.
   */
  handleExternalText(text) {
    const session = this.session;
    if (!session || !session.api) return;
    if (this.applyingToModel) return;
    if (text === session.lastSetValue) return;

    // The WYSIWYG has unsaved edits of its own — let its save-back win.
    // (Real conflicts here mean simultaneous edits on both sides; the
    // WYSIWYG is where the user is actively typing.)
    if (session.pendingChanges) return;

    if (session.reloadTimer) {
      clearTimeout(session.reloadTimer);
    }
    session.reloadTimer = setTimeout(() => {
      session.reloadTimer = null;
      void this.reloadFromText(session, text);
    }, EXTERNAL_RELOAD_DEBOUNCE_MS);
  }

  /**
   * Reload the WYSIWYG from buffer text (external change path)
   */
  async reloadFromText(session, _initialText) {
    const em = this.settings.editorManager;
    if (this.session !== session || !session.api) return;

    // Use the freshest buffer text at conversion time
    const text = session.model ? session.model.getValue() : _initialText;
    if (text === session.lastSetValue || session.pendingChanges) return;

    try {
      const ast = await em.requestMdToAst(text);
      if (this.session !== session || !session.api) return;
      if (session.pendingChanges) return; // user started typing meanwhile
      session.api.setAst(ast);
      // setAst triggers onChange → cancel the spurious save-back
      if (session.saveTimer) {
        clearTimeout(session.saveTimer);
        session.saveTimer = null;
      }
      session.pendingChanges = false;
      session.lastSetValue = text;
    } catch (error) {
      this.showStatus(session, `Falha ao recarregar: ${error.message}`, 'err');
    }
  }

  /**
   * Editor content changed → debounce a save-back into the Monaco buffer
   */
  scheduleSaveBack(session) {
    if (!session.api) return; // destroyed session
    session.pendingChanges = true;
    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
    }
    session.saveTimer = setTimeout(() => {
      session.saveTimer = null;
      void this.doSaveBack(session);
    }, SAVE_BACK_DEBOUNCE_MS);
  }

  /**
   * Convert the editor AST to markdown and write it into the Monaco model.
   * Marks the file dirty (via Monaco's change event) — that is desired.
   */
  async doSaveBack(session) {
    const em = this.settings.editorManager;
    if (this.session !== session || !session.api) return;
    if (!session.pendingChanges) return;

    const seq = ++session.saveSeq;

    let ast;
    try {
      ast = session.api.getAst(); // synchronous
    } catch (error) {
      this.showStatus(session, `Falha ao serializar: ${error.message}`, 'err');
      return;
    }

    let md;
    try {
      md = await em.requestAstToMd(ast);
    } catch (error) {
      this.showStatus(session, `Falha ao converter para .md: ${error.message}`, 'err');
      return;
    }

    // A newer save-back superseded this one, or the session died meanwhile
    if (this.session !== session || seq !== session.saveSeq) return;

    this.applyToModel(session, md);
    if (seq === session.saveSeq && !session.saveTimer) {
      session.pendingChanges = false;
    }
  }

  /**
   * Write markdown into the Monaco model behind the echo-loop guard
   */
  applyToModel(session, md) {
    const model = session.model;
    if (!model || (model.isDisposed && model.isDisposed())) return;

    if (md === model.getValue()) {
      session.lastSetValue = md;
      return;
    }

    this.applyingToModel = true;
    try {
      model.setValue(md);
      // Read back post-EOL-normalization: Monaco may convert \n to the
      // model's EOL, and the guard compares against model.getValue()
      session.lastSetValue = model.getValue();
    } finally {
      setTimeout(() => {
        this.applyingToModel = false;
      }, 0);
    }
  }

  /**
   * Ctrl+S: flush pending WYSIWYG edits into the buffer, then save the file
   */
  async flushThenSave(session) {
    const em = this.settings.editorManager;
    if (this.session !== session) return;

    if (session.saveTimer) {
      clearTimeout(session.saveTimer);
      session.saveTimer = null;
    }

    if (session.pendingChanges && session.api) {
      const seq = ++session.saveSeq;
      try {
        const ast = session.api.getAst();
        const md = await em.requestAstToMd(ast);
        if (this.session === session && seq === session.saveSeq) {
          this.applyToModel(session, md);
          session.pendingChanges = false;
        }
      } catch (error) {
        this.showStatus(session, `Falha ao salvar: ${error.message}`, 'err');
        return; // do not save a stale buffer
      }
    }

    void em.saveFile(session.path);
  }

  /**
   * Best-effort flush used on teardown (file switch / preview switch).
   * Captures the AST synchronously, then converts and writes asynchronously —
   * the Monaco model outlives the editor DOM, so this is safe after destroy.
   */
  flushPendingOnTeardown(session) {
    const em = this.settings.editorManager;
    if (!session.pendingChanges || !session.api || !session.model) return;

    let ast;
    try {
      ast = session.api.getAst();
    } catch {
      return;
    }
    session.pendingChanges = false;

    const model = session.model;
    em.requestAstToMd(ast)
      .then((md) => {
        if (model.isDisposed && model.isDisposed()) return;
        if (md === model.getValue()) return;
        this.applyingToModel = true;
        try {
          model.setValue(md);
          // If this model's file is currently mounted again (rapid switch
          // back), keep its guard in sync
          if (this.session && this.session.model === model) {
            this.session.lastSetValue = model.getValue();
          }
        } finally {
          setTimeout(() => {
            this.applyingToModel = false;
          }, 0);
        }
      })
      .catch(() => {
        showErrorToast('WYSIWYG: failed to write pending changes to the buffer');
      });
  }

  /**
   * Last zoom level the user picked (persisted across sessions)
   */
  getStoredZoom() {
    try {
      const v = parseInt(localStorage.getItem('auditaria-wysiwyg-zoom'), 10);
      if (v >= 50 && v <= 200) return v;
    } catch {
      /* localStorage unavailable */
    }
    return 100;
  }

  /**
   * Apply a zoom percentage (50–200) to the document page
   */
  applyZoom(session, pct) {
    const zoom = Math.max(50, Math.min(200, Math.round(pct / 10) * 10));
    session.zoom = zoom;
    if (session.page) {
      // CSS zoom keeps layout + scrollbars correct (unlike transform: scale)
      session.page.style.zoom = zoom / 100;
    }
    if (session.zoomLabel) {
      session.zoomLabel.textContent = `${zoom}%`;
    }
    try {
      localStorage.setItem('auditaria-wysiwyg-zoom', String(zoom));
    } catch {
      /* localStorage unavailable */
    }
  }

  /**
   * Transient status line (the editor's notify sink)
   */
  showStatus(session, msg, kind) {
    const el = session.statusEl;
    if (!el) return;
    el.textContent = msg;
    el.className = `wys-status visible${kind === 'err' ? ' err' : kind === 'ok' ? ' ok' : ''}`;
    if (session.statusTimer) {
      clearTimeout(session.statusTimer);
    }
    session.statusTimer = setTimeout(() => {
      el.classList.remove('visible');
    }, STATUS_FADE_MS);
    if (kind === 'err') {
      console.warn('[wysiwyg]', msg);
    }
  }

  /**
   * Tear down the active session (flushes pending edits by default)
   */
  teardownSession({ flushPending } = { flushPending: true }) {
    const session = this.session;
    this.session = null;
    // Invalidate any in-flight mount as well
    this.mountSeq++;
    this.mounting = null;

    if (!session) return;

    if (session.saveTimer) clearTimeout(session.saveTimer);
    if (session.reloadTimer) clearTimeout(session.reloadTimer);
    if (session.statusTimer) clearTimeout(session.statusTimer);
    session.saveTimer = null;
    session.reloadTimer = null;

    if (flushPending) {
      this.flushPendingOnTeardown(session);
    }

    if (session.modelSub) {
      try {
        session.modelSub.dispose();
      } catch {
        /* already disposed */
      }
    }
    if (session.keydownHandler && session.root) {
      session.root.removeEventListener('keydown', session.keydownHandler, true);
    }
    if (session.docMouseMove) {
      document.removeEventListener('mousemove', session.docMouseMove);
    }
    if (session.docMouseUp) {
      document.removeEventListener('mouseup', session.docMouseUp);
    }

    // Close any body-appended popover the editor may have left open
    if (this.editorModules && this.editorModules.closePopover) {
      try {
        this.editorModules.closePopover();
      } catch {
        /* nothing open */
      }
    }

    if (session.api) {
      try {
        session.api.destroy();
      } catch (error) {
        console.warn('[wysiwyg] editor destroy failed:', error);
      }
      session.api = null;
    }

    if (session.root && session.root.parentNode) {
      session.root.parentNode.removeChild(session.root);
    }
  }

  cleanup() {
    this.teardownSession({ flushPending: true });
    super.cleanup();
  }
}
