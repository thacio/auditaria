/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: SVG preview

import { BasePreview } from './BasePreview.js';

/**
 * SVG Preview
 *
 * Displays SVG vector graphics safely.
 * - Sanitizes SVG to remove script tags
 * - Inline rendering for immediate display
 * - Preserves vector quality
 *
 * @extends BasePreview
 */
export class SvgPreview extends BasePreview {
  constructor() {
    super();
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if SVG file
   */
  canPreview(language, filename) {
    return language === 'xml' && filename.toLowerCase().endsWith('.svg');
  }

  /**
   * Get preview type
   * @returns {string} 'svg'
   */
  getType() {
    return 'svg';
  }

  /**
   * Get human-readable name
   * @returns {string} 'SVG Preview'
   */
  getName() {
    return 'SVG Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - Scripts are removed
   */
  getSecurityLevel() {
    return 'safe';
  }

  /**
   * Get priority
   * @returns {number} 200 - Higher priority than generic Image preview
   */
  getPriority() {
    return 200;
  }

  /**
   * Get capabilities
   * @returns {Object} SVG preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: false,    // No refresh needed
      supportsExport: false,     // No export
      supportsSearch: false,     // No search
      supportsPrint: true,       // Can print SVG
      customToolbarButtons: []   // No custom buttons
    };
  }

  /**
   * Render SVG preview
   * @param {string} content - SVG content
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container svg-preview-container';

    if (!content || content.trim() === '') {
      this.showEmpty(container, 'No SVG content to preview');
      return;
    }

    try {
      // Sanitize SVG - remove script tags and event handlers
      const sanitized = this.sanitizeSvg(content);

      // Create wrapper for SVG
      const wrapper = document.createElement('div');
      wrapper.className = 'svg-preview-wrapper';
      wrapper.innerHTML = sanitized;

      container.appendChild(wrapper);

      // Emit loaded event
      this.emit('preview-loaded', {
        type: 'svg',
        contentSize: content.length
      });

    } catch (error) {
      console.error('Error rendering SVG:', error);
      this.showError(container, `Failed to render SVG: ${error.message}`);
      this.emit('preview-error', {
        type: 'svg',
        error: error.message
      });
    }
  }

  /**
   * Sanitize SVG content
   * Remove potentially dangerous elements and attributes
   * @param {string} svgContent - Raw SVG content
   * @returns {string} Sanitized SVG
   */
  sanitizeSvg(svgContent) {
    // Create temporary div
    const temp = document.createElement('div');
    temp.innerHTML = svgContent;

    // Remove script tags
    const scripts = temp.querySelectorAll('script');
    scripts.forEach(script => script.remove());

    // Remove on* event handlers from all elements
    const allElements = temp.querySelectorAll('*');
    allElements.forEach(el => {
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
        }
      });
    });

    // Remove potentially dangerous elements
    const dangerousTags = ['foreignObject']; // foreignObject can contain HTML/scripts
    dangerousTags.forEach(tag => {
      const elements = temp.querySelectorAll(tag);
      elements.forEach(el => el.remove());
    });

    return temp.innerHTML;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    super.cleanup();
  }
}
