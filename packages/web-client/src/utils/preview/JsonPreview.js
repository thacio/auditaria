/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: JSON preview

import { BasePreview } from './BasePreview.js';

/**
 * JSON Preview
 *
 * Displays formatted JSON with syntax highlighting.
 * - Pretty-printed JSON
 * - Syntax highlighting (keys, strings, numbers, booleans)
 * - Collapsible/expandable structure (future enhancement)
 * - Error handling for invalid JSON
 *
 * @extends BasePreview
 */
export class JsonPreview extends BasePreview {
  constructor() {
    super();
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if JSON file
   */
  canPreview(language, filename) {
    return language === 'json' || filename.toLowerCase().endsWith('.json');
  }

  /**
   * Get preview type
   * @returns {string} 'json'
   */
  getType() {
    return 'json';
  }

  /**
   * Get human-readable name
   * @returns {string} 'JSON Preview'
   */
  getName() {
    return 'JSON Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - JSON is just data
   */
  getSecurityLevel() {
    return 'safe';
  }

  /**
   * Get priority
   * @returns {number} 100 - Default priority
   */
  getPriority() {
    return 100;
  }

  /**
   * Get capabilities
   * @returns {Object} JSON preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: false,    // No refresh needed
      supportsExport: false,     // No export (yet)
      supportsSearch: false,     // No search (yet)
      supportsPrint: true,       // Can print formatted JSON
      customToolbarButtons: []   // No custom buttons yet
    };
  }

  /**
   * Get default settings
   * @returns {Object} Default settings
   */
  getDefaultSettings() {
    return {
      indentSize: 2,
      expandDepth: 2,
      sortKeys: false
    };
  }

  /**
   * Render JSON preview
   * @param {string} content - JSON content
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container json-preview-container';

    if (!content || content.trim() === '') {
      this.showEmpty(container, 'No JSON content to preview');
      return;
    }

    try {
      // Parse JSON
      const parsed = JSON.parse(content);

      // Create formatted view
      const formatted = JSON.stringify(parsed, null, this.settings.indentSize);

      // Create wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'json-preview-content';

      // Create pre element
      const pre = document.createElement('pre');
      pre.className = 'json-preview-pre';

      // Create code element
      const code = document.createElement('code');
      code.className = 'json-preview-code';

      // Apply syntax highlighting
      code.innerHTML = this.highlightJson(formatted);

      pre.appendChild(code);
      wrapper.appendChild(pre);
      container.appendChild(wrapper);

      // Emit loaded event
      this.emit('preview-loaded', {
        type: 'json',
        contentSize: content.length
      });

    } catch (error) {
      console.error('Error parsing JSON:', error);

      // Show error with line/column info if available
      let errorMessage = error.message;
      if (error instanceof SyntaxError) {
        errorMessage = `Invalid JSON: ${error.message}`;
      }

      container.innerHTML = `
        <div class="preview-error">
          <h3>JSON Parse Error</h3>
          <p>${this.escapeHtml(errorMessage)}</p>
          <p class="preview-error-details">
            The JSON content is malformed and cannot be parsed.
          </p>
        </div>
      `;

      this.emit('preview-error', {
        type: 'json',
        error: errorMessage
      });
    }
  }

  /**
   * Apply syntax highlighting to JSON
   * @param {string} json - Formatted JSON string
   * @returns {string} HTML with syntax highlighting
   */
  highlightJson(json) {
    // Escape HTML first
    let highlighted = this.escapeHtml(json);

    // Highlight keys (property names)
    highlighted = highlighted.replace(
      /"([^"]+)"(\s*:)/g,
      '<span class="json-key">"$1"</span>$2'
    );

    // Highlight string values
    highlighted = highlighted.replace(
      /:(\s*)"([^"]*)"/g,
      ': <span class="json-string">"$2"</span>'
    );

    // Highlight numbers
    highlighted = highlighted.replace(
      /:\s*(-?\d+\.?\d*)/g,
      ': <span class="json-number">$1</span>'
    );

    // Highlight booleans
    highlighted = highlighted.replace(
      /:\s*(true|false)/g,
      ': <span class="json-boolean">$1</span>'
    );

    // Highlight null
    highlighted = highlighted.replace(
      /:\s*(null)/g,
      ': <span class="json-null">$1</span>'
    );

    return highlighted;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    super.cleanup();
  }
}
