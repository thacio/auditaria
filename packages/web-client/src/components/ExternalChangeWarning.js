/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * External Change Warning Component
 *
 * Shows an inline warning bar when file is modified externally
 * - Non-blocking (user can continue editing)
 * - Clear actions: View Diff, Reload, Keep Changes
 * - Dismissible
 */
export class ExternalChangeWarning extends EventEmitter {
  constructor(editorManager) {
    super();
    this.editorManager = editorManager;

    // UI elements
    this.container = null;
    this.messageEl = null;
    this.viewDiffBtn = null;
    this.reloadBtn = null;
    this.keepBtn = null;
    this.dismissBtn = null;

    // State
    this.currentPath = null;
    this.isVisible = false;

    this.initialize();
  }

  /**
   * Initialize component
   */
  initialize() {
    this.createElements();
    this.setupEventHandlers();
  }

  /**
   * Create UI elements
   */
  createElements() {
    this.container = document.createElement('div');
    this.container.id = 'external-change-warning';
    this.container.className = 'external-change-warning';
    this.container.style.display = 'none';

    this.container.innerHTML = `
      <div class="warning-content">
        <span class="warning-icon">⚠️</span>
        <span class="warning-message">This file was modified on disk</span>
      </div>
      <div class="warning-actions">
        <button class="warning-action warning-view-diff" title="View side-by-side diff">
          <span class="codicon codicon-diff"></span>
          View Diff
        </button>
        <button class="warning-action warning-reload" title="Replace with disk version">
          <span class="codicon codicon-refresh"></span>
          Reload from Disk
        </button>
        <button class="warning-action warning-keep" title="Keep your changes">
          <span class="codicon codicon-edit"></span>
          Keep My Changes
        </button>
        <button class="warning-dismiss" title="Dismiss" aria-label="Dismiss warning">
          ✕
        </button>
      </div>
    `;

    // Get references
    this.messageEl = this.container.querySelector('.warning-message');
    this.viewDiffBtn = this.container.querySelector('.warning-view-diff');
    this.reloadBtn = this.container.querySelector('.warning-reload');
    this.keepBtn = this.container.querySelector('.warning-keep');
    this.dismissBtn = this.container.querySelector('.warning-dismiss');
  }

  /**
   * Setup event handlers
   */
  setupEventHandlers() {
    // View Diff button
    if (this.viewDiffBtn) {
      this.viewDiffBtn.addEventListener('click', () => {
        this.handleViewDiff();
      });
    }

    // Reload from Disk button
    if (this.reloadBtn) {
      this.reloadBtn.addEventListener('click', () => {
        this.handleReload();
      });
    }

    // Keep My Changes button
    if (this.keepBtn) {
      this.keepBtn.addEventListener('click', () => {
        this.handleKeep();
      });
    }

    // Dismiss button
    if (this.dismissBtn) {
      this.dismissBtn.addEventListener('click', () => {
        this.handleDismiss();
      });
    }
  }

  /**
   * Show warning for a file
   * @param {string} path - File path
   */
  show(path) {
    this.currentPath = path;
    this.isVisible = true;
    this.container.style.display = 'flex';

    // Adjust both editor and diff container positions to make room for warning bar
    const warningHeight = this.container.offsetHeight || 45; // Default to 45px if not rendered yet

    const editorContainer = document.getElementById('monaco-editor-container');
    if (editorContainer) {
      editorContainer.style.top = `${warningHeight}px`;
    }

    const diffContainer = document.getElementById('monaco-diff-container');
    if (diffContainer) {
      diffContainer.style.top = `${warningHeight}px`;
    }

    console.log(`Showing external change warning for: ${path}`);
  }

  /**
   * Hide warning
   */
  hide() {
    this.currentPath = null;
    this.isVisible = false;
    this.container.style.display = 'none';

    // Reset both container positions
    const editorContainer = document.getElementById('monaco-editor-container');
    if (editorContainer) {
      editorContainer.style.top = '0';
    }

    const diffContainer = document.getElementById('monaco-diff-container');
    if (diffContainer) {
      diffContainer.style.top = '0';
    }
  }

  /**
   * Handle View Diff button click
   */
  handleViewDiff() {
    if (!this.currentPath) return;
    console.log(`View Diff clicked for: ${this.currentPath}`);
    this.editorManager.viewDiff(this.currentPath);
  }

  /**
   * Handle Reload from Disk button click
   */
  handleReload() {
    if (!this.currentPath) return;
    console.log(`Reload from Disk clicked for: ${this.currentPath}`);
    this.editorManager.reloadFromDisk(this.currentPath);
    this.hide();
  }

  /**
   * Handle Keep My Changes button click
   */
  handleKeep() {
    if (!this.currentPath) return;
    console.log(`Keep My Changes clicked for: ${this.currentPath}`);
    this.editorManager.keepMyChanges(this.currentPath);
    this.hide();
  }

  /**
   * Handle Dismiss button click
   */
  handleDismiss() {
    if (!this.currentPath) return;
    console.log(`Dismiss clicked for: ${this.currentPath}`);
    // Same as Keep My Changes
    this.editorManager.keepMyChanges(this.currentPath);
    this.hide();
  }

  /**
   * Get container element
   * @returns {HTMLElement}
   */
  getElement() {
    return this.container;
  }

  /**
   * Destroy component
   */
  destroy() {
    this.removeAllListeners();

    if (this.container && this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.messageEl = null;
    this.viewDiffBtn = null;
    this.reloadBtn = null;
    this.keepBtn = null;
    this.dismissBtn = null;
  }
}
