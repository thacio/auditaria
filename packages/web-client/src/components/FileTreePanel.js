/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: File tree panel component with VS Code Elements

import { EventEmitter } from '../utils/EventEmitter.js';
import { getFileIcon, getFolderIcon } from '../utils/fileIcons.js';
import { ContextMenu } from './ContextMenu.js';
import { showSuccessToast, showErrorToast } from './Toast.js';

/**
 * File Tree Panel Component
 *
 * Renders the file browser panel with VS Code-style tree
 * - Uses <vscode-tree> web component
 * - Handles expand/collapse
 * - Search/filter functionality
 * - Panel toggle (collapse/expand)
 */
export class FileTreePanel extends EventEmitter {
  constructor(fileTreeManager) {
    super();
    this.fileTreeManager = fileTreeManager;

    // UI elements
    this.panel = null;
    this.tree = null;
    this.searchInput = null;
    // MANUAL REFRESH: Commented out (now using automatic directory watching)
    // this.refreshButton = null;
    this.collapseButton = null;
    this.expandTab = null;
    this.loadingIndicator = null;
    this.treeContainer = null;
    this.resizeHandle = null;

    // Resize state
    this.isResizing = false;
    this.panelWidth = 280;  // Default width in pixels
    this.minWidth = 150;    // Minimum width in pixels
    this.maxWidthPercent = 40;  // Maximum width as % of viewport
    this.hasCustomWidth = false;

    // State
    this.isCollapsed = true;  // Start collapsed
    this.isVSCodeTreeLoaded = false;

    // Track which paths are folders (for click handling)
    this.folderPaths = new Set();

    // Track currently selected item
    this.currentSelectedPath = null;

    // MANUAL REFRESH: Pull-to-refresh state (commented out - automatic updates enabled)
    // this.pullStartY = 0;
    // this.pullCurrentY = 0;
    // this.isPulling = false;
    // this.pullThreshold = 130; // pixels to trigger refresh

    // Context menu
    this.contextMenu = new ContextMenu();

    this.initialize();
  }

  /**
   * Initialize component
   */
  async initialize() {
    await this.loadVSCodeElements();
    this.createElements();
    this.setupEventHandlers();
    this.loadState();
  }

  /**
   * Load VS Code Elements library
   */
  async loadVSCodeElements() {
    if (this.isVSCodeTreeLoaded || window.customElements.get('vscode-tree')) {
      this.isVSCodeTreeLoaded = true;
      return;
    }

    try {
      // Import VS Code tree component
      await import('@vscode-elements/elements/dist/vscode-tree/index.js');
      this.isVSCodeTreeLoaded = true;
      console.log('VSCode Elements loaded successfully');
    } catch (error) {
      console.error('Failed to load VSCode Elements:', error);
      throw error;
    }
  }

  /**
   * Create UI elements
   */
  createElements() {
    // Get or create panel container
    this.panel = document.getElementById('file-tree-panel');
    if (!this.panel) {
      this.panel = this.createPanelElement();
      this.insertPanelIntoDOM();
    }

    // Get references to child elements
    this.tree = document.getElementById('file-tree');
    this.searchInput = document.getElementById('file-tree-search-input');
    // MANUAL REFRESH: Commented out
    // this.refreshButton = document.getElementById('file-tree-refresh');
    this.collapseButton = document.getElementById('file-tree-collapse');
    this.expandTab = document.getElementById('file-tree-expand-tab');
    this.loadingIndicator = document.getElementById('file-tree-loading');
    this.treeContainer = document.querySelector('.file-tree-container');
    this.resizeHandle = document.getElementById('file-tree-resize-handle');
  }

