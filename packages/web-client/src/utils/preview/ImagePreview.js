/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Image preview

import { BasePreview } from './BasePreview.js';

/**
 * Image Preview
 *
 * Displays image files (PNG, JPG, GIF, WEBP, BMP, etc.)
 * - Centered display with max dimensions
 * - Info overlay showing dimensions and file size
 * - Zoom capabilities (future enhancement)
 *
 * @extends BasePreview
 */
export class ImagePreview extends BasePreview {
  constructor() {
    super();
    this.currentImage = null;
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if image file
   */
  canPreview(language, filename) {
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico'];
    const lowerFilename = filename.toLowerCase();
    return imageExts.some(ext => lowerFilename.endsWith(ext));
  }

  /**
   * Get preview type
   * @returns {string} 'image'
   */
  getType() {
    return 'image';
  }

  /**
   * Get human-readable name
   * @returns {string} 'Image Preview'
   */
  getName() {
    return 'Image Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - Images are safe to display
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
   * @returns {Object} Image preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: false,    // No refresh needed
      supportsExport: false,     // No export
      supportsSearch: false,     // No search
      supportsPrint: false,      // No print
      customToolbarButtons: []   // No custom buttons
    };
  }

  /**
   * Get default settings
   * @returns {Object} Default settings
   */
  getDefaultSettings() {
    return {
      showDimensions: true,
      showFileSize: true,
      maxDisplaySize: 5 * 1024 * 1024 // 5MB
    };
  }

  /**
   * Render image preview
   * @param {string} content - File content (ignored for binary images)
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options { filename, filePath }
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container image-preview-container';

    const { filename, filePath } = options;

    if (!filePath) {
      this.showError(container, 'No image file path provided');
      return;
    }

    // Create image wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview-wrapper';

    // Create image element
    const img = document.createElement('img');
    img.className = 'image-preview-img';
    img.alt = filename || 'Image preview';

    // Use /preview-file/* endpoint to load binary image
    const normalizedPath = filePath.replace(/\\/g, '/');
    img.src = `/preview-file/${encodeURIComponent(normalizedPath)}`;

    // Loading state
    this.showLoading(container, 'Loading image...');

    // Handle load success
    img.onload = () => {
      container.innerHTML = '';

      // Create info overlay
      const info = document.createElement('div');
      info.className = 'image-preview-info';
      info.innerHTML = `
        <div class="image-info-content">
          <span class="image-dimensions">${img.naturalWidth} × ${img.naturalHeight}px</span>
        </div>
      `;

      wrapper.appendChild(img);
      wrapper.appendChild(info);
      container.appendChild(wrapper);

      this.currentImage = img;
      this.emit('preview-loaded', { filename });
    };

    // Handle load error
    img.onerror = () => {
      this.showError(container, `Failed to load image: ${filename}`);
      this.emit('preview-error', { filename, error: 'Failed to load image' });
    };
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.currentImage) {
      // Revoke blob URL if it exists
      if (this.currentImage.src && this.currentImage.src.startsWith('blob:')) {
        URL.revokeObjectURL(this.currentImage.src);
      }
      this.currentImage = null;
    }
    super.cleanup();
  }
}
