/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * Diff Modal Component
 *
 * Shows Monaco diff editor in a modal overlay
 * - Side-by-side comparison
 * - Actions: Use Disk Version, Keep My Version, Cancel
 */
export class DiffModal extends EventEmitter {
  constructor(editorManager) {
    super();
    this.editorManager = editorManager;

    // UI elements
    this.modal = null;
    this.overlay = null;
    this.diffContainer = null;
    this.useDiskBtn = null;
    this.keepMineBtn = null;
    this.cancelBtn = null;
    this.closeBtn = null;

    // State
    this.isVisible = false;
    this.currentPath = null;
    this.diffEditor = null;

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
        <button class="diff-modal-close" title="Close" aria-label="Close">✕</button>
      </div>
      <div class="diff-modal-body">
        <div class="diff-modal-legend">
          <span class="diff-legend-item">
            <span class="diff-legend-label left">Your Changes (Unsaved)</span>
          </span>
          <span class="diff-legend-item">
            <span class="diff-legend-label right">Changes on Disk</span>
          </span>
        </div>
        <div class="diff-modal-editor" id="diff-modal-editor"></div>
      </div>
      <div class="diff-modal-footer">
        <button class="diff-modal-action diff-action-use-disk">
          <span class="codicon codicon-cloud-download"></span>
          Use Disk Version
        </button>
        <button class="diff-modal-action diff-action-keep-mine">
          <span class="codicon codicon-save"></span>
          Keep My Version
        </button>
        <button class="diff-modal-action diff-action-cancel">
          Cancel
        </button>
      </div>
    `;

    this.overlay.appendChild(this.modal);
    document.body.appendChild(this.overlay);

    // Get references
    this.diffContainer = this.modal.querySelector('#diff-modal-editor');
    this.useDiskBtn = this.modal.querySelector('.diff-action-use-disk');
    this.keepMineBtn = this.modal.querySelector('.diff-action-keep-mine');
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

    // Use Disk Version
    if (this.useDiskBtn) {
      this.useDiskBtn.addEventListener('click', () => {
        if (this.currentPath) {
          this.editorManager.useDiskVersion(this.currentPath);
          this.hide();
        }
      });
    }

    // Keep My Version
    if (this.keepMineBtn) {
      this.keepMineBtn.addEventListener('click', () => {
        if (this.currentPath) {
          this.editorManager.keepMyVersion(this.currentPath);
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
    console.log(`DiffModal.show() called for: ${path}`);
    console.log(`  Received originalContent: ${originalContent.length} chars`);
    console.log(`  Received modifiedContent: ${modifiedContent.length} chars`);
    console.log(`  First 50 chars of modified: "${modifiedContent.substring(0, 50)}..."`);

    this.currentPath = path;
    this.isVisible = true;
    this.overlay.style.display = 'flex';

    // Always ensure we have a fresh diff editor
    if (!this.diffEditor && this.diffContainer && this.editorManager.monaco) {
      console.log(`  Creating new diff editor`);
      this.diffEditor = this.editorManager.monaco.editor.createDiffEditor(this.diffContainer, {
        renderSideBySide: true,
        originalEditable: false,
        enableSplitViewResizing: true,
        hideUnchangedRegions: { enabled: true },
        automaticLayout: true,
        readOnly: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false }
      });
    }

    if (this.diffEditor && this.editorManager.monaco) {
      // Dispose old models safely
      const oldModel = this.diffEditor.getModel();
      if (oldModel && oldModel.original && oldModel.modified) {
        console.log(`  Disposing old models`);
        try {
          oldModel.original.dispose();
          oldModel.modified.dispose();
        } catch (e) {
          console.warn('Error disposing old models:', e);
        }
      }

      // Create fresh models with unique URIs
      console.log(`  Creating fresh models`);
      const timestamp = Date.now();
      const originalUri = this.editorManager.monaco.Uri.parse(`inmemory://diff-original-${timestamp}`);
      const modifiedUri = this.editorManager.monaco.Uri.parse(`inmemory://diff-modified-${timestamp}`);

      const originalModel = this.editorManager.monaco.editor.createModel(originalContent, language, originalUri);
      const modifiedModel = this.editorManager.monaco.editor.createModel(modifiedContent, language, modifiedUri);

      console.log(`  Setting models on diff editor`);
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

    console.log(`Diff modal opened for: ${path}`);
  }

  hide() {
    this.currentPath = null;
    this.isVisible = false;
    this.overlay.style.display = 'none';

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

    if (this.diffEditor) {
      this.diffEditor.dispose();
      this.diffEditor = null;
    }

    if (this.overlay && this.overlay.parentNode) {
      this.overlay.parentNode.removeChild(this.overlay);
    }
  }
}
