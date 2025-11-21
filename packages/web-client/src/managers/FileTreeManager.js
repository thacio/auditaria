/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: File tree manager for state and WebSocket communication

import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * File Tree Manager
 *
 * Manages file tree state and communicates with WebSocket server
 * - Requests file tree from server
 * - Stores tree data
 * - Tracks expanded/collapsed folder state (session-only, not persisted)
 * - Filters tree by search query
 * - Saves/restores expansion state during search operations
 */
export class FileTreeManager extends EventEmitter {
  constructor(wsManager) {
    super();
    this.wsManager = wsManager;

    // State
    this.treeData = null;
    this.workspaceRoot = '';
    this.expandedPaths = new Set();
    this.searchQuery = '';
    this.isLoading = false;

    // Save expansion state before search for restoration on clear
    // This allows users to search through files without permanently
    // expanding folders - when search is cleared, original state returns
    this.preSearchExpandedPaths = null;

    // Note: We do NOT load persisted state - expansion state is session-only
    // this.loadState();

    // Set up WebSocket message handlers
    this.setupMessageHandlers();
  }

  /**
   * Initialize and request file tree from server
   */
  initialize() {
    this.requestFileTree();
  }

  /**
   * Set up WebSocket message handlers
   */
  setupMessageHandlers() {
    // Handle file tree response
    this.wsManager.addEventListener('file_tree_response', (event) => {
      this.handleFileTreeResponse(event.detail);
    });

    // Handle file operation errors
    this.wsManager.addEventListener('file_operation_error', (event) => {
      this.handleFileOperationError(event.detail);
    });

    // Handle file create/delete/rename responses (refresh tree)
    this.wsManager.addEventListener('file_create_response', () => {
      // Tree will be refreshed automatically by server
    });

    this.wsManager.addEventListener('file_delete_response', () => {
      // Tree will be refreshed automatically by server
    });

    this.wsManager.addEventListener('file_rename_response', () => {
      // Tree will be refreshed automatically by server
    });
  }

  /**
   * Request file tree from server
   * @param {string} [relativePath] - Optional subdirectory path
   */
  requestFileTree(relativePath = undefined) {
    this.isLoading = true;
    this.emit('loading-changed', { isLoading: true });

    this.wsManager.send({
      type: 'file_tree_request',
      relativePath
    });
  }

  /**
   * Handle file tree response from server
   * @param {Object} data - Response data
   */
  handleFileTreeResponse(data) {
    this.isLoading = false;
    this.treeData = data.tree;
    this.workspaceRoot = data.workspaceRoot || '';

    this.emit('loading-changed', { isLoading: false });
    this.emit('tree-updated', this.getFilteredTree());
  }

  /**
   * Handle file operation error from server
   * @param {Object} error - Error data
   */
  handleFileOperationError(error) {
    // Only handle tree-related errors (not file read/write errors)
    // File read/write errors are handled by EditorManager
    if (error.operation === 'read' || error.operation === 'write') {
      return;
    }

    this.isLoading = false;
    this.emit('loading-changed', { isLoading: false });
    this.emit('error', {
      operation: error.operation,
      path: error.path,
      message: error.error
    });

    console.error(`File operation error (${error.operation}):`, error.error);
  }

  /**
   * Set folder expanded state
   * @param {string} path - Folder path
   * @param {boolean} isExpanded - Whether folder is expanded
   */
  setFolderExpanded(path, isExpanded) {
    if (isExpanded) {
      this.expandedPaths.add(path);
    } else {
      this.expandedPaths.delete(path);
    }

    // Note: We do NOT save state - expansion state is session-only
    // this.saveState();
    this.emit('expanded-changed', { path, isExpanded });

    // Emit tree-updated to trigger re-render with new expansion state
    this.emit('tree-updated', this.getFilteredTree());
  }

  /**
   * Check if folder is expanded
   * @param {string} path - Folder path
   * @returns {boolean}
   */
  isFolderExpanded(path) {
    return this.expandedPaths.has(path);
  }

  /**
   * Capture current expansion state by requesting it from FileTreePanel
   * This is needed because vscode-tree doesn't emit toggle events
   */
  captureCurrentExpansionState() {
    // Emit event to request current state from FileTreePanel
    this.emit('request-expansion-state');
  }

