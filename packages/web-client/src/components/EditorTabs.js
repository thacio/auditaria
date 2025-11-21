/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Editor tabs component

import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * Editor Tabs Component
 *
 * Renders and manages the tab bar for open files
 * - Displays open files as tabs
 * - Shows active tab
 * - Shows dirty indicators (*)
 * - Handles tab clicks and close buttons
 */
export class EditorTabs extends EventEmitter {
  constructor(editorManager) {
    super();
    this.editorManager = editorManager;

    // UI elements
    this.container = null;
    this.tabsContainer = null;

    // State
    this.tabs = [];

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
    // Get or create container
    this.container = document.getElementById('editor-tabs-container');
    if (!this.container) {
      this.container = this.createTabsElement();
    }

    this.tabsContainer = this.container.querySelector('.editor-tabs');
  }

  /**
   * Create tabs DOM structure
   * @returns {HTMLElement}
   */
  createTabsElement() {
    const container = document.createElement('div');
    container.id = 'editor-tabs-container';
    container.className = 'editor-tabs-container';

    container.innerHTML = `
      <div class="editor-tabs" role="tablist"></div>
    `;

    return container;
  }

  /**
   * Set up event handlers
   */
  setupEventHandlers() {
    // Listen to EditorManager events
    this.editorManager.on('tabs-changed', ({ tabs }) => {
      this.updateTabs(tabs);
    });

    // Delegate click events on tabs container
    if (this.tabsContainer) {
      this.tabsContainer.addEventListener('click', (event) => {
        this.handleTabClick(event);
      });

      // Middle click to close tab
      this.tabsContainer.addEventListener('mousedown', (event) => {
        if (event.button === 1) { // Middle mouse button
          event.preventDefault();
          this.handleTabClick(event, true);
        }
      });
    }
  }

  /**
   * Handle tab click
   * @param {MouseEvent} event
   * @param {boolean} forceClose - Force close action (middle click)
   */
  handleTabClick(event, forceClose = false) {
    const tab = event.target.closest('.editor-tab');
    if (!tab) return;

    const path = tab.dataset.path;
    if (!path) return;

    // Check if close button was clicked
    const closeButton = event.target.closest('.editor-tab-close');
    if (closeButton || forceClose) {
      event.stopPropagation();
      this.emit('tab-close', { path });
      this.editorManager.closeFile(path);
      return;
    }

    // Switch to tab
    this.emit('tab-switch', { path });
    this.editorManager.switchToFile(path);
  }

  /**
   * Update tabs display
   * @param {Array} tabs - Tab information
   */
  updateTabs(tabs) {
    this.tabs = tabs;
    this.render();
  }

  /**
   * Render tabs
   */
  render() {
    if (!this.tabsContainer) return;

    if (this.tabs.length === 0) {
      this.tabsContainer.innerHTML = `
        <div class="editor-tabs-empty">
          <span class="editor-tabs-empty-text">No files open</span>
        </div>
      `;
      return;
    }

    this.tabsContainer.innerHTML = this.tabs.map(tab => {
      const activeClass = tab.isActive ? 'active' : '';
      const dirtyIndicator = tab.isDirty ? '<span class="editor-tab-dirty" title="Unsaved changes">●</span>' : '';

      return `
        <div
          class="editor-tab ${activeClass}"
          data-path="${this.escapeHtml(tab.path)}"
          role="tab"
          aria-selected="${tab.isActive}"
          title="${this.escapeHtml(tab.path)}"
        >
          <span class="editor-tab-icon codicon codicon-file-code"></span>
          <span class="editor-tab-label">${this.escapeHtml(tab.filename)}</span>
          ${dirtyIndicator}
          <button
            class="editor-tab-close"
            aria-label="Close ${this.escapeHtml(tab.filename)}"
            title="Close (Ctrl+W)"
          >
            <span class="codicon codicon-close"></span>
          </button>
        </div>
      `;
    }).join('');
  }

  /**
   * Escape HTML to prevent XSS
   * @param {string} text
   * @returns {string}
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
    this.tabsContainer = null;
  }
}
