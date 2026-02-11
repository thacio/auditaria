/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Editor panel component

import { EventEmitter } from '../utils/EventEmitter.js';
import { EditorTabs } from './EditorTabs.js';
import { MenuBar } from './MenuBar.js';
import { ExternalChangeWarning } from './ExternalChangeWarning.js';
import { DiffModal } from './DiffModal.js';
import { themeManager } from '../utils/theme-manager.js';
import { showErrorToast } from './Toast.js';

/**
 * Editor Panel Component
 *
 * Main container for the Monaco editor
 * - Manages panel visibility
 * - Contains tabs and editor
 * - Handles save button
 * - Toggles between code and markdown preview
 */
export class EditorPanel extends EventEmitter {
  constructor(editorManager, previewManager = null) {
    super();
    this.editorManager = editorManager;
    this.previewManager = previewManager;

    // UI elements
    this.panel = null;
    this.editorContainer = null;
    this.toolbar = null;
    this.saveButton = null;
    this.parseButton = null;
    this.previewButton = null;
    this.codeButton = null;
    this.splitButton = null;
    this.diffButton = null;
    this.trackChangesButton = null;
    this.collaborativeWritingButton = null; // AUDITARIA: AI Collaborative Writing toggle
    this.closeButton = null;
    this.collapseButton = null;
    this.edgeToggleButton = null;
    this.expandTab = null;
    this.resizeHandle = null;
    this.splitResizeHandle = null;
    this.diffContainer = null;
    this.unsupportedOverlay = null;
    this.unsupportedFilename = null;
    this.unsupportedPath = null;
    this.unsupportedDescription = null;
    this.unsupportedAction = null;

    // Components
    this.menuBar = null;
    this.editorTabs = null;
    this.externalChangeWarning = null;
    this.diffModal = null;

    // State
    this.isVisible = false;
    this.isCollapsed = true;
    this.isPreviewMode = false;
    this.isSplitMode = false;
    this.isDiffMode = false;
    this.trackChangesEnabled = true; // Default: show diff when files change externally
    this.isBinaryPreviewMode = false; // Binary files can only be previewed, not edited
    this.activeBinaryFile = null; // Store binary file info { path, language, filename }
    this.isUnsupportedPreviewMode = false; // Unsupported files show a custom overlay
    this.activeUnsupportedFile = null; // Store unsupported file info { path, filename }
    this.previewUpdateListener = null;
    this.diffUpdateListener = null;
    this.diffEditor = null;
    this.pendingLayoutFrame = null;

    // Resize state
    this.isResizing = false;
    this.panelWidth = 420; // Default width in pixels
    this.minWidth = 360; // Minimum 360px
    this.maxWidth = 65; // Maximum width as % of viewport

    // Split view resize state
    this.isSplitResizing = false;
    this.splitRatio = 50; // Default 50/50 split (percentage for code editor)
    this.hasCustomWidth = false;

    this.initialize();
  }

  /**
   * Initialize component
   */
  async initialize() {
    this.createElements();
    this.setupEventHandlers();
    await this.initializeEditorManager();
    this.loadState();
  }

  /**
   * Initialize EditorManager with container
   */
  async initializeEditorManager() {
    await this.editorManager.initialize(this.editorContainer);

    // Set diff container for EditorManager
    if (this.diffContainer) {
      this.editorManager.setDiffContainer(this.diffContainer);
    }

    // Set track changes callback so EditorManager can check the preference
    this.editorManager.setTrackChangesCallback(() => this.trackChangesEnabled);
  }

  /**
   * Create UI elements
   */
  createElements() {
    // Get or create panel
    this.panel = document.getElementById('editor-panel');
    if (!this.panel) {
      this.panel = this.createPanelElement();
      this.insertPanelIntoDOM();
    }

    // Get references
    this.editorContainer = document.getElementById('monaco-editor-container');
    this.toolbar = document.getElementById('editor-toolbar');
    this.saveButton = document.getElementById('editor-save-button');
    this.parseButton = document.getElementById('editor-parse-button');
    this.previewButton = document.getElementById('editor-preview-button');
    this.codeButton = document.getElementById('editor-code-button');
    this.splitButton = document.getElementById('editor-split-button');
    this.diffButton = document.getElementById('editor-diff-button');
    this.trackChangesButton = document.getElementById('editor-track-changes-button');
    this.collaborativeWritingButton = document.getElementById('editor-collab-writing-button'); // AUDITARIA
    this.closeButton = document.getElementById('editor-close-button');
    this.collapseButton = document.getElementById('editor-collapse-button');
    this.edgeToggleButton = document.getElementById('editor-edge-toggle');
    this.expandTab = document.getElementById('editor-expand-tab');
    this.resizeHandle = document.getElementById('editor-resize-handle');
    this.splitResizeHandle = document.getElementById('split-resize-handle');
    this.diffContainer = document.getElementById('monaco-diff-container');
    this.unsupportedOverlay = document.getElementById('editor-unsupported-overlay');
    this.unsupportedFilename = document.getElementById('editor-unsupported-filename');
    this.unsupportedPath = document.getElementById('editor-unsupported-path');
    this.unsupportedDescription = document.getElementById('editor-unsupported-description');
    this.unsupportedAction = document.getElementById('editor-unsupported-open');
    if (this.unsupportedAction) {
      this.unsupportedAction.disabled = true;
    }

    // Create menu bar component
    this.menuBar = new MenuBar(this.editorManager);
    const menuBarElement = this.menuBar.getElement();

    // Create tabs component
    this.editorTabs = new EditorTabs(this.editorManager);
    const tabsContainer = this.editorTabs.getElement();

    // Create external change warning component
    this.externalChangeWarning = new ExternalChangeWarning(this.editorManager);
    const warningElement = this.externalChangeWarning.getElement();

    // Create diff modal component
    this.diffModal = new DiffModal(this.editorManager);

    // Insert menu bar and tabs before toolbar
    const editorHeader = this.panel.querySelector('.editor-header');
    if (editorHeader && menuBarElement) {
      editorHeader.insertBefore(menuBarElement, editorHeader.firstChild);
    }

    if (this.toolbar && tabsContainer) {
      this.toolbar.parentNode.insertBefore(tabsContainer, this.toolbar);
    }

    // Insert warning bar before editor content (first child)
    const editorContent = this.panel.querySelector('.editor-content');
    if (editorContent && warningElement) {
      editorContent.insertBefore(warningElement, editorContent.firstChild);
    }
  }