  /**
   * Create panel DOM structure
   * @returns {HTMLElement}
   */
  createPanelElement() {
    const panel = document.createElement('div');
    panel.id = 'file-tree-panel';
    panel.className = 'file-tree-panel collapsed';  // Start collapsed

    panel.innerHTML = `
      <div class="file-tree-resize-handle" id="file-tree-resize-handle"></div>
      <div class="file-tree-header">
        <span class="file-tree-title">FILES</span>
        <button class="file-tree-collapse-button" id="file-tree-collapse" title="Show file tree" aria-label="Show file tree">
          <span class="codicon codicon-chevron-right"></span>
        </button>
      </div>
      <div class="file-tree-search">
        <input
          type="text"
          id="file-tree-search-input"
          class="file-tree-search-input"
          placeholder="Search files..."
          aria-label="Search files"
        />
      </div>
      <!-- MANUAL REFRESH: Refresh button commented out (automatic updates enabled) -->
      <!--
      <div class="file-tree-refresh-container">
        <button class="file-tree-refresh-button" id="file-tree-refresh" title="Update file list" aria-label="Update file list">
          <span class="codicon codicon-refresh"></span>
          <span>Update list</span>
        </button>
      </div>
      -->
      <div class="file-tree-loading" id="file-tree-loading" style="display: none;">
        <span class="loading-spinner"></span>
        <span>Loading...</span>
      </div>
      <div class="file-tree-container">
        <vscode-tree
          id="file-tree"
          class="file-tree-component"
          arrows
          indent-guides
        ></vscode-tree>
      </div>
      <button class="file-tree-expand-tab" id="file-tree-expand-tab" title="Show file tree" aria-label="Show file tree">
        <span class="codicon codicon-chevron-right"></span>
      </button>
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

    const target = workbenchBody || appContainer;

    // Insert at the beginning
    if (target.firstChild) {
      target.insertBefore(this.panel, target.firstChild);
    } else {
      target.appendChild(this.panel);
    }
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

    // Layout change handler - refresh default width when not user-resized
    document.addEventListener('layoutchange', () => {
      if (this.hasCustomWidth) return;
      const defaultWidth = this.getDefaultPanelWidth();
      if (defaultWidth) {
        this.panelWidth = defaultWidth;
        if (!this.isCollapsed) {
          this.applyPanelWidth();
        }
      }
    });

    // Tree selection event
    if (this.tree) {
      // Remove any existing listeners first to prevent duplicates
      this.tree.removeEventListener('vsc-select', this.boundHandleTreeSelect);
      this.tree.removeEventListener('vsc-tree-item-toggle', this.boundHandleTreeToggle);

      // Create bound handlers if they don't exist
      if (!this.boundHandleTreeSelect) {
        this.boundHandleTreeSelect = (event) => this.handleTreeSelect(event);
      }
      if (!this.boundHandleTreeToggle) {
        this.boundHandleTreeToggle = (event) => this.handleTreeToggle(event);
      }

      // Add event listeners
      this.tree.addEventListener('vsc-select', this.boundHandleTreeSelect);
      this.tree.addEventListener('vsc-tree-item-toggle', this.boundHandleTreeToggle);
    }

    // Search input
    if (this.searchInput) {
      this.searchInput.addEventListener('input', (event) => {
        this.handleSearchInput(event);
      });

      // Clear search on Escape
      this.searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this.searchInput.value = '';
          this.handleSearchInput({ target: this.searchInput });
        }
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

    // MANUAL REFRESH: Refresh button event listener (commented out - automatic updates enabled)
    // if (this.refreshButton) {
    //   this.refreshButton.addEventListener('click', () => {
    //     this.handleRefresh();
    //   });
    // }

    // MANUAL REFRESH: Pull-to-refresh event listeners (commented out - automatic updates enabled)
    // if (this.treeContainer) {
    //   this.treeContainer.addEventListener('touchstart', (event) => {
    //     this.handleTouchStart(event);
    //   }, { passive: true });
    //
    //   this.treeContainer.addEventListener('touchmove', (event) => {
    //     this.handleTouchMove(event);
    //   }, { passive: false });
    //
    //   this.treeContainer.addEventListener('touchend', (event) => {
    //     this.handleTouchEnd(event);
    //   }, { passive: true });
    //
    //   // Also support mouse drag for desktop testing
    //   this.treeContainer.addEventListener('mousedown', (event) => {
    //     this.handleMouseDown(event);
    //   });
    // }

    // FileTreeManager events
    this.fileTreeManager.on('tree-updated', (treeData) => {
      this.updateTree(treeData);
    });

    this.fileTreeManager.on('loading-changed', ({ isLoading }) => {
      this.setLoading(isLoading);
    });

    this.fileTreeManager.on('error', (error) => {
      this.showError(error);
    });

    // Handle request to capture current expansion state
    this.fileTreeManager.on('request-expansion-state', () => {
      this.captureAndSendExpansionState();
    });

    // Context menu on tree items
    // Note: vscode-tree uses shadow DOM, so we need to handle contextmenu at document level
    // and check if the target is within our tree
    document.addEventListener('contextmenu', (event) => {
      this.handleContextMenu(event);
    });
  }

  /**
   * Capture the current expansion state from the vscode-tree component
   * and send it back to FileTreeManager
   */
  captureAndSendExpansionState() {
    const expandedPaths = new Set();

    if (this.tree && this.tree.data) {
      // Recursively traverse the tree data to find all open nodes
      const traverseNodes = (nodes) => {
        if (!Array.isArray(nodes)) return;

        for (const node of nodes) {
          // Check if this node is marked as open
          if (node.open && node.value) {
            expandedPaths.add(node.value);
          }

          // Recursively check children
          if (node.subItems && Array.isArray(node.subItems)) {
            traverseNodes(node.subItems);
          }
        }
      };

      traverseNodes(this.tree.data);
    }

    // Send the captured state back to FileTreeManager
    this.fileTreeManager.receiveExpansionState(expandedPaths);
  }

  /**
   * Handle tree item selection
   * @param {CustomEvent} event
   */
  handleTreeSelect(event) {
    // Prevent event from bubbling/firing multiple times
    event.stopPropagation();

    const detail = event.detail;
    if (!detail || !detail.value) return;

    const path = detail.value;
    const label = detail.label || '';

    console.log('=== handleTreeSelect called ===', { path, label });

    // Track the currently selected item FIRST, before any tree updates
    this.currentSelectedPath = path;
    console.log('Set currentSelectedPath to:', path);

    // Check if this path is a folder (tracked during formatTreeData)
    const isFolder = this.folderPaths.has(path);
    console.log('Is folder?', isFolder);

    if (!isFolder) {
      // It's a file - emit file-selected event
      // Don't update tree data here, let formatTreeData handle it on next update
      this.emit('file-selected', { path, label });
    }

    // Manually apply selection styling since vscode-tree doesn't do it automatically
    this.applySelectionStyling(path);
  }

  /**
   * Handle tree item toggle (expand/collapse)
   * @param {CustomEvent} event
   */
  handleTreeToggle(event) {
    const detail = event.detail;
    if (!detail || !detail.value) return;

    const path = detail.value;
    const isOpen = detail.open;

    console.log('=== handleTreeToggle called ===', { path, isOpen, currentSelectedPath: this.currentSelectedPath });

    // Update expanded state in manager
    // This might trigger a tree refresh from the manager
    this.fileTreeManager.setFolderExpanded(path, isOpen);
  }

  /**
   * Handle search input
   * @param {Event} event
   */
  handleSearchInput(event) {
    const query = event.target.value;
    this.fileTreeManager.setSearchQuery(query);
  }

  /**
   * Update tree with new data
   * @param {Array} treeData - Tree nodes from server
   */
  updateTree(treeData) {
    if (!this.tree || !this.isVSCodeTreeLoaded) {
      console.warn('VSCode tree not ready');
      return;
    }

    console.log('=== updateTree called ===', {
      currentSelectedPath: this.currentSelectedPath,
      dataLength: Array.isArray(treeData) ? treeData.length : 'not array'
    });

    // Inject styles into shadow DOM on first update
    this.injectShadowDOMStyles();

    // Clear folder paths before reformatting tree
    this.folderPaths.clear();

    // Convert server tree format to VSCode Elements format
    // formatTreeData will check currentSelectedPath and set selected: true appropriately
    const formattedData = this.formatTreeData(treeData);

    console.log('Tree formatted, updating tree.data. Current selection should be preserved:', this.currentSelectedPath);

    // Update tree
    this.tree.data = formattedData;
  }

  /**
   * Inject custom styles into the vscode-tree shadow DOM
   */
  injectShadowDOMStyles() {
    if (!this.tree || !this.tree.shadowRoot || this.tree._stylesInjected) {
      return;
    }

    try {
      const style = document.createElement('style');
      // NOTE: These rules must use theme variables (not hardcoded colors) because
      // the tree lives in a shadow DOM and its default hover styles can destroy
      // contrast in dark themes. Keep hover/selected states readable across themes.
      style.textContent = `
        /* Ensure cursor is pointer for all items */
        li > div:first-child {
          cursor: pointer;
        }

        /* CRITICAL: Selected items with our custom class */
        /* Must use higher specificity and !important to override hover */
        li.auditaria-selected > div:first-child {
          background-color: var(--panel-item-selected) !important;
          color: var(--text) !important;
        }

        li.auditaria-selected > div:first-child span,
        li.auditaria-selected > div:first-child [part="text-content"] {
          color: var(--text) !important;
        }

        /* Selected + Hover: keep selection color for clarity */
        li.auditaria-selected:hover > div:first-child {
          background-color: var(--panel-item-selected) !important;
          color: var(--text) !important;
        }

        li.auditaria-selected:hover > div:first-child span,
        li.auditaria-selected:hover > div:first-child [part="text-content"] {
          color: var(--text) !important;
        }

        /* Regular hover (non-selected items only) */
        li:not(.auditaria-selected):hover > div:first-child {
          background-color: var(--panel-item-hover) !important;
          color: var(--text) !important;
        }

        li:not(.auditaria-selected):hover > div:first-child span,
        li:not(.auditaria-selected):hover > div:first-child [part="text-content"] {
          color: var(--text) !important;
        }

        /* Prevent hover from parent when hovering nested children */
        li:has(li:hover) > div:first-child {
          background-color: transparent !important;
        }

        /* But allow the direct child being hovered to have hover style */
        li:has(li:hover) li:hover > div:first-child {
          background-color: var(--panel-item-hover) !important;
          color: var(--text) !important;
        }

        li:has(li:hover) li:hover > div:first-child span,
        li:has(li:hover) li:hover > div:first-child [part="text-content"] {
          color: var(--text) !important;
        }

        /* And if the nested hovered item is selected, show selected+hover */
        li:has(li.auditaria-selected:hover) li.auditaria-selected:hover > div:first-child {
          background-color: var(--panel-item-selected) !important;
          color: var(--text) !important;
        }

        li:has(li.auditaria-selected:hover) li.auditaria-selected:hover > div:first-child span,
        li:has(li.auditaria-selected:hover) li.auditaria-selected:hover > div:first-child [part="text-content"] {
          color: var(--text) !important;
        }
      `;

      this.tree.shadowRoot.appendChild(style);
      this.tree._stylesInjected = true;
      console.log('Shadow DOM styles injected with selection priority');
    } catch (error) {
      console.error('Failed to inject shadow DOM styles:', error);
    }
  }

  /**
   * Format tree data for VSCode Elements
   * @param {Array|Object} nodes - Tree nodes
   * @param {string} parentPath - Parent path
   * @returns {Array}
   */
  formatTreeData(nodes, parentPath = '') {
    if (!nodes) {
      return [];
    }

    if (Array.isArray(nodes)) {
      return nodes.map(node => this.formatTreeData(node, parentPath)).filter(Boolean);
    }

    const node = nodes;
    const currentPath = node.path || (parentPath ? `${parentPath}/${node.label}` : node.label);
    const isFolder = node.type === 'folder';

    // Track folder paths for click handling
    if (isFolder) {
      this.folderPaths.add(currentPath);
    }

    // Get icon paths from Material Icon Theme
    const isExpanded = this.fileTreeManager.isFolderExpanded(currentPath);

    const formatted = {
      label: node.label,
      value: currentPath,
      tooltip: currentPath  // Show full path on hover
    };

    // Mark as selected if this is the current selection
    if (this.currentSelectedPath === currentPath) {
      formatted.selected = true;
      console.log('>>> Marking as selected in formatTreeData:', currentPath);
    }

    // Set icon URLs for vscode-elements tree
    if (isFolder) {
      // Folders: Add folder icons AFTER chevron for consistent alignment
      const folderIconPath = getFolderIcon(node.label, isExpanded);
      const folderOpenIconPath = getFolderIcon(node.label, true);

      formatted.iconUrls = {
        branch: folderIconPath,
        branchOpen: folderOpenIconPath
      };
    } else {
      // Files: Use Material Icon Theme
      const fileIconPath = getFileIcon(node.label);

      formatted.iconUrls = {
        leaf: fileIconPath
      };
    }

    if (isFolder && node.children && Array.isArray(node.children)) {
      formatted.subItems = node.children
        .map(child => this.formatTreeData(child, currentPath))
        .filter(Boolean);

      // Set open state based on manager
      formatted.open = isExpanded;
    }

    return formatted;
  }

  /**
   * Handle window resize for responsive behavior
   */
  handleResize() {
    const viewportWidth = window.innerWidth;

    // Small screens (<768px): Auto-collapse
    if (viewportWidth < 768) {
      if (!this.isCollapsed) {
        this.isCollapsed = true;
        this.panel.classList.add('collapsed');
        this.panel.style.width = '';
        this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-right';
        this.collapseButton.title = 'Show file tree';
        this.emit('collapse-changed', { isCollapsed: this.isCollapsed });
      }
    } else if (!this.isCollapsed) {
      // On larger screens, ensure panel width doesn't exceed max
      const maxWidth = (this.maxWidthPercent / 100) * viewportWidth;
      if (this.panelWidth > maxWidth) {
        this.panelWidth = maxWidth;
      }
      this.applyPanelWidth();
    }
  }

  /**
   * Toggle panel collapse state
   */
  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;

    if (this.isCollapsed) {
      this.panel.classList.add('collapsed');
      // Clear inline width so CSS can control collapse
      this.panel.style.width = '';
      this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-right';
      this.collapseButton.title = 'Show file tree';
    } else {
      this.panel.classList.remove('collapsed');
      // Apply saved width when expanding
      this.applyPanelWidth();
      this.collapseButton.querySelector('.codicon').className = 'codicon codicon-chevron-left';
      this.collapseButton.title = 'Hide file tree';

      // Emit event so editor can close on medium screens
      this.emit('panel-opened');
    }

    this.saveState();
    this.emit('collapse-changed', { isCollapsed: this.isCollapsed });
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

    // Disable transition during resize for smooth dragging
    this.panel.style.transition = 'none';

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

    // Calculate new width (panel is on left, so width = mouseX)
    let newWidth = mouseX;

    // Apply constraints
    const maxWidth = (this.maxWidthPercent / 100) * viewportWidth;
    newWidth = Math.max(this.minWidth, Math.min(maxWidth, newWidth));

    // Update panel width
    this.panelWidth = newWidth;
    this.panel.style.width = `${newWidth}px`;
  }

  /**
   * Stop resizing the panel
   */
  stopResize() {
    if (!this.isResizing) return;

    this.isResizing = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Re-enable transition
    this.panel.style.transition = '';

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
   * Set loading state
   * @param {boolean} isLoading
   */
  setLoading(isLoading) {
    if (this.loadingIndicator) {
      // Don't show loading indicator when panel is collapsed
      this.loadingIndicator.style.display = (isLoading && !this.isCollapsed) ? 'flex' : 'none';
    }

    // MANUAL REFRESH: Commented out
    // // Disable refresh button while loading
    // if (this.refreshButton) {
    //   this.refreshButton.disabled = isLoading;
    // }
  }

  /**
   * Handle refresh button click
   */
  handleRefresh() {
    this.fileTreeManager.refresh();
  }

  /**
   * Handle touch start for pull-to-refresh
   * @param {TouchEvent} event
   */
  handleTouchStart(event) {
    // Only track if scrolled to top
    if (this.treeContainer.scrollTop === 0) {
      this.pullStartY = event.touches[0].clientY;
      this.isPulling = false;
    }
  }

  /**
   * Handle touch move for pull-to-refresh
   * @param {TouchEvent} event
   */
  handleTouchMove(event) {
    if (this.pullStartY === 0) return;

    this.pullCurrentY = event.touches[0].clientY;
    const pullDistance = this.pullCurrentY - this.pullStartY;

    // Only allow pulling down when at top of scroll
    if (pullDistance > 0 && this.treeContainer.scrollTop === 0) {
      this.isPulling = true;

      // Visual feedback - add a subtle transform
      if (pullDistance < this.pullThreshold) {
        this.treeContainer.style.transform = `translateY(${pullDistance * 0.3}px)`;
        this.treeContainer.style.transition = 'none';
      }

      // Prevent default scroll behavior while pulling
      event.preventDefault();
    }
  }

  /**
   * Handle touch end for pull-to-refresh
   * @param {TouchEvent} event
   */
  handleTouchEnd(event) {
    if (!this.isPulling) {
      this.pullStartY = 0;
      return;
    }

    const pullDistance = this.pullCurrentY - this.pullStartY;

    // Reset transform with animation
    this.treeContainer.style.transition = 'transform 0.3s ease';
    this.treeContainer.style.transform = 'translateY(0)';

    // Trigger refresh if pulled far enough
    if (pullDistance >= this.pullThreshold) {
      this.handleRefresh();
    }

    // Reset state
    this.pullStartY = 0;
    this.pullCurrentY = 0;
    this.isPulling = false;

    // Remove transition after animation completes
    setTimeout(() => {
      if (this.treeContainer) {
        this.treeContainer.style.transition = '';
      }
    }, 300);
  }

  /**
   * Handle mouse down for pull-to-refresh (desktop testing)
   * @param {MouseEvent} event
   */
  handleMouseDown(event) {
    // Only track if scrolled to top
    if (this.treeContainer.scrollTop === 0) {
      this.pullStartY = event.clientY;
      this.isPulling = false;

      const handleMouseMove = (moveEvent) => {
        this.pullCurrentY = moveEvent.clientY;
        const pullDistance = this.pullCurrentY - this.pullStartY;

        if (pullDistance > 0 && this.treeContainer.scrollTop === 0) {
          this.isPulling = true;

          if (pullDistance < this.pullThreshold) {
            this.treeContainer.style.transform = `translateY(${pullDistance * 0.3}px)`;
            this.treeContainer.style.transition = 'none';
          }
        }
      };

      const handleMouseUp = () => {
        if (this.isPulling) {
          const pullDistance = this.pullCurrentY - this.pullStartY;

          // Reset transform with animation
          this.treeContainer.style.transition = 'transform 0.3s ease';
          this.treeContainer.style.transform = 'translateY(0)';

          // Trigger refresh if pulled far enough
          if (pullDistance >= this.pullThreshold) {
            this.handleRefresh();
          }

          // Reset state
          this.isPulling = false;

          // Remove transition after animation completes
          setTimeout(() => {
            if (this.treeContainer) {
              this.treeContainer.style.transition = '';
            }
          }, 300);
        }

        this.pullStartY = 0;
        this.pullCurrentY = 0;

        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
  }

  /**
   * Show error message
   * @param {Object} error
   */
  showError(error) {
    console.error('File tree error:', error);
    showErrorToast(error.message || 'Unknown error');
  }

  /**
   * Handle context menu
   * @param {MouseEvent} event
   */
  handleContextMenu(event) {
    console.log('Context menu event triggered', {
      target: event.target,
      tagName: event.target?.tagName,
      hasTree: !!this.tree,
      treeContainsTarget: this.tree?.contains(event.target),
      composedPath: event.composedPath ? event.composedPath() : []
    });

    // Check if click is within our tree panel
    if (!this.tree || !this.tree.contains(event.target)) {
      console.log('Not within tree, ignoring');
      return; // Not our tree, let default behavior happen
    }

    event.preventDefault();
    event.stopPropagation();

    console.log('Searching for vsc-tree-item using composedPath...');

    // vscode-tree uses shadow DOM, so we need to use composedPath() to get the actual target
    // composedPath() returns the event path including elements inside shadow DOM
    let treeItem = null;

    if (event.composedPath) {
      const path = event.composedPath();
      console.log('Composed path:', path.map(el => el.tagName || el));

      // vscode-tree uses LI elements for tree items, not custom elements
      // Look for an LI with data-item-id or similar attributes
      for (const element of path) {
        console.log('Examining element:', element.tagName, element);

        if (element.tagName === 'LI') {
          // Extract all dataset properties
          const datasetObj = {};
          for (const key in element.dataset) {
            datasetObj[key] = element.dataset[key];
          }

          console.log('Found LI element, full details:', {
            id: element.id,
            className: element.className,
            dataset: datasetObj,
            attributes: Array.from(element.attributes || []).map(attr => ({ name: attr.name, value: attr.value })),
            textContent: element.textContent?.trim(),
            innerText: element.innerText?.trim()
          });

          // The LI element should contain the tree item data
          treeItem = element;
          break;
        }

        // Stop if we reach our tree container
        if (element === this.tree) {
          break;
        }
      }
    }

    if (!treeItem) {
      // Clicked on tree background, not an item
      console.log('No tree item found in composed path, clicked on background');
      return;
    }

    // The vscode-tree component uses data-path attribute which contains an index
    // We need to look up the actual item data from the tree's data property
    const pathIndex = treeItem.getAttribute('data-path');
    console.log('Tree item index from data-path:', pathIndex);

    if (!pathIndex) {
      console.log('No data-path index found on tree item');
      return;
    }

    // Access the tree's internal data to get the actual file path
    // The tree component stores items in a flat array accessible via the data property
    let filePath = null;
    let label = null;

    // Try to get the item from the tree's internal structure
    if (this.tree && this.tree.data) {
      console.log('Tree has data, searching for item with path:', pathIndex);

      /**
       * Find item by hierarchical path
       *
       * CRITICAL: The vscode-tree uses hierarchical path notation like "4/0/1" which means:
       * - Index 4 at root level
       * - Index 0 within that item's children
       * - Index 1 within those children
       *
       * We parse this path and navigate through the tree hierarchy.
       *
       * @param {string} pathIndex - Hierarchical path like "4" or "4/0/1"
       * @param {Array} items - Tree items to search
       * @returns {Object|null} - Found item or null
       */
      const findItemByHierarchicalPath = (pathIndex, items) => {
        // Parse the hierarchical path (e.g., "4/0/1" -> [4, 0, 1])
        const pathSegments = pathIndex.split('/').map(s => parseInt(s, 10));
        console.log('Path segments:', pathSegments);

        let currentItems = items;
        let currentItem = null;

        // Navigate through each level of the hierarchy
        for (let depth = 0; depth < pathSegments.length; depth++) {
          const index = pathSegments[depth];
          console.log(`  Level ${depth}: looking for index ${index} in array of ${currentItems.length} items`);

          // Get the item at this index in the current level
          if (!Array.isArray(currentItems) || index >= currentItems.length) {
            console.error(`  ✗ Invalid index ${index} at depth ${depth}`);
            return null;
          }

          currentItem = currentItems[index];
          console.log(`  ✓ Found item at level ${depth}: ${currentItem.label}`);

          // If there are more path segments, navigate into this item's children
          if (depth < pathSegments.length - 1) {
            if (!currentItem.subItems || !Array.isArray(currentItem.subItems)) {
              console.error(`  ✗ Item "${currentItem.label}" has no children but path continues`);
              return null;
            }
            currentItems = currentItem.subItems;
          }
        }

        console.log('✓ Successfully navigated to item:', currentItem);
        return currentItem;
      };

      const itemData = findItemByHierarchicalPath(pathIndex, this.tree.data);

      if (itemData) {
        filePath = itemData.value;
        label = itemData.label;
        console.log('✓ Successfully retrieved item:', { filePath, label });
      } else {
        console.error('✗ Failed to find item with path:', pathIndex);
      }
    }

    if (!filePath) {
      console.log('Could not retrieve file path from tree data');
      return;
    }

    const isFolder = this.folderPaths.has(filePath);

    console.log('Building context menu for:', { path: filePath, label, isFolder });

    // Apply selection to the right-clicked item
    this.currentSelectedPath = filePath;
    this.applySelectionStyling(filePath);
    console.log('Applied selection for right-click on:', filePath);

    // Build context menu items
    const items = this.buildContextMenuItems(filePath, label, isFolder);

    console.log('Showing context menu with items:', items);

    // Show context menu at click position
    this.contextMenu.show(event.clientX, event.clientY, items);
  }

  /**
   * Build context menu items based on file/folder type
   * @param {string} path - File/folder path
   * @param {string} label - File/folder label
   * @param {boolean} isFolder - Whether it's a folder
   * @returns {Array} Menu items
   */
  buildContextMenuItems(path, label, isFolder) {
    const items = [];

    if (isFolder) {
      // Folder menu
      const isExpanded = this.fileTreeManager.isFolderExpanded(path);

      items.push({
        label: isExpanded ? 'Collapse' : 'Expand',
        icon: isExpanded ? 'codicon codicon-chevron-down' : 'codicon codicon-chevron-right',
        action: () => this.toggleFolderExpansion(path, isExpanded)
      });

      items.push({ separator: true });
    } else {
      // File menu
      items.push({
        label: 'Open with Editor',
        icon: 'codicon codicon-code',
        action: () => this.openFileInEditor(path, label)
      });

      items.push({
        label: 'Open with System Default',
        icon: 'codicon codicon-file',
        action: () => this.openFileWithSystem(path)
      });

      items.push({ separator: true });
    }

    // Common items for both files and folders
    items.push({
      label: 'Copy Absolute Path',
      icon: 'codicon codicon-clippy',
      action: () => this.copyAbsolutePath(path)
    });

    items.push({
      label: 'Copy Relative Path',
      icon: 'codicon codicon-clippy',
      action: () => this.copyRelativePath(path)
    });

    items.push({ separator: true });

    items.push({
      label: 'Open File Location',
      icon: 'codicon codicon-folder',
      action: () => this.revealInExplorer(path)
    });

    return items;
  }

  /**
   * Toggle folder expansion
   * @param {string} path - Folder path
   * @param {boolean} isExpanded - Current expansion state
   */
  toggleFolderExpansion(path, isExpanded) {
    this.fileTreeManager.setFolderExpanded(path, !isExpanded);
  }

  /**
   * Apply selection styling directly to the DOM
   * This bypasses the vscode-tree component's lack of built-in selection styling
   * @param {string} selectedPath - Path to select
   */
  applySelectionStyling(selectedPath) {
    if (!this.tree || !this.tree.shadowRoot) {
      return;
    }

    // Find the item in our data to get its hierarchical path index
    const findPathIndex = (items, targetPath, currentIndex = { value: 0 }, pathPrefix = '') => {
      if (!Array.isArray(items)) return null;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const itemPath = item.value;

        if (itemPath === targetPath) {
          return pathPrefix ? `${pathPrefix}/${i}` : `${i}`;
        }

        currentIndex.value++;

        if (item.subItems && Array.isArray(item.subItems)) {
          const newPrefix = pathPrefix ? `${pathPrefix}/${i}` : `${i}`;
          const found = findPathIndex(item.subItems, targetPath, currentIndex, newPrefix);
          if (found) return found;
        }
      }

      return null;
    };

    const dataPath = findPathIndex(this.tree.data, selectedPath);
    console.log('Looking for LI with data-path:', dataPath, 'for item:', selectedPath);

    if (!dataPath) {
      console.warn('Could not find data-path for:', selectedPath);
      return;
    }

    setTimeout(() => {
      const allLis = this.tree.shadowRoot.querySelectorAll('li');

      // Remove selection from all items
      allLis.forEach(li => {
        li.classList.remove('auditaria-selected');
      });

      // Add selection to the target item
      const targetLi = this.tree.shadowRoot.querySelector(`li[data-path="${dataPath}"]`);
      if (targetLi) {
        targetLi.classList.add('auditaria-selected');
        console.log('✓ Applied selection styling to:', dataPath);
      } else {
        console.warn('Could not find LI element with data-path:', dataPath);
      }
    }, 50);
  }

  /**
   * Deep clone tree data
   * @param {Array} items - Tree items
   * @returns {Array} Cloned items
   */
  deepCloneTreeData(items) {
    if (!Array.isArray(items)) return items;

    return items.map(item => {
      const cloned = { ...item };
      if (item.subItems && Array.isArray(item.subItems)) {
        cloned.subItems = this.deepCloneTreeData(item.subItems);
      }
      if (item.iconUrls) {
        cloned.iconUrls = { ...item.iconUrls };
      }
      return cloned;
    });
  }

  /**
   * Update selected state in tree data recursively
   * @param {Array} items - Tree items
   * @param {string} selectedPath - Path to select
   */
  updateSelectedStateInTree(items, selectedPath) {
    if (!Array.isArray(items)) return;

    for (const item of items) {
      // Update selected state
      if (item.value === selectedPath) {
        item.selected = true;
        console.log('>>> Setting selected=true on:', item.value);
      } else {
        item.selected = false;
      }

      // Recursively update children
      if (item.subItems && Array.isArray(item.subItems)) {
        this.updateSelectedStateInTree(item.subItems, selectedPath);
      }
    }
  }

  /**
   * Open file in editor
   * @param {string} path - File path
   * @param {string} label - File label
   */
  openFileInEditor(path, label) {
    // Track the currently selected item
    this.currentSelectedPath = path;

    // Update tree to reflect selection with deep clone
    if (this.tree && this.tree.data) {
      const clonedData = this.deepCloneTreeData(this.tree.data);
      this.updateSelectedStateInTree(clonedData, path);
      this.tree.data = clonedData;
    }

    this.emit('file-selected', { path, label });
  }

  /**
   * Open file with system default application
   * @param {string} path - File path
   */
  openFileWithSystem(path) {
    this.fileTreeManager.openWithSystemDefault(path);
  }

  /**
   * Copy absolute path to clipboard
   * @param {string} path - File/folder path
   */
  async copyAbsolutePath(path) {
    try {
      await this.copyToClipboard(path, 'Absolute path');
    } catch (error) {
      console.error('Failed to copy absolute path:', error);
      showErrorToast('Failed to copy to clipboard');
    }
  }

  /**
   * Copy relative path to clipboard
   * @param {string} path - File/folder path
   */
  async copyRelativePath(path) {
    try {
      const workspaceRoot = this.fileTreeManager.getWorkspaceRoot();
      let relativePath = path;

      if (workspaceRoot && path.startsWith(workspaceRoot)) {
        relativePath = path.substring(workspaceRoot.length);
        // Remove leading slash
        if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
          relativePath = relativePath.substring(1);
        }
      }

      await this.copyToClipboard(relativePath, 'Relative path');
    } catch (error) {
      console.error('Failed to copy relative path:', error);
      showErrorToast('Failed to copy to clipboard');
    }
  }

  /**
   * Reveal file/folder in system file explorer
   * @param {string} path - File/folder path
   */
  revealInExplorer(path) {
    this.fileTreeManager.revealInFileExplorer(path);
  }

  /**
   * Copy text to clipboard
   * @param {string} text - Text to copy
   * @param {string} label - Label for feedback message
   */
  async copyToClipboard(text, label) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        // Modern Clipboard API
        await navigator.clipboard.writeText(text);
        showSuccessToast(`${label} copied to clipboard`);
      } else {
        // Fallback for older browsers
        this.fallbackCopyToClipboard(text);
        showSuccessToast(`${label} copied to clipboard`);
      }
    } catch (error) {
      // Try fallback if modern API fails
      try {
        this.fallbackCopyToClipboard(text);
        showSuccessToast(`${label} copied to clipboard`);
      } catch (fallbackError) {
        throw fallbackError;
      }
    }
  }

  /**
   * Fallback clipboard copy for older browsers
   * @param {string} text - Text to copy
   */
  fallbackCopyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);

    try {
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const successful = document.execCommand('copy');

      if (!successful) {
        throw new Error('Fallback copy command failed');
      }
    } finally {
      document.body.removeChild(textarea);
    }
  }

  /**
   * Load state from localStorage
   */
  loadState() {
    // File browser collapse state is not persisted - always starts expanded
    // But we do persist the panel width
    try {
      const defaultWidth = this.getDefaultPanelWidth();
      if (defaultWidth) {
        this.panelWidth = defaultWidth;
      }
      const saved = localStorage.getItem('auditaria_file_tree_state');
      if (saved) {
        const state = JSON.parse(saved);
        if (state.panelWidth && typeof state.panelWidth === 'number') {
          this.panelWidth = state.panelWidth;
          this.hasCustomWidth = true;
          // Don't apply width when collapsed - will be applied when panel expands
        }
      }
    } catch (error) {
      console.error('Failed to load file tree state:', error);
    }
  }

  /**
   * Get the default panel width from CSS (layout-aware)
   * @returns {number|null}
   */
  getDefaultPanelWidth() {
    if (!window.getComputedStyle) return null;
    const value = getComputedStyle(document.documentElement).getPropertyValue('--dock-left-width').trim();
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Save state to localStorage
   */
  saveState() {
    // File browser collapse state is not persisted - always starts expanded
    // But we do persist the panel width
    try {
      const state = {
        panelWidth: this.panelWidth
      };
      localStorage.setItem('auditaria_file_tree_state', JSON.stringify(state));
    } catch (error) {
      console.error('Failed to save file tree state:', error);
    }
  }

  /**
   * Destroy component
   */
  destroy() {
    this.removeAllListeners();

    // Destroy context menu
    if (this.contextMenu) {
      this.contextMenu.destroy();
      this.contextMenu = null;
    }

    if (this.panel && this.panel.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }

    this.panel = null;
    this.tree = null;
    this.searchInput = null;
    this.collapseButton = null;
  }
}
