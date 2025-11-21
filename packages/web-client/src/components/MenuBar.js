/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Menu bar component for Monaco editor

/**
 * Menu Bar Component
 *
 * Provides traditional menu bar (Edit, Selection, View, Go)
 * Triggers Monaco editor's built-in actions
 */
export class MenuBar {
  constructor(editorManager) {
    this.editorManager = editorManager;

    // UI elements
    this.menuBar = null;
    this.activeMenu = null;

    this.createElements();
    this.setupEventHandlers();
  }

  /**
   * Create menu bar elements
   */
  createElements() {
    this.menuBar = document.createElement('div');
    this.menuBar.className = 'editor-menu-bar';

    this.menuBar.innerHTML = `
      <div class="editor-menu" data-menu="file">
        <span class="editor-menu-label">File</span>
        <div class="editor-menu-dropdown">
          <div class="editor-menu-item" data-action="file.save">
            <span class="editor-menu-item-label">Save</span>
            <span class="editor-menu-item-shortcut">Ctrl+S</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="file.close">
            <span class="editor-menu-item-label">Close</span>
            <span class="editor-menu-item-shortcut"></span>
          </div>
          <div class="editor-menu-item" data-action="file.closeAll">
            <span class="editor-menu-item-label">Close All</span>
            <span class="editor-menu-item-shortcut"></span>
          </div>
          <div class="editor-menu-item" data-action="file.closeOthers">
            <span class="editor-menu-item-label">Close Others</span>
            <span class="editor-menu-item-shortcut"></span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="file.revert">
            <span class="editor-menu-item-label">Revert File</span>
            <span class="editor-menu-item-shortcut"></span>
          </div>
        </div>
      </div>

      <div class="editor-menu" data-menu="edit">
        <span class="editor-menu-label">Edit</span>
        <div class="editor-menu-dropdown">
          <div class="editor-menu-item" data-action="actions.find">
            <span class="editor-menu-item-label">Find</span>
            <span class="editor-menu-item-shortcut">Ctrl+F</span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.startFindReplaceAction">
            <span class="editor-menu-item-label">Replace</span>
            <span class="editor-menu-item-shortcut">Ctrl+H</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="editor.action.formatDocument">
            <span class="editor-menu-item-label">Format Document</span>
            <span class="editor-menu-item-shortcut">Shift+Alt+F</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="editor.action.commentLine">
            <span class="editor-menu-item-label">Toggle Line Comment</span>
            <span class="editor-menu-item-shortcut">Ctrl+/</span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.blockComment">
            <span class="editor-menu-item-label">Toggle Block Comment</span>
            <span class="editor-menu-item-shortcut">Shift+Alt+A</span>
          </div>
        </div>
      </div>

      <div class="editor-menu" data-menu="selection">
        <span class="editor-menu-label">Selection</span>
        <div class="editor-menu-dropdown">
          <div class="editor-menu-item" data-action="editor.action.selectAll">
            <span class="editor-menu-item-label">Select All</span>
            <span class="editor-menu-item-shortcut">Ctrl+A</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="editor.action.smartSelect.expand">
            <span class="editor-menu-item-label">Expand Selection</span>
            <span class="editor-menu-item-shortcut">Shift+Alt+→</span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.smartSelect.shrink">
            <span class="editor-menu-item-label">Shrink Selection</span>
            <span class="editor-menu-item-shortcut">Shift+Alt+←</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="editor.action.insertCursorAbove">
            <span class="editor-menu-item-label">Add Cursor Above</span>
            <span class="editor-menu-item-shortcut">Ctrl+Alt+↑</span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.insertCursorBelow">
            <span class="editor-menu-item-label">Add Cursor Below</span>
            <span class="editor-menu-item-shortcut">Ctrl+Alt+↓</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="editor.action.selectHighlights">
            <span class="editor-menu-item-label">Select All Occurrences</span>
            <span class="editor-menu-item-shortcut">Ctrl+Shift+L</span>
          </div>
        </div>
      </div>

      <div class="editor-menu" data-menu="view">
        <span class="editor-menu-label">View</span>
        <div class="editor-menu-dropdown">
          <div class="editor-menu-item" data-action="editor.action.toggleMinimap">
            <span class="editor-menu-item-label">Toggle Minimap</span>
            <span class="editor-menu-item-shortcut"></span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.toggleRenderWhitespace">
            <span class="editor-menu-item-label">Toggle Whitespace</span>
            <span class="editor-menu-item-shortcut"></span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.toggleWordWrap">
            <span class="editor-menu-item-label">Toggle Word Wrap</span>
            <span class="editor-menu-item-shortcut">Alt+Z</span>
          </div>
        </div>
      </div>

      <div class="editor-menu" data-menu="go">
        <span class="editor-menu-label">Go</span>
        <div class="editor-menu-dropdown">
          <div class="editor-menu-item" data-action="editor.action.gotoLine">
            <span class="editor-menu-item-label">Go to Line...</span>
            <span class="editor-menu-item-shortcut">Ctrl+G</span>
          </div>
          <div class="editor-menu-item" data-action="editor.action.quickOutline">
            <span class="editor-menu-item-label">Go to Symbol...</span>
            <span class="editor-menu-item-shortcut">Ctrl+Shift+O</span>
          </div>
          <div class="editor-menu-separator"></div>
          <div class="editor-menu-item" data-action="editor.action.revealDefinition">
            <span class="editor-menu-item-label">Go to Definition</span>
            <span class="editor-menu-item-shortcut">F12</span>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Set up event handlers
   */
  setupEventHandlers() {
    // Click on menu label to open/close
    const menuLabels = this.menuBar.querySelectorAll('.editor-menu-label');
    menuLabels.forEach(label => {
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = label.parentElement;
        this.toggleMenu(menu);
      });
    });

    // Click on menu item to execute action
    const menuItems = this.menuBar.querySelectorAll('.editor-menu-item');
    menuItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = item.getAttribute('data-action');
        if (action) {
          this.executeAction(action);
          this.closeAllMenus();
        }
      });
    });

    // Close menus when clicking outside
    document.addEventListener('click', () => {
      this.closeAllMenus();
    });

    // Prevent menu from closing when clicking inside dropdown
    const dropdowns = this.menuBar.querySelectorAll('.editor-menu-dropdown');
    dropdowns.forEach(dropdown => {
      dropdown.addEventListener('click', (e) => {
        e.stopPropagation();
      });
    });
  }

  /**
   * Toggle menu open/close
   * @param {HTMLElement} menu
   */
  toggleMenu(menu) {
    const isOpen = menu.classList.contains('open');

    // Close all menus first
    this.closeAllMenus();

    // Open this menu if it wasn't already open
    if (!isOpen) {
      menu.classList.add('open');
      this.activeMenu = menu;
    }
  }

  /**
   * Close all menus
   */
  closeAllMenus() {
    const menus = this.menuBar.querySelectorAll('.editor-menu');
    menus.forEach(menu => {
      menu.classList.remove('open');
    });
    this.activeMenu = null;
  }

  /**
   * Execute file menu action
   * @param {string} actionId
   */
  executeFileAction(actionId) {
    const activeFile = this.editorManager.getActiveFile();

    switch (actionId) {
      case 'file.save':
        if (activeFile) {
          this.editorManager.saveActiveFile();
        }
        break;

      case 'file.close':
        if (activeFile) {
          this.editorManager.closeFile(activeFile);
        }
        break;

      case 'file.closeAll':
        this.editorManager.closeAllFiles();
        break;

      case 'file.closeOthers':
        if (activeFile) {
          // Get all open files
          const openFiles = Array.from(this.editorManager.openFiles.keys());
          // Close all except active
          openFiles.forEach(path => {
            if (path !== activeFile) {
              this.editorManager.closeFile(path);
            }
          });
        }
        break;

      case 'file.revert':
        if (activeFile) {
          const fileInfo = this.editorManager.openFiles.get(activeFile);
          if (fileInfo && fileInfo.isDirty) {
            // Confirm before reverting
            if (confirm('Discard all changes and reload file from disk?')) {
              // Reload the file content
              fileInfo.model.setValue(fileInfo.savedContent);
              this.editorManager.setFileDirty(activeFile, false);
            }
          }
        }
        break;

      default:
        console.warn('[MenuBar] Unknown file action:', actionId);
    }
  }

  /**
   * Execute Monaco editor action
   * @param {string} actionId
   */
  executeAction(actionId) {
    try {
      // File menu actions
      if (actionId.startsWith('file.')) {
        this.executeFileAction(actionId);
        return;
      }

      const editor = this.editorManager.editor;
      if (!editor) {
        console.warn('[MenuBar] Editor not available');
        return;
      }

      // Special handling for actions that need to be implemented via editor options
      switch (actionId) {
        case 'editor.action.selectAll':
          editor.setSelection(editor.getModel().getFullModelRange());
          return;

        case 'editor.action.toggleWordWrap': {
          const currentWrap = editor.getOption(this.editorManager.monaco.editor.EditorOption.wordWrap);
          editor.updateOptions({
            wordWrap: currentWrap === 'off' ? 'on' : 'off'
          });
          return;
        }

        case 'editor.action.toggleMinimap': {
          const currentMinimap = editor.getOption(this.editorManager.monaco.editor.EditorOption.minimap);
          editor.updateOptions({
            minimap: { enabled: !currentMinimap.enabled }
          });
          return;
        }

        case 'editor.action.toggleRenderWhitespace': {
          const current = editor.getOption(this.editorManager.monaco.editor.EditorOption.renderWhitespace);
          editor.updateOptions({
            renderWhitespace: current === 'none' ? 'all' : 'none'
          });
          return;
        }

        case 'editor.action.quickOutline':
          // Use the correct action ID for symbol search
          editor.trigger('keyboard', 'editor.action.quickOutline', null);
          return;

        case 'editor.action.revealDefinition':
          // Trigger go to definition
          editor.trigger('keyboard', 'editor.action.revealDefinition', null);
          return;
      }

      // For standard actions, use getAction().run()
      const action = editor.getAction(actionId);

      if (action) {
        action.run();
      } else {
        console.warn(`[MenuBar] Action not found: ${actionId}`);
      }
    } catch (error) {
      console.error(`[MenuBar] Failed to execute action ${actionId}:`, error);
    }
  }

  /**
   * Get the menu bar element
   * @returns {HTMLElement}
   */
  getElement() {
    return this.menuBar;
  }

  /**
   * Destroy component
   */
  destroy() {
    this.closeAllMenus();

    if (this.menuBar && this.menuBar.parentNode) {
      this.menuBar.parentNode.removeChild(this.menuBar);
    }

    this.menuBar = null;
    this.activeMenu = null;
  }
}
