/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Monaco Editor manager for code editing

import { EventEmitter } from '../utils/EventEmitter.js';
import { detectLanguage, getDefaultTabSize } from '../utils/languageDetection.js';

/**
 * Monaco Editor Manager
 *
 * Manages Monaco editor instances and file editing
 * - Loads Monaco from CDN
 * - Creates/destroys editor instances
 * - Manages multiple open files (tabs)
 * - Tracks dirty state per file
 * - Handles save operations
 * - Manages cursor positions and scroll state
 */
export class EditorManager extends EventEmitter {
  constructor(wsManager) {
    super();
    this.wsManager = wsManager;

    // Monaco state
    this.monaco = null;
    this.editor = null;
    this.isMonacoLoaded = false;
    this.isMonacoLoading = false;

    // File state
    this.openFiles = new Map(); // path -> { content, language, isDirty, model, savedContent }
    this.activeFile = null;
    this.tabOrder = [];

    // View state (cursor, scroll positions)
    this.viewStates = new Map(); // path -> ViewState

    // Editor container
    this.editorContainer = null;

    // Setup WebSocket handlers
    this.setupMessageHandlers();

    // Load persisted state
    this.loadState();
  }

  /**
   * Initialize editor manager
   * @param {HTMLElement} container - Container element for Monaco editor
   */
  async initialize(container) {
    this.editorContainer = container;

    try {
      await this.loadMonaco();
      this.emit('monaco-loaded');
    } catch (error) {
      console.error('Failed to load Monaco:', error);
      this.emit('error', { message: 'Failed to load code editor' });
    }
  }

  /**
   * Setup WebSocket message handlers
   */
  setupMessageHandlers() {
    // Handle file read response
    this.wsManager.addEventListener('file_read_response', (event) => {
      this.handleFileReadResponse(event.detail);
    });

    // Handle file write response
    this.wsManager.addEventListener('file_write_response', (event) => {
      this.handleFileWriteResponse(event.detail);
    });

    // Handle file operation errors
    this.wsManager.addEventListener('file_operation_error', (event) => {
      this.handleFileOperationError(event.detail);
    });
  }

