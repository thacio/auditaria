/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * ContextMenu Component
 *
 * A reusable context menu that can be positioned anywhere on the screen
 * with automatic viewport boundary detection.
 *
 * Features:
 * - Click positioning with edge detection
 * - Keyboard navigation (Up/Down arrows, Enter, ESC)
 * - Outside click detection
 * - Support for icons, separators, disabled items
 * - Accessibility (ARIA attributes)
 */
export class ContextMenu extends EventEmitter {
  constructor() {
    super();

    this.menu = null;
    this.items = [];
    this.selectedIndex = -1;
    this.isVisible = false;

    // Bound handlers for cleanup
    this.boundHandleKeyDown = null;
    this.boundHandleOutsideClick = null;
    this.boundHandleScroll = null;

    this.createMenu();
  }

  /**
   * Create the menu DOM element
   */
  createMenu() {
    this.menu = document.createElement('div');
    this.menu.className = 'context-menu';
    this.menu.style.display = 'none';
    this.menu.setAttribute('role', 'menu');
    this.menu.setAttribute('aria-hidden', 'true');

    document.body.appendChild(this.menu);
  }

  /**
   * Show the context menu at specified coordinates
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {Array} items - Menu items array
   */
  show(x, y, items) {
    console.log('ContextMenu.show called', { x, y, items });

    if (!items || items.length === 0) {
      console.log('No items to show');
      return;
    }

    this.items = items;
    this.selectedIndex = -1;
    this.isVisible = true;

    console.log('Building menu...');
    // Build menu content
    this.buildMenu();

    console.log('Menu element:', this.menu);

    // Position menu
    this.menu.style.display = 'block';
    this.menu.setAttribute('aria-hidden', 'false');

    console.log('Menu display set to block, positioning...');

    // Calculate position with viewport boundary detection
    this.positionMenu(x, y);

    console.log('Menu positioned at:', this.menu.style.left, this.menu.style.top);

    // Set up event listeners
    this.setupEventListeners();

    // Focus the menu for keyboard navigation
    this.menu.focus();

    this.emit('shown');
    console.log('Context menu shown');
  }

  /**
   * Hide the context menu
   */
  hide() {
    if (!this.isVisible) {
      return;
    }

    this.isVisible = false;
    this.menu.style.display = 'none';
    this.menu.setAttribute('aria-hidden', 'true');
    this.selectedIndex = -1;

    // Remove event listeners
    this.removeEventListeners();

    this.emit('hidden');
  }

  /**
   * Build menu items HTML
   */
  buildMenu() {
    this.menu.innerHTML = '';

    this.items.forEach((item, index) => {
      if (item.separator) {
        const separator = document.createElement('div');
        separator.className = 'context-menu-separator';
        separator.setAttribute('role', 'separator');
        this.menu.appendChild(separator);
      } else {
        const menuItem = document.createElement('div');
        menuItem.className = 'context-menu-item';
        menuItem.setAttribute('role', 'menuitem');
        menuItem.setAttribute('tabindex', '-1');
        menuItem.dataset.index = index;

        if (item.disabled) {
          menuItem.classList.add('disabled');
          menuItem.setAttribute('aria-disabled', 'true');
        }

        // Icon
        if (item.icon) {
          const icon = document.createElement('span');
          icon.className = `context-menu-icon ${item.icon}`;
          icon.setAttribute('aria-hidden', 'true');
          menuItem.appendChild(icon);
        } else {
          // Empty icon space for alignment
          const iconSpace = document.createElement('span');
          iconSpace.className = 'context-menu-icon';
          iconSpace.setAttribute('aria-hidden', 'true');
          menuItem.appendChild(iconSpace);
        }

        // Label
        const label = document.createElement('span');
        label.className = 'context-menu-label';
        label.textContent = item.label;
        menuItem.appendChild(label);

        // Shortcut (if provided)
        if (item.shortcut) {
          const shortcut = document.createElement('span');
          shortcut.className = 'context-menu-shortcut';
          shortcut.textContent = item.shortcut;
          shortcut.setAttribute('aria-hidden', 'true');
          menuItem.appendChild(shortcut);
        }

        // Click handler
        if (!item.disabled && item.action) {
          menuItem.addEventListener('click', (e) => {
            e.stopPropagation();
            this.handleItemClick(index);
          });

          // Hover effect for keyboard navigation
          menuItem.addEventListener('mouseenter', () => {
            this.selectItem(index);
          });
        }

        this.menu.appendChild(menuItem);
      }
    });
  }

  /**
   * Position menu with viewport boundary detection
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   */
  positionMenu(x, y) {
    const menuRect = this.menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalX = x;
    let finalY = y;

    // Adjust X if menu would overflow right edge
    if (x + menuRect.width > viewportWidth) {
      finalX = viewportWidth - menuRect.width - 5;
    }

    // Adjust Y if menu would overflow bottom edge
    if (y + menuRect.height > viewportHeight) {
      finalY = viewportHeight - menuRect.height - 5;
    }

    // Ensure menu doesn't go off left or top edge
    finalX = Math.max(5, finalX);
    finalY = Math.max(5, finalY);

    this.menu.style.left = `${finalX}px`;
    this.menu.style.top = `${finalY}px`;
  }