  /**
   * Create panel DOM structure
   * @returns {HTMLElement}
   */
  createPanelElement() {
    const panel = document.createElement('div');
    panel.id = 'editor-panel';
    panel.className = 'editor-panel collapsed';

    panel.innerHTML = `
      <div class="editor-resize-handle" id="editor-resize-handle"></div>
      <button class="editor-edge-toggle" id="editor-edge-toggle" title="Hide editor" aria-label="Hide editor">
        <span class="codicon codicon-chevron-right"></span>
      </button>
      <button class="editor-expand-tab" id="editor-expand-tab" title="Show editor" aria-label="Show editor">
        <span class="codicon codicon-chevron-left"></span>
      </button>
      <div class="editor-header">
        <div class="editor-header-row">
          <div class="editor-header-title">Editor</div>
          <div class="editor-header-actions">
            <button
              id="editor-collapse-button"
              class="editor-header-button"
              title="Hide editor"
              aria-label="Hide editor"
            >
              <span class="codicon codicon-chevron-right"></span>
            </button>
            <button
              id="editor-close-button"
              class="editor-header-button editor-close-button"
              title="Close editor"
              aria-label="Close editor"
            >
              <span class="codicon codicon-close"></span>
            </button>
          </div>
        </div>
        <div id="editor-toolbar" class="editor-toolbar">
          <button
            id="editor-save-button"
            class="editor-toolbar-button"
            title="Save file (Ctrl+S)"
            aria-label="Save file"
            disabled
          >
            <span class="codicon codicon-save"></span>
            <span class="editor-toolbar-button-text">Save</span>
          </button>

          <button
            id="editor-code-button"
            class="editor-toolbar-button active"
            title="Show code"
            aria-label="Show code"
            style="display: none;"
          >
            <span class="codicon codicon-code"></span>
            <span class="editor-toolbar-button-text">Code</span>
          </button>

          <button
            id="editor-preview-button"
            class="editor-toolbar-button"
            title="Show preview"
            aria-label="Show preview"
            style="display: none;"
          >
            <span class="codicon codicon-open-preview"></span>
            <span class="editor-toolbar-button-text">Preview</span>
          </button>

          <button
            id="editor-split-button"
            class="editor-toolbar-button"
            title="Show code and preview side by side"
            aria-label="Show split view"
            style="display: none;"
          >
            <span class="codicon codicon-split-horizontal"></span>
            <span class="editor-toolbar-button-text">Split</span>
          </button>

          <button
            id="editor-parse-button"
            class="editor-toolbar-button"
            title="Parse to DOCX"
            aria-label="Parse to DOCX"
            style="display: none;"
          >
            <span class="codicon codicon-file-pdf"></span>
            <span class="editor-toolbar-button-text">Parse to DOCX</span>
          </button>

          <button
            id="editor-diff-button"
            class="editor-toolbar-button"
            title="Show changes (diff view)"
            aria-label="Show diff"
            style="display: none;"
          >
            <span class="codicon codicon-diff"></span>
            <span class="editor-toolbar-button-text">Diff</span>
          </button>

          <button
            id="editor-track-changes-button"
            class="editor-toolbar-button active"
            title="Tracking external changes - shows diff when files change on disk (click to toggle)"
            aria-label="Toggle track changes"
          >
            <span class="codicon codicon-eye"></span>
            <span class="editor-toolbar-button-text">Track Changes</span>
          </button>

          <button
            id="editor-collab-writing-button"
            class="editor-toolbar-button"
            title="AI Collaborative Writing - sync file changes with AI (click to enable)"
            aria-label="Toggle AI Collaborative Writing"
          >
            <span class="codicon codicon-sync-ignored"></span>
            <span class="editor-toolbar-button-text">AI Collab</span>
          </button>
        </div>
      </div>

      <div class="editor-content">
        <div id="monaco-editor-container" class="monaco-editor-container"></div>
        <div id="monaco-diff-container" class="monaco-diff-container" style="display: none;"></div>
        <div id="split-resize-handle" class="split-resize-handle" style="display: none;"></div>
        <div id="markdown-preview-container" class="markdown-preview-container" style="display: none;"></div>
        <div id="editor-unsupported-overlay" class="editor-unsupported-overlay" style="display: none;">
          <div class="editor-unsupported-card">
            <div class="editor-unsupported-icon">
              <span class="codicon codicon-file-binary"></span>
            </div>
            <div class="editor-unsupported-title">This file can't be previewed here</div>
            <div class="editor-unsupported-filename" id="editor-unsupported-filename"></div>
            <div class="editor-unsupported-path" id="editor-unsupported-path"></div>
            <div class="editor-unsupported-description" id="editor-unsupported-description">
              Use your system's default application to open this file.
            </div>
            <button class="editor-unsupported-action" id="editor-unsupported-open">
              Open with System Default
            </button>
          </div>
        </div>
      </div>
    `;

    return panel;
  }

  /**
   * Insert panel into DOM
   */
  insertPanelIntoDOM() {
    // Prefer workbench body (new layout)
    const workbenchBody = document.getElementById('workbench-body');
    const appContainer = document.querySelector('.app-container') ||
                        document.querySelector('.main') ||
                        document.body;

    // Append panel
    (workbenchBody || appContainer).appendChild(this.panel);
  }

