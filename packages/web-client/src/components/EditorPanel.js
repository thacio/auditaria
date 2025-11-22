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
    this.closeButton = null;
    this.collapseButton = null;
    this.expandTab = null;
    this.resizeHandle = null;
    this.splitResizeHandle = null;
    this.diffContainer = null;

    // Components
    this.menuBar = null;
    this.editorTabs = null;
    this.externalChangeWarning = null;
    this.diffModal = null;

    // State
    this.isVisible = false;
    this.isCollapsed = false;
    this.isPreviewMode = false;
    this.isSplitMode = false;
    this.isDiffMode = false;
    this.isBinaryPreviewMode = false; // Binary files can only be previewed, not edited
    this.activeBinaryFile = null; // Store binary file info { path, language, filename }
    this.previewUpdateListener = null;
    this.diffUpdateListener = null;
    this.diffEditor = null;

    // Resize state
    this.isResizing = false;
    this.panelWidth = 50; // Default 50% width
    this.minWidth = 400; // Minimum 400px
    this.maxWidth = 80; // Maximum 80% of viewport

    // Split view resize state
    this.isSplitResizing = false;
    this.splitRatio = 50; // Default 50/50 split (percentage for code editor)

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
    this.closeButton = document.getElementById('editor-close-button');
    this.collapseButton = document.getElementById('editor-collapse-button');
    this.expandTab = document.getElementById('editor-expand-tab');
    this.resizeHandle = document.getElementById('editor-resize-handle');
    this.splitResizeHandle = document.getElementById('split-resize-handle');
    this.diffContainer = document.getElementById('monaco-diff-container');

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
    panel.className = 'editor-panel';

    panel.innerHTML = `
      <div class="editor-resize-handle" id="editor-resize-handle"></div>
      <button class="editor-expand-tab" id="editor-expand-tab" title="Show editor" aria-label="Show editor">
        <span class="codicon codicon-chevron-left"></span>
      </button>
      <div class="editor-header">
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

          <div class="editor-toolbar-spacer"></div>

          <button
            id="editor-collapse-button"
            class="editor-toolbar-button"
            title="Hide editor"
            aria-label="Hide editor"
          >
            <span class="codicon codicon-chevron-right"></span>
          </button>

          <button
            id="editor-close-button"
            class="editor-toolbar-button editor-close-button"
            title="Close editor"
            aria-label="Close editor"
          >
            <span class="codicon codicon-close"></span>
          </button>
        </div>
      </div>

      <div class="editor-content">
        <div id="monaco-editor-container" class="monaco-editor-container"></div>
        <div id="monaco-diff-container" class="monaco-diff-container" style="display: none;"></div>
        <div id="split-resize-handle" class="split-resize-handle" style="display: none;"></div>
        <div id="markdown-preview-container" class="markdown-preview-container" style="display: none;"></div>
      </div>
    `;

    return panel;
  }

  /**
   * Insert panel into DOM
   */
  insertPanelIntoDOM() {
    // Find main content area
    const appContainer = document.querySelector('.app-container') ||
                        document.querySelector('.main') ||
                        document.body;

    // Append panel
    appContainer.appendChild(this.panel);
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
   * Show code editor
   */
  showEditor() {
    const editorContainer = document.getElementById('monaco-editor-container');
    const previewContainer = document.getElementById('markdown-preview-container');

    // Remove split mode classes
    if (editorContainer) {
      editorContainer.classList.remove('split-view');
      editorContainer.style.display = 'block';
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
    const activeFile = this.editorManager.getActiveFile();
    if (activeFile) {
      const fileInfo = this.editorManager.openFiles.get(activeFile);
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
        theme: 'vs',
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

    // Extract filename from path if not provided
    if (!filename && activeFile) {
      filename = activeFile.split('/').pop() || activeFile;
    }

    // If in binary preview mode, use activeBinaryFile for filename
    if (this.isBinaryPreviewMode && this.activeBinaryFile) {
      filename = this.activeBinaryFile.filename;
    }

    // Check if preview is available for this file type
    const canPreview = this.previewManager && this.previewManager.canPreview(language, filename);
    const activePreview = canPreview ? this.previewManager.getPreviewerFor(language, filename) : null;

    // Binary preview mode: Only show Preview button, hide Code/Split
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
    this.saveButton.disabled = !fileInfo || !fileInfo.isDirty;
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
    if (this.panelWidth) {
      this.panel.style.width = `${this.panelWidth}%`;
    }

    // Update collapse button icon
    if (this.collapseButton) {
      this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-right';
      this.collapseButton.title = 'Hide editor';
    }

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
    this.panel.classList.remove('collapsed');
    this.isVisible = false;
    this.isCollapsed = false;

    // Clear inline width so CSS can fully control visibility
    this.panel.style.width = '';

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
        if (this.collapseButton) {
          this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-left';
          this.collapseButton.title = 'Show editor';
        }
      }
    } else {
      // Medium and large screens: If collapsed due to auto-collapse, restore to expanded
      if (this.isVisible && this.isCollapsed) {
        this.isCollapsed = false;
        this.panel.classList.add('visible');
        this.panel.classList.remove('collapsed');
        if (this.collapseButton) {
          this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-right';
          this.collapseButton.title = 'Hide editor';
        }
      }
    }
  }

  /**
   * Toggle panel collapse state
   */
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;

    if (this.isCollapsed) {
      // When collapsing, remove .visible and add .collapsed
      this.panel.classList.remove('visible');
      this.panel.classList.add('collapsed');
      // Clear inline width so CSS can control the collapse
      this.panel.style.width = '';
      this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-left';
      this.collapseButton.title = 'Show editor';
    } else {
      // When expanding, add .visible and remove .collapsed
      this.panel.classList.add('visible');
      this.panel.classList.remove('collapsed');
      // Restore the saved width when expanding
      if (this.panelWidth) {
        this.panel.style.width = `${this.panelWidth}%`;
      }
      this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-right';
      this.collapseButton.title = 'Hide editor';
    }

    this.saveState();
    this.emit('collapse-changed', { isCollapsed: this.isCollapsed });
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
    alert(`Error: ${message}`);
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
    const mouseX = e.clientX;

    // Calculate new width as percentage from the right edge
    const distanceFromRight = viewportWidth - mouseX;
    let newWidthPercent = (distanceFromRight / viewportWidth) * 100;

    // Apply constraints
    const minWidthPercent = (this.minWidth / viewportWidth) * 100;
    newWidthPercent = Math.max(minWidthPercent, Math.min(this.maxWidth, newWidthPercent));

    // Update panel width
    this.panelWidth = newWidthPercent;
    this.panel.style.width = `${newWidthPercent}%`;

    // Trigger Monaco editor layout update
    if (this.editorManager.editor) {
      setTimeout(() => {
        this.editorManager.editor.layout();
      }, 0);
    }
  }

  /**
   * Stop resizing the panel
   */
  stopResize() {
    if (!this.isResizing) return;

    this.isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Remove event listeners
    document.removeEventListener('mousemove', this.boundDoResize);
    document.removeEventListener('mouseup', this.boundStopResize);

    // Save width to localStorage
    this.saveState();
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
    if (this.editorManager.editor) {
      setTimeout(() => {
        this.editorManager.editor.layout();
      }, 0);
    }
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
      const saved = localStorage.getItem('auditaria_editor_panel_state');
      if (saved) {
        const state = JSON.parse(saved);
        // Don't auto-show on load, only show when file is opened
        // this.isVisible = state.isVisible || false;

        // Restore panel width value but DON'T apply as inline style
        // The inline style would override CSS and make panel visible
        // Width will be applied when panel is shown via show() method
        if (state.panelWidth) {
          this.panelWidth = state.panelWidth;
          // DON'T set: this.panel.style.width = `${this.panelWidth}%`;
        }

        // Restore split ratio
        if (state.splitRatio) {
          this.splitRatio = state.splitRatio;
        }
      }
    } catch (error) {
      console.error('Failed to load editor panel state:', error);
    }
  }

  /**
   * Save state to localStorage
   */
  saveState() {
    try {
      const state = {
        // Don't save isVisible - panel should always start closed
        panelWidth: this.panelWidth,
        splitRatio: this.splitRatio
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
  }
}
