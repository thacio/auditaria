/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from '../utils/EventEmitter.js';
import { DiffContextMenu } from './DiffContextMenu.js';

/**
 * Diff Modal Component
 *
 * Shows Monaco diff editor in a modal overlay with side-by-side comparison.
 *
 * Layout:
 *   - Left panel:  "Your Changes (Unsaved)" — read-only, with "Use This Version" button
 *   - Right panel: "Disk Version" — editable (user can revert hunks or edit), with "Use This Version" button
 *   - Cancel button at the bottom
 *
 * "Use This Version" on left  → keeps the editor content as-is, dismisses the warning
 * "Use This Version" on right → applies the right panel content (possibly edited) to the editor
 * Cancel → closes without any changes
 */
export class DiffModal extends EventEmitter {
  constructor(editorManager) {
    super();
    this.editorManager = editorManager;

    // UI elements
    this.modal = null;
    this.overlay = null;
    this.diffContainer = null;
    this.useLeftBtn = null;
    this.useRightBtn = null;
    this.cancelBtn = null;
    this.closeBtn = null;

    // State
    this.isVisible = false;
    this.currentPath = null;
    this.diffEditor = null;
    this.diffContextMenu = null;
    this.contentUpdateListener = null;

    this.initialize();
  }

  initialize() {
    this.createElements();
    this.setupEventHandlers();
  }

  createElements() {
    // Create overlay
    this.overlay = document.createElement('div');
    this.overlay.className = 'diff-modal-overlay';
    this.overlay.style.display = 'none';

    // Create modal
    this.modal = document.createElement('div');
    this.modal.className = 'diff-modal';

    this.modal.innerHTML = `
      <div class="diff-modal-header">
        <h3 class="diff-modal-title">View Changes</h3>
        <button class="diff-modal-close" title="Close" aria-label="Close">\u2715</button>
      </div>
      <div class="diff-modal-body">
        <div class="diff-modal-legend">
          <div class="diff-legend-side left">
            <span class="diff-legend-label left">Your Changes (Unsaved)</span>
          </div>
          <div class="diff-legend-side right">
            <span class="diff-legend-label right">Disk Version</span>
          </div>
        </div>
        <div class="diff-modal-editor" id="diff-modal-editor"></div>
      </div>
      <div class="diff-modal-footer">
        <div class="diff-footer-zone left">
          <button class="diff-modal-action diff-action-use-left" title="Keep your current editor content">
            <span class="codicon codicon-check"></span>
            Use This Version
          </button>
        </div>
        <div class="diff-footer-zone center">
          <button class="diff-modal-action diff-action-cancel">
            Cancel
          </button>
        </div>
        <div class="diff-footer-zone right">
          <button class="diff-modal-action diff-action-use-right" title="Apply this content (including any edits you made here)">
            <span class="codicon codicon-check"></span>
            Use This Version
          </button>
        </div>
      </div>
    `;

    this.overlay.appendChild(this.modal);
    document.body.appendChild(this.overlay);

    // Get references
    this.diffContainer = this.modal.querySelector('#diff-modal-editor');
    this.useLeftBtn = this.modal.querySelector('.diff-action-use-left');
    this.useRightBtn = this.modal.querySelector('.diff-action-use-right');
    this.cancelBtn = this.modal.querySelector('.diff-action-cancel');
    this.closeBtn = this.modal.querySelector('.diff-modal-close');
  }