  /**
   * Set up event handlers
   */
  setupEventHandlers() {
    // Window resize handler
    window.addEventListener('resize', () => {
      this.handleResize();
    });

    // Initial resize check
    this.handleResize();

    // Theme change handler - update Monaco theme
    document.addEventListener('themechange', () => {
      // Update diff editor theme if it exists
      if (this.diffEditor && window.monaco) {
        window.monaco.editor.setTheme(themeManager.monacoTheme);
      }
      // Note: Main editor theme is handled by EditorManager
    });

    // Layout change handler - refresh default width when not user-resized
    document.addEventListener('layoutchange', () => {
      if (this.hasCustomWidth) return;
      const defaultWidth = this.getDefaultPanelWidth();
      if (defaultWidth) {
        this.panelWidth = defaultWidth;
        if (this.isVisible && !this.isCollapsed) {
          this.applyPanelWidth();
        }
      }
    });

    // Save button
    if (this.saveButton) {
      this.saveButton.addEventListener('click', () => {
        this.handleSaveClick();
      });
    }

    // Parse button
    if (this.parseButton) {
      this.parseButton.addEventListener('click', () => {
        this.handleParseClick();
      });
    }

    // Preview button
    if (this.previewButton) {
      this.previewButton.addEventListener('click', () => {
        this.showPreview();
      });
    }

    // Code button
    if (this.codeButton) {
      this.codeButton.addEventListener('click', () => {
        this.showEditor();
      });
    }

    // Split button
    if (this.splitButton) {
      this.splitButton.addEventListener('click', () => {
        this.showSplit();
      });
    }

    // Diff button (toggle)
    if (this.diffButton) {
      this.diffButton.addEventListener('click', () => {
        if (this.isDiffMode) {
          // Already in diff mode, toggle back to editor
          this.showEditor();
        } else {
          // Show diff mode
          this.showDiff();
        }
      });
    }

    // Track changes button (toggle)
    if (this.trackChangesButton) {
      this.trackChangesButton.addEventListener('click', () => {
        this.toggleTrackChanges();
      });
    }

    // AUDITARIA: Collaborative writing button (toggle AI file tracking)
    if (this.collaborativeWritingButton) {
      this.collaborativeWritingButton.addEventListener('click', () => {
        this.toggleCollaborativeWriting();
      });
    }

    // Close button
    if (this.closeButton) {
      this.closeButton.addEventListener('click', () => {
        this.hide();
      });
    }

    // Collapse button
    if (this.collapseButton) {
      this.collapseButton.addEventListener('click', () => {
        this.toggleCollapse();
      });
    }

    // Edge toggle button (always visible when expanded)
    if (this.edgeToggleButton) {
      this.edgeToggleButton.addEventListener('click', () => {
        this.toggleCollapse();
      });
    }

    // Expand tab (visible when collapsed)
    if (this.expandTab) {
      this.expandTab.addEventListener('click', () => {
        this.toggleCollapse();
      });
    }

    // Resize handle
    if (this.resizeHandle) {
      this.resizeHandle.addEventListener('mousedown', (e) => {
        this.startResize(e);
      });
    }

    // Split resize handle
    if (this.splitResizeHandle) {
      this.splitResizeHandle.addEventListener('mousedown', (e) => {
        this.startSplitResize(e);
      });
    }

    // Unsupported file action
    if (this.unsupportedAction) {
      this.unsupportedAction.addEventListener('click', () => {
        if (this.activeUnsupportedFile) {
          this.emit('open-with-system', { path: this.activeUnsupportedFile.path });
        }
      });
    }

    // EditorManager events
    this.editorManager.on('file-opened', ({ path, language }) => {
      // Clear binary preview mode when opening text files via EditorManager
      this.isBinaryPreviewMode = false;
      this.activeBinaryFile = null;

      this.show();

      // Extract filename for preview detection
      const filename = path.split('/').pop() || path;

      // Check if preview is available for the new file
      const canPreview = this.previewManager && this.previewManager.canPreview(language, filename);

      // Refresh current view mode with new file content
      if (this.isPreviewMode && canPreview) {
        this.showPreview();
      } else if (this.isSplitMode && canPreview) {
        this.updatePreview();
      } else if ((this.isPreviewMode || this.isSplitMode) && !canPreview) {
        // New file can't be previewed, switch to code view
        this.showEditor();
      }

      this.updateToolbar(language, filename);
      this.syncUnsupportedOverlay(path);

      // AUDITARIA: Update collaborative writing button state for new file
      this.updateCollaborativeWritingButton();
    });

    this.editorManager.on('file-switched', ({ path }) => {
      const fileInfo = this.editorManager.openFiles.get(path);
      if (fileInfo) {
        // Clear binary preview mode when switching to text files via EditorManager
        this.isBinaryPreviewMode = false;
        this.activeBinaryFile = null;

        this.show();

        // Extract filename for preview detection
        const filename = path.split('/').pop() || path;

        // Check if preview is available for the new file
        const canPreview = this.previewManager && this.previewManager.canPreview(fileInfo.language, filename);

        // Refresh current view mode with new file content
        if (this.isPreviewMode && canPreview) {
          this.showPreview();
        } else if (this.isSplitMode && canPreview) {
          this.updatePreview();
        } else if ((this.isPreviewMode || this.isSplitMode) && !canPreview) {
          // New file can't be previewed, switch to code view
          this.showEditor();
        }

        this.updateToolbar(fileInfo.language, filename);
        this.syncUnsupportedOverlay(path);

        // AUDITARIA: Update collaborative writing button state for new file
        this.updateCollaborativeWritingButton();

        // Update warning visibility based on file state
        if (fileInfo.showWarning) {
          this.externalChangeWarning.show(path);
        } else {
          this.externalChangeWarning.hide();
        }
      }
    });

    this.editorManager.on('file-closed', () => {
      if (this.editorManager.getOpenFilesCount() === 0) {
        this.clearUnsupportedOverlay();
        this.hide();
      }
    });

    this.editorManager.on('dirty-changed', ({ path, isDirty }) => {
      this.updateSaveButton();
      // Update toolbar to show/hide diff button based on dirty state
      const activeFile = this.editorManager.getActiveFile();
      if (activeFile === path) {
        const fileInfo = this.editorManager.openFiles.get(activeFile);
        if (fileInfo) {
          this.updateToolbar(fileInfo.language);
        }
      }
    });

    this.editorManager.on('file-saved', ({ path, message }) => {
      this.showSaveSuccess();

      // If we need to parse after save
      if (this.shouldParseAfterSave) {
        this.shouldParseAfterSave = false;
        setTimeout(() => {
          this.editorManager.requestParse(path);
        }, 500);
      }
    });

    this.editorManager.on('error', (error) => {
      this.showError(error.message);
    });

    // Listen for parser status changes
    this.editorManager.on('parser-status-changed', ({ available }) => {
      // Update button visibility if active file is markdown
      const activeFile = this.editorManager.getActiveFile();
      if (activeFile) {
        const fileInfo = this.editorManager.openFiles.get(activeFile);
        if (fileInfo) {
          this.updateToolbar(fileInfo.language);
        }
      }
    });

    // Handle external change warning
    this.editorManager.on('external-change-warning', ({ path }) => {
      if (path === this.editorManager.getActiveFile()) {
        this.externalChangeWarning.show(path);
      }
    });

    // Handle warning dismissed
    this.editorManager.on('external-warning-dismissed', ({ path }) => {
      this.externalChangeWarning.hide();
    });

    // AUDITARIA: Handle collaborative writing status changes
    this.editorManager.on('collaborative-writing-changed', () => {
      this.updateCollaborativeWritingButton();
    });

  }

  /**
   * Handle save button click
   */
  handleSaveClick() {
    this.editorManager.saveActiveFile();
  }

  /**
   * Handle parse button click
   */
  handleParseClick() {
    const activeFile = this.editorManager.getActiveFile();
    if (!activeFile) return;

    const fileInfo = this.editorManager.openFiles.get(activeFile);
    if (!fileInfo) return;

    // Check if file has unsaved changes
    if (fileInfo.isDirty) {
      const confirmed = confirm(
        'The file has unsaved changes. Please save before parsing.\n\n' +
        'Would you like to save now?'
      );

      if (confirmed) {
        this.editorManager.saveActiveFile();
        // Will parse after save completes via save handler
        this.shouldParseAfterSave = true;
        return;
      } else {
        return; // User cancelled
      }
    }

    // File is saved, send parse request
    this.editorManager.requestParse(activeFile);
  }