  /**
   * Handle item click
   * @param {number} index - Item index
   */
  handleItemClick(index) {
    const item = this.items[index];

    if (!item || item.disabled || item.separator) {
      return;
    }

    this.emit('item-clicked', { item, index });

    // Execute action
    if (item.action && typeof item.action === 'function') {
      item.action();
    }

    // Hide menu after action
    this.hide();
  }

  /**
   * Select item by index (for keyboard navigation)
   * @param {number} index - Item index
   */
  selectItem(index) {
    // Clear previous selection
    if (this.selectedIndex !== -1) {
      const prevItem = this.menu.querySelector(`[data-index="${this.selectedIndex}"]`);
      if (prevItem) {
        prevItem.classList.remove('selected');
      }
    }

    // Set new selection
    this.selectedIndex = index;
    const item = this.menu.querySelector(`[data-index="${index}"]`);

    if (item) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
    }
  }

  /**
   * Get next selectable item index
   * @param {number} currentIndex - Current index
   * @param {number} direction - Direction (1 for down, -1 for up)
   * @returns {number} - Next index
   */
  getNextSelectableIndex(currentIndex, direction) {
    let nextIndex = currentIndex;
    const maxAttempts = this.items.length;
    let attempts = 0;

    while (attempts < maxAttempts) {
      nextIndex = nextIndex + direction;

      // Wrap around
      if (nextIndex < 0) {
        nextIndex = this.items.length - 1;
      } else if (nextIndex >= this.items.length) {
        nextIndex = 0;
      }

      const item = this.items[nextIndex];

      // Skip separators and disabled items
      if (!item.separator && !item.disabled) {
        return nextIndex;
      }

      attempts++;
    }

    return currentIndex;
  }

  /**
   * Set up event listeners
   */
  setupEventListeners() {
    // Keyboard navigation
    this.boundHandleKeyDown = (e) => this.handleKeyDown(e);
    document.addEventListener('keydown', this.boundHandleKeyDown);

    // Outside click
    this.boundHandleOutsideClick = (e) => this.handleOutsideClick(e);
    setTimeout(() => {
      document.addEventListener('click', this.boundHandleOutsideClick);
    }, 0);

    // Scroll (close menu on scroll)
    this.boundHandleScroll = () => this.hide();
    window.addEventListener('scroll', this.boundHandleScroll, true);
  }

  /**
   * Remove event listeners
   */
  removeEventListeners() {
    if (this.boundHandleKeyDown) {
      document.removeEventListener('keydown', this.boundHandleKeyDown);
      this.boundHandleKeyDown = null;
    }

    if (this.boundHandleOutsideClick) {
      document.removeEventListener('click', this.boundHandleOutsideClick);
      this.boundHandleOutsideClick = null;
    }

    if (this.boundHandleScroll) {
      window.removeEventListener('scroll', this.boundHandleScroll, true);
      this.boundHandleScroll = null;
    }
  }

  /**
   * Handle keyboard navigation
   * @param {KeyboardEvent} e - Keyboard event
   */
  handleKeyDown(e) {
    if (!this.isVisible) {
      return;
    }

    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        this.hide();
        break;

      case 'ArrowDown':
        e.preventDefault();
        if (this.selectedIndex === -1) {
          // Select first selectable item
          this.selectItem(this.getNextSelectableIndex(-1, 1));
        } else {
          // Select next item
          this.selectItem(this.getNextSelectableIndex(this.selectedIndex, 1));
        }
        break;

      case 'ArrowUp':
        e.preventDefault();
        if (this.selectedIndex === -1) {
          // Select last selectable item
          this.selectItem(this.getNextSelectableIndex(this.items.length, -1));
        } else {
          // Select previous item
          this.selectItem(this.getNextSelectableIndex(this.selectedIndex, -1));
        }
        break;

      case 'Enter':
      case ' ':
        e.preventDefault();
        if (this.selectedIndex !== -1) {
          this.handleItemClick(this.selectedIndex);
        }
        break;
    }
  }

  /**
   * Handle outside click
   * @param {MouseEvent} e - Mouse event
   */
  handleOutsideClick(e) {
    if (!this.isVisible) {
      return;
    }

    // Check if click is outside menu
    if (!this.menu.contains(e.target)) {
      this.hide();
    }
  }

  /**
   * Destroy the context menu
   */
  destroy() {
    this.hide();
    this.removeEventListeners();

    if (this.menu && this.menu.parentNode) {
      this.menu.parentNode.removeChild(this.menu);
    }

    this.menu = null;
    this.items = [];
    this.removeAllListeners();
  }
}