  setupEventHandlers() {
    // Close overlay on click
    if (this.overlay) {
      this.overlay.addEventListener('click', (e) => {
        if (e.target === this.overlay) {
          this.hide();
        }
      });
    }

    // Close button
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => this.hide());
    }

    // Use Left (keep editor content as-is)
    if (this.useLeftBtn) {
      this.useLeftBtn.addEventListener('click', () => {
        if (this.currentPath) {
          this.editorManager.keepMyVersion(this.currentPath);
          this.hide();
        }
      });
    }

    // Use Right (apply the right panel content, possibly edited)
    if (this.useRightBtn) {
      this.useRightBtn.addEventListener('click', () => {
        if (this.currentPath && this.diffEditor) {
          const modifiedModel = this.diffEditor.getModifiedEditor().getModel();
          if (modifiedModel) {
            const mergedContent = modifiedModel.getValue();
            this.editorManager.useMergedVersion(this.currentPath, mergedContent);
          }
          this.hide();
        }
      });
    }

    // Cancel
    if (this.cancelBtn) {
      this.cancelBtn.addEventListener('click', () => this.hide());
    }

    // ESC key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isVisible) {
        this.hide();
      }
    });

    // Listen to EditorManager events
    this.editorManager.on('show-diff-modal', ({ path, originalContent, modifiedContent, language }) => {
      this.show(path, originalContent, modifiedContent, language);
    });

    this.editorManager.on('close-diff-modal', () => {
      this.hide();
    });
  }

  async show(path, originalContent, modifiedContent, language) {
    this.currentPath = path;
    this.isVisible = true;
    this.overlay.style.display = 'flex';

    // Always ensure we have a fresh diff editor
    if (!this.diffEditor && this.diffContainer && this.editorManager.monaco) {
      this.diffEditor = this.editorManager.monaco.editor.createDiffEditor(this.diffContainer, {
        renderSideBySide: true,
        originalEditable: false,
        enableSplitViewResizing: true,
        hideUnchangedRegions: { enabled: true },
        automaticLayout: true,
        readOnly: false,  // Allow editing modified side for selective revert (Ctrl+Z works)
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        wordWrap: 'on',
        diffWordWrap: 'on'
      });

      // Attach right-click "Revert This Change" context menu
      this.diffContextMenu = new DiffContextMenu(this.diffEditor, this.editorManager.monaco);
    }

    if (this.diffEditor && this.editorManager.monaco) {
      // Dispose old models safely
      const oldModel = this.diffEditor.getModel();
      if (oldModel && oldModel.original && oldModel.modified) {
        try {
          oldModel.original.dispose();
          oldModel.modified.dispose();
        } catch (e) {
          console.warn('Error disposing old models:', e);
        }
      }

      // Create fresh models with unique URIs
      const timestamp = Date.now();
      const originalUri = this.editorManager.monaco.Uri.parse(`inmemory://diff-original-${timestamp}`);
      const modifiedUri = this.editorManager.monaco.Uri.parse(`inmemory://diff-modified-${timestamp}`);

      const originalModel = this.editorManager.monaco.editor.createModel(originalContent, language, originalUri);
      const modifiedModel = this.editorManager.monaco.editor.createModel(modifiedContent, language, modifiedUri);

      // Set models
      this.diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel
      });

      // Force layout update
      setTimeout(() => {
        if (this.diffEditor) {
          this.diffEditor.layout();
        }
      }, 100);
    }

    // Set up listener for real-time updates
    this.setupContentListener();
  }

  /**
   * Set up listener for content changes
   */
  setupContentListener() {
    // Remove existing listener if any
    this.removeContentListener();

    // Listen to editor content changes (when user types in the main editor)
    if (this.editorManager.editor) {
      this.contentUpdateListener = this.editorManager.editor.onDidChangeModelContent(() => {
        if (this.isVisible && this.currentPath) {
          this.updateLeftSideContent();
        }
      });
    }

    // ALSO listen to external file changes
    this.editorManager.on('external-change-warning', ({ path }) => {
      if (this.isVisible && this.currentPath === path) {
        this.updateDiffContent();
      }
    });
  }

  /**
   * Remove content listener
   */
  removeContentListener() {
    if (this.contentUpdateListener) {
      this.contentUpdateListener.dispose();
      this.contentUpdateListener = null;
    }
  }

  /**
   * Update only the left (original) side when the main editor content changes.
   * Preserves the right side (which the user may have edited).
   */
  updateLeftSideContent() {
    if (!this.currentPath) return;

    const fileInfo = this.editorManager.openFiles.get(this.currentPath);
    if (!fileInfo) return;

    if (this.diffEditor && this.editorManager.monaco) {
      const model = this.diffEditor.getModel();
      if (model && model.original) {
        // Update only the original (left) model with the latest editor content
        model.original.setValue(fileInfo.model.getValue());
      }
    }
  }

  /**
   * Update both sides of the diff (e.g. when external file changes while modal is open)
   */
  updateDiffContent() {
    if (!this.currentPath) return;

    const fileInfo = this.editorManager.openFiles.get(this.currentPath);
    if (!fileInfo) return;

    // Get latest content
    const originalContent = fileInfo.model.getValue();
    const modifiedContent = fileInfo.externalContent;
    const language = fileInfo.language;

    // Update the diff editor with fresh content
    if (this.diffEditor && this.editorManager.monaco) {
      // Dispose old models
      const oldModel = this.diffEditor.getModel();
      if (oldModel && oldModel.original && oldModel.modified) {
        try {
          oldModel.original.dispose();
          oldModel.modified.dispose();
        } catch (e) {
          console.warn('Error disposing models during update:', e);
        }
      }

      // Create fresh models with unique URIs
      const timestamp = Date.now();
      const originalUri = this.editorManager.monaco.Uri.parse(`inmemory://diff-original-${timestamp}`);
      const modifiedUri = this.editorManager.monaco.Uri.parse(`inmemory://diff-modified-${timestamp}`);

      const originalModel = this.editorManager.monaco.editor.createModel(originalContent, language, originalUri);
      const modifiedModel = this.editorManager.monaco.editor.createModel(modifiedContent, language, modifiedUri);

      // Set models
      this.diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel
      });
    }
  }

  hide() {
    this.currentPath = null;
    this.isVisible = false;
    this.overlay.style.display = 'none';

    // Remove content listener
    this.removeContentListener();

    // Clear models but keep editor instance for reuse
    if (this.diffEditor) {
      const model = this.diffEditor.getModel();
      if (model && model.original && model.modified) {
        try {
          model.original.dispose();
          model.modified.dispose();
        } catch (e) {
          console.warn('Error disposing models on hide:', e);
        }
      }
      // Clear the model reference
      this.diffEditor.setModel(null);
    }
  }

  destroy() {
    this.removeAllListeners();
    this.removeContentListener();

    if (this.diffContextMenu) {
      this.diffContextMenu.dispose();
      this.diffContextMenu = null;
    }
    if (this.diffEditor) {
      this.diffEditor.dispose();
      this.diffEditor = null;
    }

    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