  /**
   * Show markdown preview
   */
  showPreview() {
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');

    // Remove split mode classes
    if (editorContainer) {
      editorContainer.classList.remove('split-view');
      editorContainer.style.display = 'none';
      editorContainer.style.width = '';
    }

    if (previewContainer && this.previewManager) {
      previewContainer.classList.remove('split-view');
      previewContainer.style.display = 'block';
      previewContainer.style.width = '';
      previewContainer.style.left = '';

      // Get current content from editor
      const activeFile = this.editorManager.getActiveFile();
      if (activeFile) {
        const fileInfo = this.editorManager.openFiles.get(activeFile);
        if (fileInfo) {
          const content = fileInfo.model.getValue();
          const filename = activeFile.split('/').pop() || activeFile;
          // Pass full file path for previews that need it (e.g., HTML with relative paths)
          this.previewManager.render(content, previewContainer, fileInfo.language, filename, activeFile);
        }
      }
    }

    // Hide diff container
    if (this.diffContainer) {
      this.diffContainer.style.display = 'none';
    }

    // Hide split resize handle
    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.display = 'none';
    }

    // Remove real-time preview listener
    this.removePreviewListener();

    // Update button states
    this.isPreviewMode = true;
    this.isSplitMode = false;
    this.isDiffMode = false;
    if (this.previewButton) {
      this.previewButton.classList.add('active');
    }
    if (this.codeButton) {
      this.codeButton.classList.remove('active');
    }
    if (this.splitButton) {
      this.splitButton.classList.remove('active');
    }
    if (this.diffButton) {
      this.diffButton.classList.remove('active');
    }
  }

  /**
   * Open binary file in preview-only mode
   * Binary files cannot be edited, only previewed
   * @param {string} path - File path
   * @param {string} language - Monaco language ID
   * @param {string} filename - Filename
   */
  openBinaryPreview(path, language, filename) {
    // Clear unsupported overlay when showing binary previews
    this.clearUnsupportedOverlay();

    // Set binary preview mode
    this.isBinaryPreviewMode = true;
    this.activeBinaryFile = { path, language, filename };

    // Show panel
    this.show();

    // Notify tabs that we have a binary file open (for display purposes)
    this.emit('tabs-changed', { tabs: this.getBinaryTabInfo() });

    // Update toolbar for binary file (hide Code/Split buttons)
    this.updateToolbar(language, filename);

    // Get preview container
    const previewContainer = document.getElementById('markdown-preview-container');
    const editorContainer = document.getElementById('monaco-editor-container');

    // Hide editor completely for binary files
    if (editorContainer) {
      editorContainer.style.display = 'none';
    }

    // Show preview container
    if (previewContainer && this.previewManager) {
      previewContainer.classList.remove('split-view');
      previewContainer.style.display = 'block';
      previewContainer.style.width = '';
      previewContainer.style.left = '';

      // Binary files don't have text content - preview manager will use /preview-file/* endpoint
      // Pass empty content - the preview implementation will handle loading via server
      this.previewManager.render('', previewContainer, language, filename, path);
    }

    // Hide diff container and split handle
    if (this.diffContainer) {
      this.diffContainer.style.display = 'none';
    }
    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.display = 'none';
    }

    // Set preview mode active
    this.isPreviewMode = true;
    this.isSplitMode = false;
    this.isDiffMode = false;

    // Update button states (only Preview button should be active)
    if (this.previewButton) {
      this.previewButton.classList.add('active');
    }
    if (this.codeButton) {
      this.codeButton.classList.remove('active');
    }
    if (this.splitButton) {
      this.splitButton.classList.remove('active');
    }
    if (this.diffButton) {
      this.diffButton.classList.remove('active');
    }

    // Emit event
    this.emit('binary-file-opened', { path, language, filename });
  }

  /**
   * Open an unsupported file in a read-only virtual view
   * @param {string} path - File path
   * @param {string} filename - Filename
   */
  openUnsupportedFile(path, filename) {
    this.isBinaryPreviewMode = false;
    this.activeBinaryFile = null;

    const content = '';

    this.editorManager.openVirtualFile(path, content, 'plaintext', {
      readOnly: true,
      isUnsupported: true
    });
  }

  /**
   * Sync unsupported overlay with the active file
   * @param {string} path - Active file path
   */
  syncUnsupportedOverlay(path) {
    const fileInfo = path ? this.editorManager.openFiles.get(path) : null;
    if (fileInfo && fileInfo.isUnsupported) {
      this.showUnsupportedOverlay(path);
    } else {
      this.clearUnsupportedOverlay();
    }
  }

  /**
   * Show unsupported overlay state
   * @param {string} path - File path
   */
  showUnsupportedOverlay(path) {
    const filename = path.split('/').pop() || path;
    const extension = this.getFileExtension(filename);

    this.isUnsupportedPreviewMode = true;
    this.activeUnsupportedFile = { path, filename };

    if (this.unsupportedFilename) {
      this.unsupportedFilename.textContent = filename;
    }
    if (this.unsupportedPath) {
      this.unsupportedPath.textContent = path;
    }
    if (this.unsupportedDescription) {
      this.unsupportedDescription.textContent = `Auditaria can't display ${extension} files yet.`;
    }
    if (this.unsupportedAction) {
      this.unsupportedAction.disabled = false;
    }
    if (this.unsupportedOverlay) {
      this.unsupportedOverlay.style.display = 'flex';
    }

    this.applyUnsupportedVisibility();
  }

  /**
   * Clear unsupported overlay state
   */
  clearUnsupportedOverlay() {
    this.isUnsupportedPreviewMode = false;
    this.activeUnsupportedFile = null;
    if (this.unsupportedOverlay) {
      this.unsupportedOverlay.style.display = 'none';
    }
    if (this.unsupportedAction) {
      this.unsupportedAction.disabled = true;
    }
  }

  /**
   * Extract a friendly file extension label
   * @param {string} filename
   * @returns {string}
   */
  getFileExtension(filename) {
    const parts = filename.split('.');
    if (parts.length <= 1) {
      return 'UNKNOWN';
    }
    return parts[parts.length - 1].toUpperCase();
  }

  /**
   * Ensure only the unsupported overlay is visible
   */
  applyUnsupportedVisibility() {
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');

    if (editorContainer) {
      editorContainer.classList.remove('split-view');
      editorContainer.style.display = 'none';
      editorContainer.style.width = '';
    }

    if (previewContainer) {
      previewContainer.classList.remove('split-view');
      previewContainer.style.display = 'none';
      previewContainer.style.width = '';
      previewContainer.style.left = '';
    }

    if (this.diffContainer) {
      this.diffContainer.style.display = 'none';
    }

    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.display = 'none';
    }
  }

  /**
   * Show code editor
   */
  showEditor() {
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');
    const activeFile = this.editorManager.getActiveFile();
    const fileInfo = activeFile ? this.editorManager.openFiles.get(activeFile) : null;
    const isUnsupported = !!(fileInfo && fileInfo.isUnsupported);

    // Remove split mode classes
    if (editorContainer) {
      editorContainer.classList.remove('split-view');
      editorContainer.style.display = isUnsupported ? 'none' : 'block';
      editorContainer.style.width = '';
    }

    if (previewContainer) {
      previewContainer.classList.remove('split-view');
      previewContainer.style.display = 'none';
      previewContainer.style.width = '';
      previewContainer.style.left = '';
    }

    // Hide diff container
    if (this.diffContainer) {
      this.diffContainer.style.display = 'none';
    }

    // Hide split resize handle
    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.display = 'none';
    }

    // Remove real-time listeners
    this.removePreviewListener();
    this.removeDiffListener();

    // Restore warning bar if active file has external changes
    if (activeFile) {
      if (fileInfo && fileInfo.showWarning && this.externalChangeWarning) {
        this.externalChangeWarning.show(activeFile);
      }
    }

    // Update button states
    this.isPreviewMode = false;
    this.isSplitMode = false;
    this.isDiffMode = false;
    this.isBinaryPreviewMode = false; // Clear binary preview mode
    this.activeBinaryFile = null;
    if (this.codeButton) {
      this.codeButton.classList.add('active');
    }
    if (this.previewButton) {
      this.previewButton.classList.remove('active');
    }
    if (this.splitButton) {
      this.splitButton.classList.remove('active');
    }
    if (this.diffButton) {
      this.diffButton.classList.remove('active');
    }

    if (isUnsupported) {
      this.showUnsupportedOverlay(activeFile || '');
      return;
    }

    this.clearUnsupportedOverlay();

    // Focus editor
    if (this.editorManager.editor) {
      this.editorManager.editor.focus();
    }
  }

  /**
   * Show split view (code and preview side by side)
   */
  showSplit() {
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');

    // Show both containers side by side
    if (editorContainer) {
      editorContainer.classList.add('split-view');
      editorContainer.style.display = 'block';
      editorContainer.style.width = `${this.splitRatio}%`;
    }

    if (previewContainer && this.previewManager) {
      previewContainer.classList.add('split-view');
      previewContainer.style.display = 'block';
      previewContainer.style.width = `${100 - this.splitRatio}%`;
      previewContainer.style.left = `${this.splitRatio}%`;

      // Initial preview render
      this.updatePreview();

      // Set up real-time preview updates
      this.setupPreviewListener();
    }

    // Hide diff container
    if (this.diffContainer) {
      this.diffContainer.style.display = 'none';
    }

    // Show split resize handle
    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.display = 'block';
      this.splitResizeHandle.style.left = `${this.splitRatio}%`;
    }

    // Update button states
    this.isPreviewMode = false;
    this.isSplitMode = true;
    this.isDiffMode = false;
    if (this.codeButton) {
      this.codeButton.classList.remove('active');
    }
    if (this.previewButton) {
      this.previewButton.classList.remove('active');
    }
    if (this.splitButton) {
      this.splitButton.classList.add('active');
    }
    if (this.diffButton) {
      this.diffButton.classList.remove('active');
    }

    // Focus editor
    if (this.editorManager.editor) {
      this.editorManager.editor.focus();
    }
  }

  /**
   * Show diff view (compare current with saved)
   */
  async showDiff() {
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');

    // Hide other containers
    if (editorContainer) {
      editorContainer.style.display = 'none';
    }

    if (previewContainer) {
      previewContainer.style.display = 'none';
    }

    // Hide split resize handle
    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.display = 'none';
    }

    // Remove real-time preview listener
    this.removePreviewListener();

    // Show diff container
    if (this.diffContainer) {
      this.diffContainer.style.display = 'block';

      // Create or update diff editor
      await this.createDiffEditor();

      // Set up real-time diff updates
      this.setupDiffListener();
    }

    // Update button states
    this.isPreviewMode = false;
    this.isSplitMode = false;
    this.isDiffMode = true;
    if (this.codeButton) {
      this.codeButton.classList.remove('active');
    }
    if (this.previewButton) {
      this.previewButton.classList.remove('active');
    }
    if (this.splitButton) {
      this.splitButton.classList.remove('active');
    }
    if (this.diffButton) {
      this.diffButton.classList.add('active');
    }
  }

  /**
   * Create or update diff editor
   */
  async createDiffEditor() {
    const activeFile = this.editorManager.getActiveFile();
    if (!activeFile) return;

    const fileInfo = this.editorManager.openFiles.get(activeFile);
    if (!fileInfo) return;

    // Get Monaco instance
    const monaco = this.editorManager.monaco;
    if (!monaco) return;

    // Create diff editor if it doesn't exist
    if (!this.diffEditor) {
      this.diffEditor = monaco.editor.createDiffEditor(this.diffContainer, {
        automaticLayout: true,
        readOnly: false,  // Allow editing the modified (right) side
        renderSideBySide: true,
        theme: themeManager.monacoTheme,
        originalEditable: false  // Keep original (left) side read-only
      });
    }

    // Use externalContent if available (external changes), otherwise use savedContent
    // This ensures both warning bar "View Diff" and toolbar "Diff" show the same comparison
    const diskContent = fileInfo.externalContent || fileInfo.savedContent;

    // Dispose old original model if it exists
    const oldModel = this.diffEditor.getModel();
    if (oldModel && oldModel.original) {
      oldModel.original.dispose();
    }

    // Create models for original (disk content) and modified (current) content
    const originalModel = monaco.editor.createModel(diskContent, fileInfo.language);
    const modifiedModel = fileInfo.model;

    // Set the diff editor models
    this.diffEditor.setModel({
      original: originalModel,
      modified: modifiedModel
    });
  }

  /**
   * Set up real-time preview listener
   */
  setupPreviewListener() {
    // Remove existing listener if any
    this.removePreviewListener();

    // Add listener to Monaco editor for content changes
    if (this.editorManager.editor) {
      this.previewUpdateListener = this.editorManager.editor.onDidChangeModelContent(() => {
        if (this.isSplitMode) {
          this.updatePreview();
        }
      });
    }
  }

  /**
   * Remove preview listener
   */
  removePreviewListener() {
    if (this.previewUpdateListener) {
      this.previewUpdateListener.dispose();
      this.previewUpdateListener = null;
    }
  }

  /**
   * Set up real-time diff listener
   */
  setupDiffListener() {
    // Remove existing listener if any
    this.removeDiffListener();

    // Add listener to Monaco editor for content changes (when user types)
    if (this.editorManager.editor) {
      this.diffUpdateListener = this.editorManager.editor.onDidChangeModelContent(() => {
        if (this.isDiffMode) {
          this.updateDiff();
        }
      });
    }

    // ALSO listen to external file changes
    this.editorManager.on('external-change-warning', ({ path }) => {
      const activeFile = this.editorManager.getActiveFile();
      if (this.isDiffMode && activeFile === path) {
        this.updateDiff();
      }
    });
  }

  /**
   * Remove diff listener
   */
  removeDiffListener() {
    if (this.diffUpdateListener) {
      this.diffUpdateListener.dispose();
      this.diffUpdateListener = null;
    }
  }

  /**
   * Update diff with current editor content
   */
  async updateDiff() {
    if (this.isDiffMode && this.diffContainer) {
      await this.createDiffEditor();
    }
  }

  /**
   * Toggle track changes mode
   * When enabled: Shows diff when files change externally (instead of auto-reloading)
   * When disabled: Auto-reloads files silently when changed externally
   */
  toggleTrackChanges() {
    this.trackChangesEnabled = !this.trackChangesEnabled;

    if (this.trackChangesButton) {
      const icon = this.trackChangesButton.querySelector('.codicon');

      if (this.trackChangesEnabled) {
        this.trackChangesButton.classList.add('active');
        this.trackChangesButton.title = 'Tracking external changes - shows diff when files change on disk (click to toggle)';
        if (icon) {
          icon.className = 'codicon codicon-eye';
        }
      } else {
        this.trackChangesButton.classList.remove('active');
        this.trackChangesButton.title = 'Auto-reload enabled - files reload silently when changed on disk (click to toggle)';
        if (icon) {
          icon.className = 'codicon codicon-eye-closed';
        }
      }
    }

    this.saveState();
  }

  // =========================================================================
  // AUDITARIA: AI Collaborative Writing Toggle
  // =========================================================================

  /**
   * Toggle AI collaborative writing for the active file
   * When enabled: AI receives notifications when file changes externally
   * When disabled: AI is not notified of external changes
   */
  toggleCollaborativeWriting() {
    const activeFile = this.editorManager.getActiveFile();
    if (!activeFile) {
      console.warn('No active file to toggle collaborative writing');
      return;
    }

    // Delegate to EditorManager
    this.editorManager.toggleCollaborativeWriting(activeFile);
  }

  /**
   * Update collaborative writing button state based on current file
   */
  updateCollaborativeWritingButton() {
    if (!this.collaborativeWritingButton) return;

    const activeFile = this.editorManager.getActiveFile();
    const isActive = activeFile && this.editorManager.isCollaborativeWritingActive(activeFile);
    const icon = this.collaborativeWritingButton.querySelector('.codicon');

    if (isActive) {
      this.collaborativeWritingButton.classList.add('active');
      this.collaborativeWritingButton.title = 'AI Collaborative Writing enabled - AI receives file change notifications (click to disable)';
      if (icon) {
        icon.className = 'codicon codicon-sync';
      }
    } else {
      this.collaborativeWritingButton.classList.remove('active');
      this.collaborativeWritingButton.title = 'AI Collaborative Writing disabled - AI is not notified of file changes (click to enable)';
      if (icon) {
        icon.className = 'codicon codicon-sync-ignored';
      }
    }
  }

  /**
   * Update preview with current editor content
   */
  updatePreview() {
    const previewContainer = document.getElementById('markdown-preview-container');
    if (!previewContainer || !this.previewManager) return;

    const activeFile = this.editorManager.getActiveFile();
    if (activeFile) {
      const fileInfo = this.editorManager.openFiles.get(activeFile);
      if (fileInfo) {
        const content = fileInfo.model.getValue();
        const filename = activeFile.split('/').pop() || activeFile;
        // Pass full file path for previews that need it
        this.previewManager.render(content, previewContainer, fileInfo.language, filename, activeFile);
      }
    }
  }

  /**
   * Update toolbar based on language
   * @param {string} language - Monaco language ID
   */
  updateToolbar(language, filename = '') {
    // Get active file info
    const activeFile = this.editorManager.getActiveFile();
    const fileInfo = activeFile ? this.editorManager.openFiles.get(activeFile) : null;
    const isDirty = fileInfo && fileInfo.isDirty;
    const isUnsupported = fileInfo && fileInfo.isUnsupported;

    // Extract filename from path if not provided
    if (!filename && activeFile) {
      filename = activeFile.split('/').pop() || activeFile;
    }

    // If in binary preview mode, use activeBinaryFile for filename
    if (this.isBinaryPreviewMode && this.activeBinaryFile) {
      filename = this.activeBinaryFile.filename;
    }

    if (isUnsupported) {
      if (this.previewButton) {
        this.previewButton.style.display = 'none';
      }
      if (this.codeButton) {
        this.codeButton.style.display = 'none';
      }
      if (this.splitButton) {
        this.splitButton.style.display = 'none';
      }
      if (this.parseButton) {
        this.parseButton.style.display = 'none';
      }
      if (this.diffButton) {
        this.diffButton.style.display = 'none';
      }
      if (this.collaborativeWritingButton) {
        this.collaborativeWritingButton.style.display = 'none';
      }
      this.updateSaveButton();
      return;
    }

    // Check if preview is available for this file type
    const canPreview = this.previewManager && this.previewManager.canPreview(language, filename);
    const activePreview = canPreview ? this.previewManager.getPreviewerFor(language, filename) : null;

    // Binary preview mode: Only show Preview button, hide Code/Split and AI Collab
    if (this.isBinaryPreviewMode) {
      if (this.previewButton) {
        this.previewButton.style.display = canPreview ? '' : 'none';
      }
      if (this.codeButton) {
        this.codeButton.style.display = 'none'; // Always hide for binary files
      }
      if (this.splitButton) {
        this.splitButton.style.display = 'none'; // Always hide for binary files
      }
      // AUDITARIA: Hide AI Collab for binary files (not editable)
      if (this.collaborativeWritingButton) {
        this.collaborativeWritingButton.style.display = 'none';
      }
    } else {
      // Normal mode: Show/hide base preview buttons (Code/Preview/Split)
      if (this.previewButton) {
        this.previewButton.style.display = canPreview ? '' : 'none';
      }

      if (this.codeButton) {
        this.codeButton.style.display = canPreview ? '' : 'none';
      }

      if (this.splitButton) {
        this.splitButton.style.display = canPreview ? '' : 'none';
      }

      // AUDITARIA: Show AI Collab button for editable files
      if (this.collaborativeWritingButton) {
        this.collaborativeWritingButton.style.display = '';
      }
    }

    // Update preview button title
    if (activePreview && this.previewButton) {
      this.previewButton.classList.remove('has-security-warning');
      this.previewButton.title = 'Show preview';
    }

    // Show/hide parse button for markdown files with parser available
    const isMarkdown = language === 'markdown';
    const hasParser = this.editorManager.isParserAvailable();
    if (this.parseButton) {
      this.parseButton.style.display = (isMarkdown && hasParser) ? '' : 'none';
    }

    // Show/hide diff button based on whether file has unsaved changes
    if (this.diffButton) {
      this.diffButton.style.display = isDirty ? '' : 'none';
    }

    // Ensure we're showing editor if preview not available
    if (!canPreview && (this.isPreviewMode || this.isSplitMode)) {
      this.showEditor();
    }

    // Ensure we're showing editor if diff mode but file is no longer dirty
    if (!isDirty && this.isDiffMode) {
      this.showEditor();
    }

    this.updateSaveButton();
  }

  /**
   * Update save button state
   */
  updateSaveButton() {
    if (!this.saveButton) return;

    const activeFile = this.editorManager.getActiveFile();
    if (!activeFile) {
      this.saveButton.disabled = true;
      return;
    }

    const fileInfo = this.editorManager.openFiles.get(activeFile);
    if (!fileInfo || fileInfo.readOnly || fileInfo.isUnsupported) {
      this.saveButton.disabled = true;
      return;
    }
    this.saveButton.disabled = !fileInfo.isDirty;
  }

  /**
   * Show panel
   */
  show() {
    // Always expand the panel when showing (even if already visible)
    // This ensures clicking a file un-collapses the panel
    this.panel.classList.add('visible');
    this.panel.classList.remove('collapsed');
    this.isVisible = true;
    this.isCollapsed = false;

    // Apply saved width (if exists) when showing the panel
    // This applies the user's preferred width from localStorage
    this.applyPanelWidth();

    this.updateCollapseControls();

    this.emit('visibility-changed', { isVisible: true });
    this.saveState();
  }

  /**
   * Hide panel
   */
  hide() {
    // Always hide, even if state says it's already hidden
    // This fixes issues where CSS classes and state flags are out of sync
    this.panel.classList.remove('visible');
    this.panel.classList.add('collapsed');
    this.isVisible = false;
    this.isCollapsed = true;

    // Clear inline width so CSS can fully control visibility
    this.panel.style.width = '';

    this.updateCollapseControls();
    this.emit('visibility-changed', { isVisible: false });
    this.saveState();
  }

  /**
   * Toggle panel visibility
   */
  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Handle window resize for responsive behavior
   */
  handleResize() {
    const width = window.innerWidth;

    // Small screens (<768px): Auto-collapse if visible and expanded
    if (width < 768) {
      if (this.isVisible && !this.isCollapsed) {
        this.isCollapsed = true;
        this.panel.classList.remove('visible');
        this.panel.classList.add('collapsed');
        this.updateCollapseControls();
        this.emit('collapse-changed', { isCollapsed: this.isCollapsed });
      }
    } else {
      // Medium and large screens: If collapsed due to auto-collapse, restore to expanded
      if (this.isVisible && this.isCollapsed) {
        this.isCollapsed = false;
        this.panel.classList.add('visible');
        this.panel.classList.remove('collapsed');
        this.updateCollapseControls();
        this.emit('collapse-changed', { isCollapsed: this.isCollapsed });
      }

      // Clamp width to max when viewport changes
      if (this.isVisible && !this.isCollapsed) {
        const maxWidthPx = (this.maxWidth / 100) * width;
        if (this.panelWidth > maxWidthPx) {
          this.panelWidth = maxWidthPx;
        }
        this.applyPanelWidth();
      }
    }
  }

  /**
   * Toggle panel collapse state
   */
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    this.isVisible = !this.isCollapsed;

    if (this.isCollapsed) {
      // When collapsing, remove .visible and add .collapsed
      this.panel.classList.remove('visible');
      this.panel.classList.add('collapsed');
      // Clear inline width so CSS can control the collapse
      this.panel.style.width = '';
    } else {
      // When expanding, add .visible and remove .collapsed
      this.panel.classList.add('visible');
      this.panel.classList.remove('collapsed');
      // Restore the saved width when expanding
      this.applyPanelWidth();
    }

    this.updateCollapseControls();
    this.saveState();
    this.emit('collapse-changed', { isCollapsed: this.isCollapsed });
  }

  /**
   * Update collapse/expand controls (header + edge toggle)
   */
  updateCollapseControls() {
    const iconClass = this.isCollapsed ? 'codicon codicon-chevron-left' : 'codicon codicon-chevron-right';
    const title = this.isCollapsed ? 'Show editor' : 'Hide editor';
    [this.collapseButton, this.edgeToggleButton].forEach((button) => {
      if (!button) return;
      const icon = button.querySelector('.codicon');
      if (icon) {
        icon.className = iconClass;
      }
      button.title = title;
      button.setAttribute('aria-label', title);
    });
  }

  /**
   * Show save success message
   */
  showSaveSuccess() {
    // Could add a toast notification here
    // For now, just log
    console.log('File saved successfully');
  }

  /**
   * Show error message
   * @param {string} message
   */
  showError(message) {
    console.error('Editor error:', message);
    showErrorToast(message);
  }

  /**
   * Start resizing the panel
   * @param {MouseEvent} e
   */
  startResize(e) {
    e.preventDefault();
    this.isResizing = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    if (this.panel) {
      this.panel.style.transition = 'none';
    }

    // Bind resize handlers
    this.boundDoResize = this.doResize.bind(this);
    this.boundStopResize = this.stopResize.bind(this);

    document.addEventListener('mousemove', this.boundDoResize);
    document.addEventListener('mouseup', this.boundStopResize);
  }

  /**
   * Handle panel resizing
   * @param {MouseEvent} e
   */
  doResize(e) {
    if (!this.isResizing) return;

    const viewportWidth = window.innerWidth;
    if (viewportWidth < 768) return;
    const mouseX = e.clientX;

    // Calculate new width as percentage from the right edge
    const distanceFromRight = viewportWidth - mouseX;
    let newWidth = distanceFromRight;

    // Apply constraints
    const maxWidthPx = (this.maxWidth / 100) * viewportWidth;
    newWidth = Math.max(this.minWidth, Math.min(maxWidthPx, newWidth));

    // Update panel width
    this.panelWidth = newWidth;
    this.panel.style.width = `${newWidth}px`;

    // Trigger Monaco editor layout update
    this.scheduleEditorLayout();
  }

  /**
   * Stop resizing the panel
   */
  stopResize() {
    if (!this.isResizing) return;

    this.isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (this.panel) {
      this.panel.style.transition = '';
    }

    // Remove event listeners
    document.removeEventListener('mousemove', this.boundDoResize);
    document.removeEventListener('mouseup', this.boundStopResize);

    // Save width to localStorage
    this.hasCustomWidth = true;
    this.saveState();
  }

  /**
   * Apply panel width (respects small-screen overlay rules)
   */
  applyPanelWidth() {
    if (!this.panel) return;
    if (window.innerWidth < 768) {
      this.panel.style.width = '';
      return;
    }
    if (this.panelWidth) {
      this.panel.style.width = `${this.panelWidth}px`;
    }
  }

  /**
   * Schedule a Monaco layout update (one per animation frame)
   */
  scheduleEditorLayout() {
    if (!this.editorManager.editor) return;
    if (this.pendingLayoutFrame) {
      cancelAnimationFrame(this.pendingLayoutFrame);
    }
    this.pendingLayoutFrame = requestAnimationFrame(() => {
      this.pendingLayoutFrame = null;
      if (this.editorManager.editor) {
        this.editorManager.editor.layout();
      }
    });
  }

  /**
   * Start resizing the split view
   * @param {MouseEvent} e
   */
  startSplitResize(e) {
    e.preventDefault();
    this.isSplitResizing = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';

    // Bind split resize handlers
    this.boundDoSplitResize = this.doSplitResize.bind(this);
    this.boundStopSplitResize = this.stopSplitResize.bind(this);

    document.addEventListener('mousemove', this.boundDoSplitResize);
    document.addEventListener('mouseup', this.boundStopSplitResize);
  }

  /**
   * Handle split view resizing
   * @param {MouseEvent} e
   */
  doSplitResize(e) {
    if (!this.isSplitResizing) return;

    const editorContent = this.panel.querySelector('.editor-content');
    if (!editorContent) return;

    const rect = editorContent.getBoundingClientRect();
    const mouseX = e.clientX;
    const relativeX = mouseX - rect.left;

    // Calculate new split ratio as percentage
    let newRatio = (relativeX / rect.width) * 100;

    // Apply constraints (minimum 20%, maximum 80%)
    newRatio = Math.max(20, Math.min(80, newRatio));

    // Update split ratio
    this.splitRatio = newRatio;

    // Update containers
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');

    if (editorContainer) {
      editorContainer.style.width = `${newRatio}%`;
    }

    if (previewContainer) {
      previewContainer.style.width = `${100 - newRatio}%`;
      previewContainer.style.left = `${newRatio}%`;
    }

    // Update split resize handle position
    if (this.splitResizeHandle) {
      this.splitResizeHandle.style.left = `${newRatio}%`;
    }

    // Trigger Monaco editor layout update
    this.scheduleEditorLayout();
  }

  /**
   * Stop resizing the split view
   */
  stopSplitResize() {
    if (!this.isSplitResizing) return;

    this.isSplitResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Remove event listeners
    document.removeEventListener('mousemove', this.boundDoSplitResize);
    document.removeEventListener('mouseup', this.boundStopSplitResize);

    // Save split ratio to localStorage
    this.saveState();
  }

  /**
   * Load state from localStorage
   */
  loadState() {
    try {
      const defaultWidth = this.getDefaultPanelWidth();
      if (defaultWidth) {
        this.panelWidth = defaultWidth;
      }
      const saved = localStorage.getItem('auditaria_editor_panel_state');
      if (saved) {
        const state = JSON.parse(saved);
        // Don't auto-show on load, only show when file is opened
        // this.isVisible = state.isVisible || false;

        // Restore panel width value but DON'T apply as inline style
        // The inline style would override CSS and make panel visible
        // Width will be applied when panel is shown via show() method
        if (state.panelWidth) {
          let restoredWidth = state.panelWidth;
          // Legacy values stored as percentages (<= 100)
          if (restoredWidth > 0 && restoredWidth <= 100) {
            restoredWidth = (restoredWidth / 100) * window.innerWidth;
          }
          const maxWidthPx = (this.maxWidth / 100) * window.innerWidth;
          this.panelWidth = Math.max(this.minWidth, Math.min(maxWidthPx, restoredWidth));
          this.hasCustomWidth = true;
          // DON'T set: this.panel.style.width = `${this.panelWidth}px`;
        }

        // Restore split ratio
        if (state.splitRatio) {
          this.splitRatio = state.splitRatio;
        }

        // Restore track changes preference
        if (typeof state.trackChangesEnabled === 'boolean') {
          this.trackChangesEnabled = state.trackChangesEnabled;
          // Update button UI to match restored state
          if (this.trackChangesButton) {
            const icon = this.trackChangesButton.querySelector('.codicon');
            if (this.trackChangesEnabled) {
              this.trackChangesButton.classList.add('active');
              this.trackChangesButton.title = 'Tracking external changes - shows diff when files change on disk (click to toggle)';
              if (icon) icon.className = 'codicon codicon-eye';
            } else {
              this.trackChangesButton.classList.remove('active');
              this.trackChangesButton.title = 'Auto-reload enabled - files reload silently when changed on disk (click to toggle)';
              if (icon) icon.className = 'codicon codicon-eye-closed';
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to load editor panel state:', error);
    }
  }

  /**
   * Get the default panel width from CSS (layout-aware)
   * @returns {number|null}
   */
  getDefaultPanelWidth() {
    if (!window.getComputedStyle) return null;
    const value = getComputedStyle(document.documentElement).getPropertyValue('--dock-right-width').trim();
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Save state to localStorage
   */
  saveState() {
    try {
      const state = {
        // Don't save isVisible - panel should always start closed
        panelWidth: this.panelWidth,
        splitRatio: this.splitRatio,
        trackChangesEnabled: this.trackChangesEnabled
      };
      localStorage.setItem('auditaria_editor_panel_state', JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save editor panel state:', error);
    }
  }

  /**
   * Get tab info for binary file preview
   * Returns array with single tab for the active binary file
   * @returns {Array} Tab info array
   */
  getBinaryTabInfo() {
    if (!this.isBinaryPreviewMode || !this.activeBinaryFile) {
      return [];
    }

    return [{
      path: this.activeBinaryFile.path,
      filename: this.activeBinaryFile.filename,
      isDirty: false,
      isActive: true,
      language: this.activeBinaryFile.language,
      hasExternalChange: false,
      showWarning: false,
      isBinary: true  // Flag to indicate this is a binary preview
    }];
  }

  /**
   * Destroy component
   */
  destroy() {
    this.removeAllListeners();

    if (this.pendingLayoutFrame) {
      cancelAnimationFrame(this.pendingLayoutFrame);
      this.pendingLayoutFrame = null;
    }

    // Dispose diff editor if it exists
    if (this.diffEditor) {
      this.diffEditor.dispose();
      this.diffEditor = null;
    }

    // Remove listeners
    this.removePreviewListener();
    this.removeDiffListener();

    if (this.menuBar) {
      this.menuBar.destroy();
    }

    if (this.editorTabs) {
      this.editorTabs.destroy();
    }

    if (this.externalChangeWarning) {
      this.externalChangeWarning.destroy();
    }

    if (this.diffModal) {
      this.diffModal.destroy();
    }

    if (this.editorManager) {
      this.editorManager.destroy();
    }

    if (this.panel && this.panel.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }

    this.panel = null;
    this.editorContainer = null;
    this.diffContainer = null;
    this.edgeToggleButton = null;
  }
}