  /**
   * Receive captured expansion state from FileTreePanel
   * @param {Set} capturedPaths - Set of currently expanded paths from the visual tree
   */
  receiveExpansionState(capturedPaths) {
    this.preSearchExpandedPaths = new Set(capturedPaths);
  }

  /**
   * Set search query and manage expansion state snapshot/restore
   * @param {string} query - Search query
   */
  setSearchQuery(query) {
    const trimmedQuery = query.trim().toLowerCase();
    const wasSearching = this.searchQuery.length > 0;
    const isSearching = trimmedQuery.length > 0;

    // Snapshot/restore mechanism for folder expansion state:
    // - When user starts typing (enters search mode), capture ACTUAL visual state from tree
    // - When user clears search (exits search mode), restore saved state
    // - This ensures search is non-destructive to user's folder layout

    // Save snapshot when ENTERING search mode (first character typed)
    if (!wasSearching && isSearching) {
      // Request current expansion state from the tree component
      // since vscode-tree doesn't emit toggle events, we need to read its state
      this.captureCurrentExpansionState();
    }

    // Restore snapshot when EXITING search mode (search cleared)
    if (wasSearching && !isSearching) {
      if (this.preSearchExpandedPaths !== null) {
        // Restore the saved expansion state
        this.expandedPaths = new Set(this.preSearchExpandedPaths);
        this.preSearchExpandedPaths = null;

        // Note: We do NOT persist state - expansion state is session-only
        // this.saveState();
      }
    }

    // Update search query
    this.searchQuery = trimmedQuery;

    // Emit events
    this.emit('search-changed', { query: this.searchQuery });
    this.emit('tree-updated', this.getFilteredTree());
  }

  /**
   * Get filtered tree based on search query
   * @returns {Array} Filtered tree nodes
   */
  getFilteredTree() {
    if (!this.treeData) {
      return [];
    }

    if (!this.searchQuery) {
      return this.treeData;
    }

    return this.filterTree(this.treeData);
  }

  /**
   * Filter tree recursively
   * @param {Array} nodes - Tree nodes
   * @returns {Array} Filtered nodes
   */
  filterTree(nodes) {
    if (!Array.isArray(nodes)) {
      return [];
    }

    const filtered = [];

    for (const node of nodes) {
      const matches = node.label.toLowerCase().includes(this.searchQuery);
      const hasMatchingChildren = node.children && this.filterTree(node.children).length > 0;

      if (matches || hasMatchingChildren) {
        const filteredNode = { ...node };

        if (node.children) {
          filteredNode.children = this.filterTree(node.children);

          // Auto-expand folders with matches
          if (filteredNode.children.length > 0) {
            this.expandedPaths.add(node.path);
          }
        }

        filtered.push(filteredNode);
      }
    }

    return filtered;
  }

  /**
   * Get current tree data
   * @returns {Array}
   */
  getTreeData() {
    return this.treeData;
  }

  /**
   * Get workspace root path
   * @returns {string}
   */
  getWorkspaceRoot() {
    return this.workspaceRoot;
  }

  /**
   * Refresh file tree
   */
  refresh() {
    this.requestFileTree();
  }

  /**
   * Open file with system default application
   * @param {string} path - File path
   */
  openWithSystemDefault(path) {
    this.wsManager.send({
      type: 'file_open_system',
      path
    });
  }

  /**
   * Reveal file/folder in system file explorer
   * @param {string} path - File/folder path
   */
  revealInFileExplorer(path) {
    this.wsManager.send({
      type: 'file_reveal_request',
      path
    });
  }

  /**
   * Load state from localStorage
   */
  loadState() {
    try {
      const saved = localStorage.getItem('auditaria_file_tree_state');
      if (saved) {
        const state = JSON.parse(saved);
        this.expandedPaths = new Set(state.expandedPaths || []);
      }
    } catch (error) {
      console.error('Failed to load file tree state:', error);
    }
  }

  /**
   * Save state to localStorage
   */
  saveState() {
    try {
      const state = {
        expandedPaths: Array.from(this.expandedPaths)
      };
      localStorage.setItem('auditaria_file_tree_state', JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save file tree state:', error);
    }
  }

  /**
   * Clear all state
   */
  clearState() {
    this.expandedPaths.clear();
    this.searchQuery = '';
    this.saveState();
  }

  /**
   * Destroy manager and clean up
   */
  destroy() {
    this.removeAllListeners();
    this.treeData = null;
    this.expandedPaths.clear();
  }
}
