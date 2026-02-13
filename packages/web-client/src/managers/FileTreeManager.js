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
 * - Requests file tree from server (depth-limited, lazy)
 * - Stores tree data
 * - Tracks expanded/collapsed folder state (session-only, not persisted)
 * - Lazy-loads folder children on expand via server requests
 * - Server-side file search with debounce
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

    // Lazy loading state
    /** @type {Set<string>} Paths whose children have been fetched from server */
    this.loadedPaths = new Set();
    /** @type {Set<string>} Paths currently being fetched */
    this.loadingPaths = new Set();

    // Search state
    this.isSearchMode = false;
    this.isSearching = false; // true while waiting for server response
    /** @type {Array|null} Flat search results from server */
    this.searchResults = null;
    this.searchDebounceTimer = null;
    this.searchDebounceMs = 300;

    // Save expansion state before search for restoration on clear
    // This allows users to search through files without permanently
    // expanding folders - when search is cleared, original state returns
    this.preSearchExpandedPaths = null;

    // Note: We do NOT load persisted state - expansion state is session-only

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
    // Handle file tree response (shallow root)
    this.wsManager.addEventListener('file_tree_response', (event) => {
      this.handleFileTreeResponse(event.detail);
    });

    // Handle lazy-loaded folder children
    this.wsManager.addEventListener('file_tree_children_response', (event) => {
      this.handleChildrenResponse(event.detail);
    });

    // Handle server-side search results
    this.wsManager.addEventListener('file_tree_search_response', (event) => {
      this.handleSearchResponse(event.detail);
    });

    // Handle lightweight directory change notifications
    this.wsManager.addEventListener('directory_change_notification', (event) => {
      this.handleDirectoryChangeNotification(event.detail);
    });

    // Handle file operation errors
    this.wsManager.addEventListener('file_operation_error', (event) => {
      this.handleFileOperationError(event.detail);
    });

    // Handle file create/delete/rename responses (no-op — tree updates via directory_change_notification)
    this.wsManager.addEventListener('file_create_response', () => {});
    this.wsManager.addEventListener('file_delete_response', () => {});
    this.wsManager.addEventListener('file_rename_response', () => {});
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
   * Handle file tree response from server (shallow root load)
   * @param {Object} data - Response data
   */
  handleFileTreeResponse(data) {
    this.isLoading = false;
    this.treeData = data.tree;
    this.workspaceRoot = data.workspaceRoot || '';

    // Track root as loaded; clear previous loaded state on fresh tree
    this.loadedPaths.clear();
    this.loadedPaths.add('.');
    this.loadingPaths.clear();

    // Mark folders that already have children (from maxDepth>0) as loaded.
    // This prevents redundant requestFolderChildren calls that would race
    // with subfolder lazy loads and overwrite their merged children.
    this.markLoadedFolders(this.treeData);

    this.emit('loading-changed', { isLoading: false });
    this.emit('tree-updated', this.getDisplayTree());
  }

  /**
   * Request children for a specific folder (lazy expand)
   * @param {string} folderPath - Relative path to expand
   */
  requestFolderChildren(folderPath) {
    if (this.loadingPaths.has(folderPath) || this.loadedPaths.has(folderPath)) {
      return; // Already loading or already loaded
    }

    this.loadingPaths.add(folderPath);
    this.emit('loading-path-changed', { path: folderPath, isLoading: true });

    // Re-emit tree so the UI shows loading state on this folder
    this.emit('tree-updated', this.getDisplayTree());

    this.wsManager.send({
      type: 'file_tree_children_request',
      path: folderPath
    });
  }

  /**
   * Handle lazy-loaded children response — merge into tree
   * @param {Object} data - { path, children, error? }
   */
  handleChildrenResponse(data) {
    const folderPath = data.path;

    console.log('[LazyTree] handleChildrenResponse:', folderPath, 'children:', data.children?.length);

    this.loadingPaths.delete(folderPath);
    this.loadedPaths.add(folderPath);

    this.emit('loading-path-changed', { path: folderPath, isLoading: false });

    if (data.error) {
      console.error(`Error loading children for ${folderPath}:`, data.error);
      this.emit('tree-updated', this.getDisplayTree());
      return;
    }

    // Merge children into the existing tree
    const merged = this.mergeChildrenIntoTree(this.treeData, folderPath, data.children);
    console.log('[LazyTree] mergeChildrenIntoTree result:', merged, 'for path:', folderPath);

    // Mark child folders that already have their own children as loaded
    // (the server response includes depth-1 entries with children arrays)
    this.markLoadedFolders(data.children);

    this.emit('tree-updated', this.getDisplayTree());
  }

  /**
   * Recursively find the folder node and replace its children
   * @param {Array} nodes - Current tree level
   * @param {string} targetPath - Path to find
   * @param {Array} newChildren - Children to insert
   * @returns {boolean} true if found and merged
   */
  mergeChildrenIntoTree(nodes, targetPath, newChildren) {
    if (!Array.isArray(nodes)) return false;

    for (const node of nodes) {
      if (node.type !== 'folder') continue;

      // Normalize paths for comparison (Windows vs Unix separators)
      const nodePath = node.path.replace(/\\/g, '/');
      const target = targetPath.replace(/\\/g, '/');

      if (nodePath === target) {
        node.children = newChildren;
        // Clear hasChildren since we now have actual children
        delete node.hasChildren;
        return true;
      }

      // Recurse into loaded children
      if (node.children && this.mergeChildrenIntoTree(node.children, targetPath, newChildren)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Walk the tree and mark all folders that already have children arrays as loaded.
   * This prevents redundant server requests for folders whose children were already
   * included in a prior response (e.g., from the initial maxDepth>0 load).
   * @param {Array} nodes - Tree nodes to walk
   */
  markLoadedFolders(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === 'folder' && node.children && Array.isArray(node.children)) {
        this.loadedPaths.add(node.path);
        this.markLoadedFolders(node.children);
      }
    }
  }

  /**
   * Handle lightweight directory change notification.
   * Re-requests only the affected folder if it was previously loaded.
   * @param {Object} data - { path }
   */
  handleDirectoryChangeNotification(data) {
    const changedDir = (data.path || '.').replace(/\\/g, '/');

    // Check if this directory (or root) is among our loaded paths
    let needsRefresh = false;
    for (const loaded of this.loadedPaths) {
      const normalizedLoaded = loaded.replace(/\\/g, '/');
      if (normalizedLoaded === changedDir || changedDir === '.') {
        needsRefresh = true;
        break;
      }
    }

    if (!needsRefresh) {
      return; // This folder was never expanded — ignore
    }

    // If root changed, just re-request root
    if (changedDir === '.') {
      this.loadedPaths.delete('.');
      this.requestFileTree();
      return;
    }

    // Re-request children for the affected folder
    this.loadedPaths.delete(changedDir);
    // Also remove with original separator style
    this.loadedPaths.delete(data.path);

    this.loadingPaths.add(changedDir);
    this.emit('loading-path-changed', { path: changedDir, isLoading: true });

    this.wsManager.send({
      type: 'file_tree_children_request',
      path: data.path || '.'
    });
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
   * Set folder expanded state.
   * When expanding an unloaded folder, triggers lazy load from server.
   * @param {string} path - Folder path
   * @param {boolean} isExpanded - Whether folder is expanded
   */
  setFolderExpanded(path, isExpanded) {
    if (isExpanded) {
      this.expandedPaths.add(path);

      // If folder hasn't been loaded yet, request children from server
      const normalizedPath = path.replace(/\\/g, '/');
      if (!this.loadedPaths.has(normalizedPath) && !this.loadedPaths.has(path)) {
        this.requestFolderChildren(path);
      }
    } else {
      this.expandedPaths.delete(path);
    }

    // Note: We do NOT save state - expansion state is session-only
    this.emit('expanded-changed', { path, isExpanded });

    // Emit tree-updated to trigger re-render with new expansion state
    this.emit('tree-updated', this.getDisplayTree());
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
   * Check if a folder's children are currently loading
   * @param {string} path - Folder path
   * @returns {boolean}
   */
  isFolderLoading(path) {
    return this.loadingPaths.has(path) || this.loadingPaths.has(path.replace(/\\/g, '/'));
  }

  /**
   * Check if a folder's children have been loaded
   * @param {string} path - Folder path
   * @returns {boolean}
   */
  isFolderLoaded(path) {
    return this.loadedPaths.has(path) || this.loadedPaths.has(path.replace(/\\/g, '/'));
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
   * Set search query — delegates to server-side search with debounce
   * @param {string} query - Search query
   */
  setSearchQuery(query) {
    const trimmedQuery = query.trim().toLowerCase();
    const wasSearching = this.searchQuery.length > 0;
    const isSearching = trimmedQuery.length > 0;

    // Save snapshot when ENTERING search mode (first character typed)
    if (!wasSearching && isSearching) {
      this.captureCurrentExpansionState();
    }

    // Restore snapshot when EXITING search mode (search cleared)
    if (wasSearching && !isSearching) {
      this.isSearchMode = false;
      this.isSearching = false;
      this.searchResults = null;
      this.emit('searching-changed', { isSearching: false });

      if (this.preSearchExpandedPaths !== null) {
        this.expandedPaths = new Set(this.preSearchExpandedPaths);
        this.preSearchExpandedPaths = null;
      }
    }

    // Update search query
    this.searchQuery = trimmedQuery;

    // Clear any pending debounce
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }

    if (isSearching) {
      this.isSearchMode = true;
      this.isSearching = true;
      this.emit('searching-changed', { isSearching: true });

      // Debounce the server request
      this.searchDebounceTimer = setTimeout(() => {
        console.log('[Search] Sending file_tree_search_request, query:', JSON.stringify(trimmedQuery));
        this.wsManager.send({
          type: 'file_tree_search_request',
          query: trimmedQuery
        });
      }, this.searchDebounceMs);
    }

    // Emit events
    this.emit('search-changed', { query: this.searchQuery });
    this.emit('tree-updated', this.getDisplayTree());
  }

  /**
   * Handle server-side search response
   * @param {Object} data - { query, results, error? }
   */
  handleSearchResponse(data) {
    console.log('[Search] handleSearchResponse received:', {
      query: data.query,
      currentQuery: this.searchQuery,
      resultCount: data.results?.length,
      error: data.error
    });

    // Only apply if the response matches current query (discard stale results)
    if (data.query !== this.searchQuery) {
      console.log('[Search] Stale response discarded (query mismatch)');
      return;
    }

    this.searchResults = data.results || [];
    this.isSearching = false;
    this.emit('searching-changed', { isSearching: false });

    if (data.error) {
      console.error('Search error:', data.error);
    }

    console.log('[Search] Emitting tree-updated with', this.searchResults.length, 'search results');
    this.emit('tree-updated', this.getDisplayTree());
  }

  /**
   * Get the tree to display — search results (flat) or the lazy tree
   * @returns {Array} Tree nodes for rendering
   */
  getDisplayTree() {
    if (this.isSearchMode && this.searchResults !== null) {
      return this.searchResults;
    }

    if (!this.treeData) {
      return [];
    }

    return this.treeData;
  }

  /**
   * Get filtered tree based on search query
   * @returns {Array} Filtered tree nodes
   * @deprecated Use getDisplayTree() — search is now server-side
   */
  getFilteredTree() {
    return this.getDisplayTree();
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
    this.loadedPaths.clear();
    this.loadingPaths.clear();
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
    this.loadedPaths.clear();
    this.loadingPaths.clear();
    this.searchQuery = '';
    this.searchResults = null;
    this.isSearchMode = false;
    this.saveState();
  }

  /**
   * Destroy manager and clean up
   */
  destroy() {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.removeAllListeners();
    this.treeData = null;
    this.expandedPaths.clear();
    this.loadedPaths.clear();
    this.loadingPaths.clear();
  }
}
