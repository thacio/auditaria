/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Base preview class for multi-preview system

import { EventEmitter } from '../EventEmitter.js';

/**
 * Base Preview Class
 *
 * Abstract base class for all preview implementations.
 * Provides common interface and functionality for preview types.
 *
 * Architecture:
 * - Strategy Pattern: Each preview type implements the same interface
 * - Event System: Previews can emit events (preview-loaded, preview-error, etc.)
 * - Capability Declaration: Each preview declares what features it supports
 * - Configuration: Previews can be configured with user settings
 * - Priority: Multiple previews can handle same file, priority determines which wins
 *
 * @extends EventEmitter
 */
export class BasePreview extends EventEmitter {
  constructor() {
    super();
    this.settings = {};
  }

  /**
   * Check if this preview can handle the given file type
   * @param {string} language - Monaco language ID (e.g., 'markdown', 'html', 'json')
   * @param {string} filename - Full filename with extension
   * @returns {boolean} True if this preview can handle the file
   * @abstract
   */
  canPreview(language, filename) {
    throw new Error('canPreview() must be implemented by subclass');
  }

  /**
   * Render content into container
   * @param {string} content - File content to preview
   * @param {HTMLElement} container - Container element to render into
   * @param {Object} options - Optional rendering options
   * @param {string} options.language - Monaco language ID
   * @param {string} options.filename - Filename
   * @abstract
   */
  render(content, container, options = {}) {
    throw new Error('render() must be implemented by subclass');
  }

  /**
   * Cleanup resources (e.g., blob URLs, event listeners, iframes)
   * Called when preview is destroyed or replaced
   */
  cleanup() {
    // Override if needed
    this.removeAllListeners();
  }

  /**
   * Check if preview dependencies are loaded (e.g., marked.js for markdown)
   * @returns {boolean} True if preview is ready to use
   */
  isLoaded() {
    return true; // Override if dependencies needed
  }

  /**
   * Get preview type identifier (e.g., 'markdown', 'html', 'json')
   * Used for configuration, logging, and UI labels
   * @returns {string} Preview type identifier
   * @abstract
   */
  getType() {
    return 'base';
  }

  /**
   * Get human-readable preview name (e.g., 'Markdown Preview', 'HTML Preview')
   * Used for UI display
   * @returns {string} Human-readable name
   */
  getName() {
    return 'Base Preview';
  }

  /**
   * Get security level of this preview type
   * @returns {string} 'safe' | 'sandboxed' | 'unsafe'
   * - 'safe': No security risks (e.g., markdown, json, images)
   * - 'sandboxed': Runs in sandboxed environment (e.g., HTML iframe)
   * - 'unsafe': Potential security risks (not recommended)
   */
  getSecurityLevel() {
    return 'safe';
  }

  /**
   * Get priority for this preview type (higher = more specific)
   * Used when multiple previews can handle the same file
   * Higher priority preview is selected
   * @returns {number} Priority value (default: 100)
   */
  getPriority() {
    return 100;
  }

  /**
   * Get capabilities/features supported by this preview
   * Used to dynamically build toolbar buttons
   * @returns {Object} Capabilities object
   * @returns {boolean} return.supportsRefresh - Can refresh preview
   * @returns {boolean} return.supportsExport - Can export preview
   * @returns {boolean} return.supportsSearch - Can search in preview
   * @returns {boolean} return.supportsPrint - Can print preview
   * @returns {Array} return.customToolbarButtons - Preview-specific toolbar buttons
   */
  getCapabilities() {
    return {
      supportsRefresh: false,
      supportsExport: false,
      supportsSearch: false,
      supportsPrint: false,
      customToolbarButtons: []
      // Custom button format:
      // {
      //   id: 'unique-button-id',
      //   icon: 'codicon-icon-name',
      //   label: 'Button Label',
      //   title: 'Tooltip text',
      //   action: () => this.someMethod()
      // }
    };
  }

  /**
   * Configure this preview with user settings
   * @param {Object} settings - User settings for this preview type
   */
  configure(settings) {
    this.settings = { ...this.getDefaultSettings(), ...settings };
  }

  /**
   * Get default settings for this preview type
   * Override to provide preview-specific defaults
   * @returns {Object} Default settings
   */
  getDefaultSettings() {
    return {};
  }

  /**
   * Escape HTML to prevent XSS
   * Utility method for safe HTML rendering
   * @param {string} text - Text to escape
   * @returns {string} Escaped HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Show error message in preview container
   * Standard error display format
   * @param {HTMLElement} container - Container element
   * @param {string} message - Error message
   */
  showError(container, message) {
    container.innerHTML = `
      <div class="preview-error">
        <h3>Preview Error</h3>
        <p>${this.escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Show loading state in preview container
   * @param {HTMLElement} container - Container element
   * @param {string} message - Loading message
   */
  showLoading(container, message = 'Loading preview...') {
    container.innerHTML = `
      <div class="preview-loading">
        <div class="preview-loading-spinner"></div>
        <p>${this.escapeHtml(message)}</p>
      </div>
    `;
  }

  /**
   * Show empty state in preview container
   * @param {HTMLElement} container - Container element
   * @param {string} message - Empty state message
   */
  showEmpty(container, message = 'No content to preview') {
    container.innerHTML = `
      <div class="preview-empty">
        <p>${this.escapeHtml(message)}</p>
      </div>
    `;
  }
}
