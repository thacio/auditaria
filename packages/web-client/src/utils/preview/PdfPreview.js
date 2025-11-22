/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: PDF preview

import { BasePreview } from './BasePreview.js';

/**
 * PDF Preview
 *
 * Displays PDF files using browser's native PDF viewer
 * - Embedded using <embed> or <iframe> tag
 * - Browser handles PDF rendering natively
 * - Full-page display with controls
 *
 * @extends BasePreview
 */
export class PdfPreview extends BasePreview {
  constructor() {
    super();
    this.currentEmbed = null;
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if PDF file
   */
  canPreview(language, filename) {
    const lowerFilename = filename.toLowerCase();
    return lowerFilename.endsWith('.pdf');
  }

  /**
   * Get preview type
   * @returns {string} 'pdf'
   */
  getType() {
    return 'pdf';
  }

  /**
   * Get human-readable name
   * @returns {string} 'PDF Preview'
   */
  getName() {
    return 'PDF Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - PDFs rendered by browser's built-in viewer
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
   * @returns {Object} PDF preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: true,      // Can reload PDF
      supportsExport: false,       // Browser handles download
      supportsSearch: false,       // Browser's PDF viewer has search
      supportsPrint: false,        // Browser's PDF viewer has print
      customToolbarButtons: [
        {
          id: 'open-external',
          label: 'Open in Browser',
          icon: 'external-link',
          action: 'openExternal'
        }
      ]
    };
  }

  /**
   * Get default settings
   * @returns {Object} Default settings
   */
  getDefaultSettings() {
    return {
      useEmbed: true,  // Use <embed> instead of <iframe> for better compatibility
      toolbar: true,   // Show PDF toolbar (browser's default)
      zoom: 'auto'     // Auto zoom level
    };
  }

  /**
   * Render PDF preview
   * @param {string} content - File content (ignored for binary PDFs)
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options { filename, filePath }
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container pdf-preview-container';

    const { filename, filePath } = options;

    if (!filePath) {
      this.showError(container, 'No PDF file path provided');
      return;
    }

    // Use /preview-file/* endpoint to load PDF
    const normalizedPath = filePath.replace(/\\/g, '/');
    const pdfUrl = `/preview-file/${encodeURIComponent(normalizedPath)}`;

    // Create embed element (better browser compatibility than iframe for PDFs)
    const embed = document.createElement('embed');
    embed.className = 'pdf-preview-embed';
    embed.type = 'application/pdf';
    embed.src = pdfUrl;
    embed.width = '100%';
    embed.height = '100%';

    // Handle load error - show fallback if PDF fails to load
    embed.addEventListener('error', () => {
      container.innerHTML = '';
      container.innerHTML = `
        <div class="preview-info" style="padding: 40px; text-align: center; color: #666;">
          <div style="font-size: 48px; margin-bottom: 16px;">📄</div>
          <h3 style="margin: 0 0 12px 0;">PDF Preview</h3>
          <p style="margin: 0 0 16px 0;">
            <strong>${this.escapeHtml(filename || 'Document.pdf')}</strong>
          </p>
          <p style="margin: 0 0 16px 0; color: #999;">
            Your browser doesn't support inline PDF viewing.
          </p>
          <a href="${pdfUrl}" target="_blank" class="pdf-download-link"
             style="display: inline-block; padding: 10px 20px; background: #0066cc; color: white;
                    text-decoration: none; border-radius: 6px; font-weight: 500;">
            Open PDF in New Tab
          </a>
        </div>
      `;
    });

    // Add embed to container
    container.appendChild(embed);

    this.currentEmbed = embed;
    this.emit('preview-loaded', { filename });
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.currentEmbed) {
      // Remove embed element to stop PDF loading
      if (this.currentEmbed.parentNode) {
        this.currentEmbed.parentNode.removeChild(this.currentEmbed);
      }
      this.currentEmbed = null;
    }
    super.cleanup();
  }
}
