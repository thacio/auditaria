/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Monaco Editor manager for code editing

import { EventEmitter } from '../utils/EventEmitter.js';
import { detectLanguage, getDefaultTabSize } from '../utils/languageDetection.js';
import { themeManager } from '../utils/theme-manager.js';
import { showErrorToast, showSuccessToast } from '../components/Toast.js';

const MONACO_THEMES = [
  {
    name: 'auditaria-calm-dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '74829b' },
        { token: 'keyword', foreground: '4f7cff' },
        { token: 'number', foreground: 'f59e0b' },
        { token: 'string', foreground: '22c55e' },
        { token: 'type', foreground: '22d3ee' },
        { token: 'function', foreground: '93c5fd' },
        { token: 'variable', foreground: 'e6ebf5' },
      ],
      colors: {
        'editor.background': '#0e131b',
        'editor.foreground': '#e6ebf5',
        'editorLineNumber.foreground': '#5b6b86',
        'editorLineNumber.activeForeground': '#cbd5e1',
        'editor.selectionBackground': '#24314a',
        'editor.inactiveSelectionBackground': '#1b2230',
        'editorCursor.foreground': '#6a90ff',
        'editorWhitespace.foreground': '#27324a',
        'editorIndentGuide.background': '#253148',
        'editorIndentGuide.activeBackground': '#32435d',
        'editorLineHighlightBackground': '#141a24',
        'editorGutter.background': '#0e131b',
      },
    },
  },
  {
    name: 'auditaria-calm-light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '7c8aa0' },
        { token: 'keyword', foreground: '1d4ed8' },
        { token: 'number', foreground: 'd97706' },
        { token: 'string', foreground: '16a34a' },
        { token: 'type', foreground: '0ea5e9' },
        { token: 'function', foreground: '2563eb' },
        { token: 'variable', foreground: '101828' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#101828',
        'editorLineNumber.foreground': '#98a2b3',
        'editorLineNumber.activeForeground': '#475467',
        'editor.selectionBackground': '#dbe7ff',
        'editor.inactiveSelectionBackground': '#eef2f6',
        'editorCursor.foreground': '#2563eb',
        'editorWhitespace.foreground': '#d0d5dd',
        'editorIndentGuide.background': '#d0d5dd',
        'editorIndentGuide.activeBackground': '#b9c0cc',
        'editorLineHighlightBackground': '#f5f7fb',
        'editorGutter.background': '#ffffff',
      },
    },
  },
  {
    name: 'auditaria-studio-dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: 'a99c8f' },
        { token: 'keyword', foreground: 'f59e0b' },
        { token: 'number', foreground: 'f97316' },
        { token: 'string', foreground: '22c55e' },
        { token: 'type', foreground: 'fbbf24' },
        { token: 'function', foreground: 'fde68a' },
        { token: 'variable', foreground: 'f2ece6' },
      ],
      colors: {
        'editor.background': '#14100c',
        'editor.foreground': '#f2ece6',
        'editorLineNumber.foreground': '#8f8274',
        'editorLineNumber.activeForeground': '#e7dccf',
        'editor.selectionBackground': '#3a3026',
        'editor.inactiveSelectionBackground': '#221d18',
        'editorCursor.foreground': '#fbbf24',
        'editorWhitespace.foreground': '#2f2820',
        'editorIndentGuide.background': '#2f2820',
        'editorIndentGuide.activeBackground': '#403528',
        'editorLineHighlightBackground': '#1a1713',
        'editorGutter.background': '#14100c',
      },
    },
  },
  {
    name: 'auditaria-studio-light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8c7b6d' },
        { token: 'keyword', foreground: 'c2410c' },
        { token: 'number', foreground: 'ea580c' },
        { token: 'string', foreground: '16a34a' },
        { token: 'type', foreground: '0ea5e9' },
        { token: 'function', foreground: '9a3412' },
        { token: 'variable', foreground: '1b1410' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#1b1410',
        'editorLineNumber.foreground': '#b1a293',
        'editorLineNumber.activeForeground': '#5b4a3c',
        'editor.selectionBackground': '#fde2c4',
        'editor.inactiveSelectionBackground': '#f3ede4',
        'editorCursor.foreground': '#ea580c',
        'editorWhitespace.foreground': '#dfd4c4',
        'editorIndentGuide.background': '#dfd4c4',
        'editorIndentGuide.activeBackground': '#cdbfae',
        'editorLineHighlightBackground': '#fbf7f1',
        'editorGutter.background': '#ffffff',
      },
    },
  },
  {
    name: 'auditaria-neon-dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6b6890' },
        { token: 'keyword', foreground: 'a855f7' },
        { token: 'number', foreground: 'ec4899' },
        { token: 'string', foreground: '22c55e' },
        { token: 'type', foreground: '06b6d4' },
        { token: 'function', foreground: 'd8b4fe' },
        { token: 'variable', foreground: 'eae8f5' },
      ],
      colors: {
        'editor.background': '#0c0c18',
        'editor.foreground': '#eae8f5',
        'editorLineNumber.foreground': '#5e5b80',
        'editorLineNumber.activeForeground': '#c8c5e0',
        'editor.selectionBackground': '#302e52',
        'editor.inactiveSelectionBackground': '#1a1a2e',
        'editorCursor.foreground': '#c084fc',
        'editorWhitespace.foreground': '#2a2a4a',
        'editorIndentGuide.background': '#2a2a4a',
        'editorIndentGuide.activeBackground': '#3b3b62',
        'editorLineHighlightBackground': '#131320',
        'editorGutter.background': '#0c0c18',
      },
    },
  },
  {
    name: 'auditaria-neon-light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '8a80a8' },
        { token: 'keyword', foreground: '7c3aed' },
        { token: 'number', foreground: 'db2777' },
        { token: 'string', foreground: '16a34a' },
        { token: 'type', foreground: '0d9488' },
        { token: 'function', foreground: '6d28d9' },
        { token: 'variable', foreground: '14101e' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#14101e',
        'editorLineNumber.foreground': '#a89cc0',
        'editorLineNumber.activeForeground': '#4a3f66',
        'editor.selectionBackground': '#e8d8ff',
        'editor.inactiveSelectionBackground': '#f0ecfa',
        'editorCursor.foreground': '#7c3aed',
        'editorWhitespace.foreground': '#d6cee8',
        'editorIndentGuide.background': '#d6cee8',
        'editorIndentGuide.activeBackground': '#c2b8d8',
        'editorLineHighlightBackground': '#f8f5ff',
        'editorGutter.background': '#ffffff',
      },
    },
  },
  {
    name: 'auditaria-forest-dark',
    data: {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6b8a72' },
        { token: 'keyword', foreground: '10b981' },
        { token: 'number', foreground: 'f59e0b' },
        { token: 'string', foreground: '84cc16' },
        { token: 'type', foreground: '38bdf8' },
        { token: 'function', foreground: '6ee7b7' },
        { token: 'variable', foreground: 'e6f0ea' },
      ],
      colors: {
        'editor.background': '#0c120e',
        'editor.foreground': '#e6f0ea',
        'editorLineNumber.foreground': '#5a7862',
        'editorLineNumber.activeForeground': '#c0d8c6',
        'editor.selectionBackground': '#2c4630',
        'editor.inactiveSelectionBackground': '#1b261e',
        'editorCursor.foreground': '#34d399',
        'editorWhitespace.foreground': '#243828',
        'editorIndentGuide.background': '#243828',
        'editorIndentGuide.activeBackground': '#335a3a',
        'editorLineHighlightBackground': '#141c16',
        'editorGutter.background': '#0c120e',
      },
    },
  },
  {
    name: 'auditaria-forest-light',
    data: {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '7a9682' },
        { token: 'keyword', foreground: '059669' },
        { token: 'number', foreground: 'd97706' },
        { token: 'string', foreground: '16a34a' },
        { token: 'type', foreground: '0ea5e9' },
        { token: 'function', foreground: '047857' },
        { token: 'variable', foreground: '0f1a12' },
      ],
      colors: {
        'editor.background': '#ffffff',
        'editor.foreground': '#0f1a12',
        'editorLineNumber.foreground': '#94b49c',
        'editorLineNumber.activeForeground': '#3a5542',
        'editor.selectionBackground': '#c6ecd0',
        'editor.inactiveSelectionBackground': '#e8f2ea',
        'editorCursor.foreground': '#059669',
        'editorWhitespace.foreground': '#c4d8c8',
        'editorIndentGuide.background': '#c4d8c8',
        'editorIndentGuide.activeBackground': '#a8c4ae',
        'editorLineHighlightBackground': '#f3f8f4',
        'editorGutter.background': '#ffffff',
      },
    },
  },
];

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

    // Diff container
    this.diffContainer = null;

    // Parser state
    this.parserAvailable = false;

    // Track changes callback (provided by EditorPanel)
    this.getTrackChangesEnabled = null;

    // AUDITARIA: Collaborative writing state (AI file tracking)
    this.collaborativeWritingFiles = new Map(); // path -> { startedAt, lastChangeSource }
    this.collaborativeWritingPending = false; // True while waiting for toggle response

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

      // Request parser status from server
      this.wsManager.send({ type: 'parser_status_request' });

      this.emit('monaco-loaded');
    } catch (error) {
      console.error('Failed to load Monaco:', error);
      this.emit('error', { message: 'Failed to load code editor' });
    }
  }

  /**
   * Set the diff container element
   * @param {HTMLElement} container - Container element for diff editor
   */
  setDiffContainer(container) {
    this.diffContainer = container;
  }

  /**
   * Set callback to check if track changes mode is enabled
   * @param {Function} callback - Function that returns boolean
   */
  setTrackChangesCallback(callback) {
    this.getTrackChangesEnabled = callback;
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

    // Handle external file changes
    this.wsManager.addEventListener('file_external_change', (event) => {
      this.handleFileExternalChange(event.detail);
    });

    // Handle external file deletions
    this.wsManager.addEventListener('file_external_delete', (event) => {
      this.handleFileExternalDelete(event.detail);
    });

    // Handle file watch errors
    this.wsManager.addEventListener('file_watch_error', (event) => {
      this.handleFileWatchError(event.detail);
    });

    // Handle parser status updates
    this.wsManager.addEventListener('parser_status', (event) => {
      this.parserAvailable = event.detail.available;
      this.emit('parser-status-changed', { available: this.parserAvailable });

      // If active file is markdown, update toolbar
      const activeFile = this.getActiveFile();
      if (activeFile) {
        const fileInfo = this.openFiles.get(activeFile);
        if (fileInfo && fileInfo.language === 'markdown') {
          this.emit('file-switched', { path: activeFile });
        }
      }
    });

    // Handle parse responses
    this.wsManager.addEventListener('parse_response', (event) => {
      const { outputPath } = event.detail;
      const filename = outputPath ? outputPath.split(/[\\/]/).pop() : 'document.docx';
      showSuccessToast(`Parsed to DOCX: ${filename}`);
    });

    // Handle parse errors
    this.wsManager.addEventListener('parse_error', (event) => {
      showErrorToast(`Parse failed: ${event.detail.error}`);
    });

    // AUDITARIA: Handle collaborative writing status updates
    this.wsManager.addEventListener('collaborative_writing_status', (event) => {
      this.handleCollaborativeWritingStatus(event.detail);
    });

    // AUDITARIA: Handle collaborative writing toggle results
    this.wsManager.addEventListener('collaborative_writing_toggle_result', (event) => {
      this.handleCollaborativeWritingToggleResult(event.detail);
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
          this.registerMonacoThemes();
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
   * Register Auditaria Monaco themes
   */
  registerMonacoThemes() {
    if (!this.monaco || !this.monaco.editor) return;
    MONACO_THEMES.forEach((theme) => {
      this.monaco.editor.defineTheme(theme.name, theme.data);
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

      // Clear external change state if exists
      const fileInfo = this.openFiles.get(path);
      if (fileInfo && fileInfo.hasExternalChange) {
        fileInfo.hasExternalChange = false;
        fileInfo.externalContent = null;
        fileInfo.showWarning = false;
        this.emit('external-warning-dismissed', { path });
        this.emit('tabs-changed', { tabs: this.getTabsInfo() });
      }

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
      savedContent: content,          // Track original content for dirty detection
      language,
      isDirty: false,
      model,
      path,
      hasExternalChange: false,        // File changed on disk
      externalContent: null,           // Content from disk (for diff)
      showWarning: false,              // Show warning bar
      isVirtual: false,
      readOnly: false,
      isUnsupported: false
    });

    // Add to tab order
    this.tabOrder.push(path);

    // Switch to this file
    this.switchToFile(path);

    // Emit events
    this.emit('file-opened', { path, language });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

    // Request server to watch this file for external changes
    this.requestFileWatch(path, content);

    // Save state
    this.saveState();
  }

  /**
   * Open a virtual, read-only file in the editor (no file system watch)
   * @param {string} path - File path for tab display
   * @param {string} content - Virtual content to show
   * @param {string} language - Monaco language ID
   * @param {Object} [options]
   * @param {boolean} [options.readOnly=true]
   * @param {boolean} [options.isUnsupported=false]
   */
  openVirtualFile(path, content, language = 'plaintext', options = {}) {
    if (!this.monaco || !this.editorContainer) {
      console.error('Monaco editor not initialized');
      return;
    }

    const { readOnly = true, isUnsupported = false } = options;

    // Check if already open
    if (this.openFiles.has(path)) {
      const existing = this.openFiles.get(path);
      if (existing) {
        existing.readOnly = readOnly;
        existing.isVirtual = true;
        existing.isUnsupported = isUnsupported;
        if (existing.model && existing.model.getValue() !== content) {
          existing.model.setValue(content);
          existing.savedContent = content;
        }
      }
      this.switchToFile(path);
      return;
    }

    // Use an in-memory URI so we don't collide with real file models
    const uri = this.monaco.Uri.parse(`inmemory://auditaria-virtual/${encodeURIComponent(path)}`);
    let model = this.monaco.editor.getModel(uri);

    if (!model) {
      model = this.monaco.editor.createModel(content, language, uri);
    }

    this.openFiles.set(path, {
      content,
      savedContent: content,
      language,
      isDirty: false,
      model,
      path,
      hasExternalChange: false,
      externalContent: null,
      showWarning: false,
      isVirtual: true,
      readOnly,
      isUnsupported
    });

    this.tabOrder.push(path);
    this.switchToFile(path);

    this.emit('file-opened', { path, language, isVirtual: true, isUnsupported });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

    this.saveState();
  }

  /**
   * Open a binary file as a tab (no editor model, preview-only)
   * Binary files participate in the tab system but are rendered by preview.
   * @param {string} path - File path
   * @param {string} language - Monaco language ID (e.g. 'pdf', 'image')
   * @param {string} filename - Display filename
   */
  openBinaryFile(path, language, filename) {
    // Check if already open
    if (this.openFiles.has(path)) {
      this.switchToFile(path);
      return;
    }

    this.openFiles.set(path, {
      content: null,
      savedContent: null,
      language,
      isDirty: false,
      model: null,
      path,
      hasExternalChange: false,
      externalContent: null,
      showWarning: false,
      isVirtual: false,
      readOnly: true,
      isUnsupported: false,
      isBinary: true,
      filename
    });

    this.tabOrder.push(path);
    this.activeFile = path;

    this.emit('file-opened', { path, language, isBinary: true, filename });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

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

    // Binary files have no editor model — skip editor setup
    if (!fileInfo.isBinary) {
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

      if (this.editor) {
        this.editor.updateOptions({ readOnly: !!fileInfo.readOnly });
      }

      // Restore view state
      const viewState = this.viewStates.get(path);
      if (viewState) {
        this.editor.restoreViewState(viewState);
      }
    }

    this.activeFile = path;

    // Focus editor (only for non-binary files)
    if (!fileInfo.isBinary && this.editor) {
      this.editor.focus();
    }

    // Emit events
    this.emit('file-switched', { path, isBinary: !!fileInfo.isBinary });
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
      theme: themeManager.monacoTheme,
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

    // Register Ctrl+S to save the active file (prevents browser's save page dialog)
    this.editor.addAction({
      id: 'auditaria-save-file',
      label: 'Save File',
      keybindings: [
        this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.KeyS
      ],
      run: () => {
        this.saveActiveFile();
      }
    });

    // Listen for theme changes to update Monaco theme
    document.addEventListener('themechange', () => {
      if (this.editor && this.monaco) {
        this.monaco.editor.setTheme(themeManager.monacoTheme);
      }
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

    const fileInfo = this.openFiles.get(this.activeFile);
    if (fileInfo && (fileInfo.readOnly || fileInfo.isVirtual)) {
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

    if (fileInfo.readOnly || fileInfo.isVirtual) {
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

    // Request server to stop watching this file (skip for virtual and binary files)
    if (!fileInfo.isVirtual && !fileInfo.isBinary) {
      this.requestFileUnwatch(path);
    }

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
    if (fileInfo && (fileInfo.readOnly || fileInfo.isVirtual)) {
      return;
    }
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
    return this.tabOrder.map(tabId => {
      const fileInfo = this.openFiles.get(tabId);
      const filename = tabId.split('/').pop() || tabId;

      return {
        path: tabId,
        filename,
        isDirty: fileInfo ? fileInfo.isDirty : false,
        isActive: tabId === this.activeFile,
        language: fileInfo ? fileInfo.language : 'plaintext',
        hasExternalChange: fileInfo ? fileInfo.hasExternalChange : false,
        showWarning: fileInfo ? fileInfo.showWarning : false,
        isVirtual: fileInfo ? fileInfo.isVirtual : false,
        isUnsupported: fileInfo ? fileInfo.isUnsupported : false,
        readOnly: fileInfo ? fileInfo.readOnly : false,
        isBinary: fileInfo ? !!fileInfo.isBinary : false
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
   * Request server to watch this file for external changes
   * @param {string} path - File path
   * @param {string} content - Current file content
   */
  requestFileWatch(path, content) {
    this.wsManager.send({
      type: 'file_watch_request',
      path,
      content
    });
  }

  /**
   * Request server to unwatch this file
   * @param {string} path - File path
   */
  requestFileUnwatch(path) {
    this.wsManager.send({
      type: 'file_unwatch_request',
      path
    });
  }

  /**
   * Handle external file change event (IMPROVED UX - Smart Auto-Reload)
   * @param {Object} data - { path, diskContent, diskStats }
   */
  handleFileExternalChange(data) {
    const { path, diskContent, diskStats } = data;
    const fileInfo = this.openFiles.get(path);

    if (!fileInfo) {
      return; // File not open anymore
    }

    // Get current editor content
    const editorContent = fileInfo.model.getValue();

    // Check if content actually differs
    if (editorContent === diskContent) {
      // No actual difference, just update metadata
      fileInfo.savedContent = diskContent;
      return;
    }

    // Smart behavior based on dirty state
    if (fileInfo.isDirty) {
      // User has unsaved changes - show warning bar (non-blocking)
      fileInfo.hasExternalChange = true;
      fileInfo.externalContent = diskContent;
      fileInfo.showWarning = true;

      this.emit('external-change-warning', {
        path,
        hasChanges: true
      });
      this.emit('tabs-changed', { tabs: this.getTabsInfo() });
    } else {
      // User has no unsaved changes - check track changes preference
      const trackChangesEnabled = this.getTrackChangesEnabled ? this.getTrackChangesEnabled() : false;

      if (trackChangesEnabled) {
        // Track changes mode: Show diff instead of auto-reloading
        fileInfo.hasExternalChange = true;
        fileInfo.externalContent = diskContent;
        fileInfo.showWarning = true;

        this.emit('external-change-warning', {
          path,
          hasChanges: false  // User has no local changes
        });
        this.emit('tabs-changed', { tabs: this.getTabsInfo() });
      } else {
        // Auto-reload mode: Silent reload (current behavior)
        // Update savedContent FIRST, before setValue(), so markFileDirty() won't trigger
        fileInfo.savedContent = diskContent;
        fileInfo.model.setValue(diskContent);
        fileInfo.isDirty = false;

        this.emit('file-auto-reloaded', { path });
        this.emit('dirty-changed', { path, isDirty: false });
        this.emit('tabs-changed', { tabs: this.getTabsInfo() });
        this.showToast('✓ File reloaded from disk', 'success');
      }
    }
  }

  /**
   * Handle external file deletion
   * @param {Object} data - { path }
   */
  handleFileExternalDelete(data) {
    const { path } = data;
    const fileInfo = this.openFiles.get(path);

    if (!fileInfo) {
      return; // File not open
    }

    // Show warning to user
    const filename = path.split('/').pop() || path;
    const userChoice = confirm(
      `The file "${filename}" has been deleted externally.\n\n` +
      `Do you want to save your changes to recreate the file?\n\n` +
      `Click OK to save, Cancel to close without saving.`
    );

    if (userChoice) {
      // User wants to save (recreate file)
      this.saveFile(path);
    } else {
      // User wants to close without saving
      this.closeFile(path);
    }
  }

  /**
   * Handle file watch error
   * @param {Object} data - { path, error }
   */
  handleFileWatchError(data) {
    const { path, error } = data;
    console.error(`File watch error for ${path}:`, error);
    this.emit('error', {
      operation: 'file_watch',
      path,
      message: error
    });
  }

  /**
   * Show toast notification
   * @param {string} message - Message to show
   * @param {string} type - Type: 'success', 'error', 'info'
   */
  showToast(message, type = 'info') {
    this.emit('show-toast', { message, type });
  }

  /**
   * Action: View Diff (opens diff modal)
   * @param {string} path - File path
   */
  viewDiff(path) {
    const fileInfo = this.openFiles.get(path);
    if (!fileInfo || !fileInfo.hasExternalChange) {
      return;
    }

    // Emit event to show diff modal with latest external content
    this.emit('show-diff-modal', {
      path,
      originalContent: fileInfo.model.getValue(),
      modifiedContent: fileInfo.externalContent,
      language: fileInfo.language
    });
  }

  /**
   * Action: Reload from Disk (replace editor content with disk version)
   * @param {string} path - File path
   */
  reloadFromDisk(path) {
    const fileInfo = this.openFiles.get(path);
    if (!fileInfo || !fileInfo.hasExternalChange) {
      console.warn(`No external changes for: ${path}`);
      return;
    }

    console.log(`Reloading from disk: ${path}`);

    // Replace editor content with disk version
    fileInfo.model.setValue(fileInfo.externalContent);
    fileInfo.savedContent = fileInfo.externalContent;
    fileInfo.isDirty = false;
    fileInfo.hasExternalChange = false;
    fileInfo.externalContent = null;
    fileInfo.showWarning = false;

    // Emit events
    this.emit('external-warning-dismissed', { path });
    this.emit('dirty-changed', { path, isDirty: false });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });
    this.showToast('✓ Reloaded from disk', 'success');

    console.log(`→ File reloaded, marked clean`);
  }

  /**
   * Action: Keep My Changes (dismiss warning, file stays dirty)
   * @param {string} path - File path
   */
  keepMyChanges(path) {
    const fileInfo = this.openFiles.get(path);
    if (!fileInfo || !fileInfo.hasExternalChange) {
      console.warn(`No external changes for: ${path}`);
      return;
    }

    console.log(`Keeping user changes for: ${path}`);

    // Dismiss warning, keep current content
    fileInfo.hasExternalChange = false;
    fileInfo.externalContent = null;
    fileInfo.showWarning = false;
    // Note: File stays dirty (isDirty unchanged)

    // Emit events
    this.emit('external-warning-dismissed', { path });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });

    console.log(`→ Warning dismissed, file remains dirty`);
  }

  /**
   * Action from Diff Modal: Use Disk Version
   * @param {string} path - File path
   */
  useDiskVersion(path) {
    // Same as reloadFromDisk
    this.reloadFromDisk(path);
    this.emit('close-diff-modal');
  }

  /**
   * Action from Diff Modal: Keep My Version
   * @param {string} path - File path
   */
  keepMyVersion(path) {
    // Same as keepMyChanges
    this.keepMyChanges(path);
    this.emit('close-diff-modal');
  }

  /**
   * Action from Diff Modal: Apply merged content (right panel, possibly edited)
   * Sets the editor model to the provided content and clears external change state.
   * @param {string} path - File path
   * @param {string} content - The merged content to apply
   */
  useMergedVersion(path, content) {
    const fileInfo = this.openFiles.get(path);
    if (!fileInfo) {
      console.warn(`File not open: ${path}`);
      return;
    }

    console.log(`Applying merged content for: ${path}`);

    // Apply the merged content to the editor model
    fileInfo.model.setValue(content);
    fileInfo.savedContent = fileInfo.externalContent || fileInfo.savedContent;
    fileInfo.isDirty = true;
    fileInfo.hasExternalChange = false;
    fileInfo.externalContent = null;
    fileInfo.showWarning = false;

    // Emit events
    this.emit('external-warning-dismissed', { path });
    this.emit('dirty-changed', { path, isDirty: true });
    this.emit('tabs-changed', { tabs: this.getTabsInfo() });
    this.showToast('✓ Applied merged version', 'success');

    this.emit('close-diff-modal');
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

    // Dispose diff editor
    if (this.diffEditor) {
      const model = this.diffEditor.getModel();
      if (model) {
        model.original.dispose();
        model.modified.dispose();
      }
      this.diffEditor.dispose();
      this.diffEditor = null;
    }

    // Dispose regular editor
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

  /**
   * Check if parser is available
   * @returns {boolean}
   */
  isParserAvailable() {
    return this.parserAvailable;
  }

  /**
   * Request parse of markdown file to DOCX
   * @param {string} mdPath - Path to markdown file
   */
  requestParse(mdPath) {
    this.wsManager.send({
      type: 'parse_request',
      path: mdPath
    });
  }

  // =========================================================================
  // AUDITARIA: Collaborative Writing (AI File Tracking)
  // =========================================================================

  /**
   * Handle collaborative writing status update from server
   * @param {Object} data - { trackedFiles: Array<{path, startedAt, lastChangeSource}> }
   */
  handleCollaborativeWritingStatus(data) {
    const { trackedFiles } = data;

    // Update local cache
    this.collaborativeWritingFiles.clear();
    if (trackedFiles && Array.isArray(trackedFiles)) {
      for (const file of trackedFiles) {
        this.collaborativeWritingFiles.set(file.path, {
          startedAt: file.startedAt,
          lastChangeSource: file.lastChangeSource,
        });
      }
    }

    // Emit event for UI update
    this.emit('collaborative-writing-changed', {
      trackedFiles: Array.from(this.collaborativeWritingFiles.keys()),
    });
  }

  /**
   * Handle collaborative writing toggle result from server
   * @param {Object} data - { path, action, success, message }
   */
  handleCollaborativeWritingToggleResult(data) {
    this.collaborativeWritingPending = false;

    const { path, action, success, message } = data;

    if (success) {
      this.showToast(
        action === 'start'
          ? '✓ AI collaborative writing enabled'
          : '✓ AI collaborative writing disabled',
        'success'
      );
    } else {
      this.showToast(`✗ ${message}`, 'error');
    }

    // Status update will come separately via collaborative_writing_status
  }

  /**
   * Request collaborative writing status from server
   */
  requestCollaborativeWritingStatus() {
    this.wsManager.send({
      type: 'collaborative_writing_status_request',
    });
  }

  /**
   * Toggle collaborative writing for a file
   * @param {string} path - File path
   */
  toggleCollaborativeWriting(path) {
    if (!path) {
      console.warn('Cannot toggle collaborative writing: no path provided');
      return;
    }

    if (this.collaborativeWritingPending) {
      console.warn('Collaborative writing toggle already in progress');
      return;
    }

    const isActive = this.isCollaborativeWritingActive(path);
    const action = isActive ? 'end' : 'start';

    // For 'end' action, find the actual tracked path to send to server
    let pathToSend = path;
    if (action === 'end') {
      const trackedPath = this.findTrackedPath(path);
      if (trackedPath) {
        pathToSend = trackedPath;
      }
    }

    this.collaborativeWritingPending = true;

    this.wsManager.send({
      type: 'collaborative_writing_toggle',
      path: pathToSend,
      action,
    });
  }

  /**
   * Find the actual tracked path that matches a given path
   * @param {string} path - File path to match
   * @returns {string|null} - The tracked path or null if not found
   */
  findTrackedPath(path) {
    if (!path) return null;

    const normalizedPath = path.replace(/\\/g, '/');

    // Check exact match first
    if (this.collaborativeWritingFiles.has(path)) return path;
    if (this.collaborativeWritingFiles.has(normalizedPath)) return normalizedPath;

    // Check if any tracked path ends with this path
    for (const trackedPath of this.collaborativeWritingFiles.keys()) {
      const normalizedTracked = trackedPath.replace(/\\/g, '/');
      if (normalizedTracked.endsWith('/' + normalizedPath) ||
          normalizedTracked === normalizedPath ||
          normalizedPath.endsWith('/' + normalizedTracked)) {
        return trackedPath;
      }
    }

    return null;
  }

  /**
   * Check if collaborative writing is active for a file
   * @param {string} path - File path
   * @returns {boolean}
   */
  isCollaborativeWritingActive(path) {
    if (!path) return false;

    // Normalize path separators for comparison
    const normalizedPath = path.replace(/\\/g, '/');

    // Check exact match first
    if (this.collaborativeWritingFiles.has(path)) return true;
    if (this.collaborativeWritingFiles.has(normalizedPath)) return true;

    // Check if any tracked path ends with this path (handles absolute vs relative)
    for (const trackedPath of this.collaborativeWritingFiles.keys()) {
      const normalizedTracked = trackedPath.replace(/\\/g, '/');
      if (normalizedTracked.endsWith('/' + normalizedPath) ||
          normalizedTracked === normalizedPath ||
          normalizedPath.endsWith('/' + normalizedTracked)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get all files with collaborative writing active
   * @returns {string[]}
   */
  getCollaborativeWritingFiles() {
    return Array.from(this.collaborativeWritingFiles.keys());
  }
}