  /**
   * Load Monaco Editor from CDN
   * @returns {Promise<Object>} Monaco API
   */
  async loadMonaco() {
    if (this.isMonacoLoaded && window.monaco) {
      return window.monaco;
    }

    if (this.isMonacoLoading) {
      // Wait for existing load to complete
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.isMonacoLoaded && window.monaco) {
            clearInterval(checkInterval);
            resolve(window.monaco);
          }
        }, 100);
      });
    }

    this.isMonacoLoading = true;

    return new Promise((resolve, reject) => {
      // Load AMD loader
      const loaderScript = document.createElement('script');
      loaderScript.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';

      loaderScript.onload = () => {
        // Configure paths
        window.require.config({
          paths: {
            vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'
          }
        });

        // Load Monaco
        window.require(['vs/editor/editor.main'], () => {
          this.monaco = window.monaco;
          this.isMonacoLoaded = true;
          this.isMonacoLoading = false;
          console.log('Monaco Editor loaded successfully');
          resolve(window.monaco);
        });
      };

      loaderScript.onerror = () => {
        this.isMonacoLoading = false;
        reject(new Error('Failed to load Monaco Editor from CDN'));
      };

      document.head.appendChild(loaderScript);
    });
  }

  /**
   * Request file from server
   * @param {string} path - File path
   */
  requestFile(path) {
    this.wsManager.send({
      type: 'file_read_request',
      path
    });

    this.emit('loading', { path, isLoading: true });
  }

  /**
   * Handle file read response from server
   * @param {Object} data - File content data
   */
  handleFileReadResponse(data) {
    const { path, content, size } = data;

    this.emit('loading', { path, isLoading: false });

    // Detect language
    const filename = path.split('/').pop() || path;
    const language = detectLanguage(filename);

    // Open file in editor
    this.openFile(path, content, language);
  }

  /**
   * Handle file write response from server
   * @param {Object} data - Write response
   */
  handleFileWriteResponse(data) {
    const { success, path, message } = data;

    if (success && path) {
      // Mark file as clean (saved)
      this.markFileClean(path);
      this.emit('file-saved', { path, message });
      console.log(`File saved: ${path}`);
    }
  }

  /**
   * Handle file operation error
   * @param {Object} error - Error data
   */
  handleFileOperationError(error) {
    this.emit('loading', { path: error.path, isLoading: false });
    this.emit('error', {
      operation: error.operation,
      path: error.path,
      message: error.error
    });
    console.error(`File operation error:`, error);
  }

  /**
   * Open a file in the editor
   * @param {string} path - File path
   * @param {string} content - File content
   * @param {string} language - Programming language
   */
  openFile(path, content, language) {
    if (!this.monaco || !this.editorContainer) {
      console.error('Monaco editor not initialized');
      return;
    }

    // Check if already open
    if (this.openFiles.has(path)) {
      this.switchToFile(path);
      return;
    }

    // Create model URI
    const uri = this.monaco.Uri.file(path);

    // Check if model exists
    let model = this.monaco.editor.getModel(uri);

    if (!model) {
      // Create new model
      model = this.monaco.editor.createModel(content, language, uri);

      // Listen for content changes
      model.onDidChangeContent(() => {
        this.markFileDirty(path);
      });
    }

    // Store file info
    this.openFiles.set(path, {
      content,
      savedContent: content, // Track original content for dirty detection
      language,
      isDirty: false,
      model,
      path
    });

    // Add to tab order
    this.tabOrder.push(path);

    // Switch to this file
    this.switchToFile(path);

    // Emit events
    this.emit('file-opened', { path, language });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

    // Save state
    this.saveState();
  }

  /**
   * Switch to a different file
   * @param {string} path - File path
   */
  switchToFile(path) {
    if (!this.openFiles.has(path)) {
      console.warn(`File not open: ${path}`);
      return;
    }

    const fileInfo = this.openFiles.get(path);

    // Save current view state
    if (this.activeFile && this.editor) {
      this.viewStates.set(this.activeFile, this.editor.saveViewState());
    }

    // Create editor if needed
    if (!this.editor) {
      this.createEditor(fileInfo.model);
    } else {
      // Switch model
      this.editor.setModel(fileInfo.model);
    }

    // Restore view state
    const viewState = this.viewStates.get(path);
    if (viewState) {
      this.editor.restoreViewState(viewState);
    }

    this.activeFile = path;

    // Focus editor
    this.editor.focus();

    // Emit events
    this.emit('file-switched', { path });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

    // Save state
    this.saveState();
  }

  /**
   * Create Monaco editor instance
   * @param {Object} model - Monaco model
   */
  createEditor(model) {
    if (!this.editorContainer) {
      console.error('Editor container not set');
      return;
    }

    this.editor = this.monaco.editor.create(this.editorContainer, {
      model: model,
      theme: 'vs',
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      lineNumbers: 'on',
      roundedSelection: false,
      scrollBeyondLastLine: false,
      readOnly: false,
      cursorStyle: 'line',
      wordWrap: 'on',
      tabSize: getDefaultTabSize(model.getLanguageId()),
      insertSpaces: true,
      renderWhitespace: 'selection',
      bracketPairColorization: {
        enabled: true
      },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10
      },
      suggestOnTriggerCharacters: true,
      acceptSuggestionOnEnter: 'on',
      quickSuggestions: true
    });

    // Editor is created
    this.emit('editor-created');
  }

  /**
   * Save active file
   */
  async saveActiveFile() {
    if (!this.activeFile) {
      console.warn('No active file to save');
      return;
    }

    await this.saveFile(this.activeFile);
  }

  /**
   * Save a specific file
   * @param {string} path - File path
   */
  async saveFile(path) {
    const fileInfo = this.openFiles.get(path);
    if (!fileInfo) {
      console.warn(`File not open: ${path}`);
      return;
    }

    const content = fileInfo.model.getValue();

    // Send save request
    this.wsManager.send({
      type: 'file_write_request',
      path,
      content
    });

    this.emit('saving', { path });
  }

  /**
   * Close a file
   * @param {string} path - File path
   * @returns {Promise<boolean>} true if closed, false if cancelled
   */
  async closeFile(path) {
    const fileInfo = this.openFiles.get(path);
    if (!fileInfo) {
      return true;
    }

    // Check for unsaved changes
    if (fileInfo.isDirty) {
      const confirmed = await this.confirmCloseUnsaved(path);
      if (!confirmed) {
        return false;
      }
    }

    // Save view state before closing
    if (this.activeFile === path && this.editor) {
      this.viewStates.set(path, this.editor.saveViewState());
    }

    // Dispose model
    if (fileInfo.model) {
      fileInfo.model.dispose();
    }

    // Remove from tracking
    this.openFiles.delete(path);
    this.viewStates.delete(path);
    this.tabOrder = this.tabOrder.filter(p => p !== path);

    // If this was active file, switch to another
    if (this.activeFile === path) {
      if (this.tabOrder.length > 0) {
        // Switch to last tab
        this.switchToFile(this.tabOrder[this.tabOrder.length - 1]);
      } else {
        this.activeFile = null;
        if (this.editor) {
          this.editor.setModel(null);
        }
      }
    }

    // Emit events
    this.emit('file-closed', { path });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

    // Save state
    this.saveState();

    return true;
  }

  /**
   * Confirm closing file with unsaved changes
   * @param {string} path - File path
   * @returns {Promise<boolean>}
   */
  async confirmCloseUnsaved(path) {
    const filename = path.split('/').pop() || path;
    return confirm(`Do you want to close "${filename}" without saving?\n\nUnsaved changes will be lost.`);
  }

  /**
   * Mark file as dirty (has unsaved changes)
   * @param {string} path - File path
   */
  markFileDirty(path) {
    const fileInfo = this.openFiles.get(path);
    if (fileInfo && !fileInfo.isDirty) {
      const currentContent = fileInfo.model.getValue();
      const isDirty = currentContent !== fileInfo.savedContent;

      if (isDirty) {
        fileInfo.isDirty = true;
        this.emit('dirty-changed', { path, isDirty: true });
        this.emit('tabs-changed', { tabs: this.getTabsInfo() });
      }
    }
  }

  /**
   * Mark file as clean (saved)
   * @param {string} path - File path
   */
  markFileClean(path) {
    const fileInfo = this.openFiles.get(path);
    if (fileInfo) {
      const content = fileInfo.model.getValue();
      fileInfo.isDirty = false;
      fileInfo.savedContent = content;
      this.emit('dirty-changed', { path, isDirty: false });
      this.emit('tabs-changed', { tabs: this.getTabsInfo() });
    }
  }

  /**
   * Get tabs information
   * @returns {Array}
   */
  getTabsInfo() {
    return this.tabOrder.map(path => {
      const fileInfo = this.openFiles.get(path);
      const filename = path.split('/').pop() || path;

      return {
        path,
        filename,
        isDirty: fileInfo ? fileInfo.isDirty : false,
        isActive: path === this.activeFile,
        language: fileInfo ? fileInfo.language : 'plaintext'
      };
    });
  }

  /**
   * Get active file path
   * @returns {string|null}
   */
  getActiveFile() {
    return this.activeFile;
  }

  /**
   * Get open files count
   * @returns {number}
   */
  getOpenFilesCount() {
    return this.openFiles.size;
  }

  /**
   * Check if file is open
   * @param {string} path - File path
   * @returns {boolean}
   */
  isFileOpen(path) {
    return this.openFiles.has(path);
  }

  /**
   * Close all files
   * @returns {Promise<boolean>} true if all closed, false if cancelled
   */
  async closeAllFiles() {
    // Check for any dirty files
    const dirtyFiles = Array.from(this.openFiles.entries())
      .filter(([_, info]) => info.isDirty)
      .map(([path, _]) => path);

    if (dirtyFiles.length > 0) {
      const confirmed = confirm(
        `You have ${dirtyFiles.length} unsaved file(s).\n\nClose all files without saving?`
      );
      if (!confirmed) {
        return false;
      }
    }

    // Close all files
    const paths = Array.from(this.openFiles.keys());
    for (const path of paths) {
      const fileInfo = this.openFiles.get(path);
      if (fileInfo && fileInfo.model) {
        fileInfo.model.dispose();
      }
      this.openFiles.delete(path);
    }

    this.tabOrder = [];
    this.activeFile = null;
    this.viewStates.clear();

    if (this.editor) {
      this.editor.setModel(null);
    }

    this.emit('tabs-changed', { tabs: [] });
    this.saveState();

    return true;
  }

  /**
   * Load state from localStorage
   */
  loadState() {
    // Don't restore any editor state - always start fresh
    // This ensures the editor panel starts closed on page load
  }

  /**
   * Save state to localStorage (debounced)
   */
  saveState() {
    // Don't persist editor state - always start fresh on page load
    // This ensures the editor panel starts closed
  }

  /**
   * Destroy editor and clean up
   */
  destroy() {
    // Dispose all models
    for (const [_, fileInfo] of this.openFiles) {
      if (fileInfo.model) {
        fileInfo.model.dispose();
      }
    }

    // Dispose editor
    if (this.editor) {
      this.editor.dispose();
      this.editor = null;
    }

    // Clear state
    this.openFiles.clear();
    this.viewStates.clear();
    this.tabOrder = [];
    this.activeFile = null;

    // Remove event listeners
    this.removeAllListeners();
  }
}
