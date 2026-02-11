/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: HTML preview with sandboxed iframe

import { BasePreview } from './BasePreview.js';
import { showErrorToast } from '../../components/Toast.js';

/**
 * HTML Preview
 *
 * Renders HTML content in a sandboxed iframe.
 * - Sandbox attributes allow scripts, forms, same-origin for developer convenience
 * - Security warning shown to user
 * - Refresh capability to reload preview
 * - External browser opening capability
 *
 * Security Model:
 * - iframe sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups"
 * - User is warned about script execution
 * - Suitable for local development (user is editing the file anyway)
 * - NOT suitable for untrusted content
 *
 * @extends BasePreview
 */
export class HtmlPreview extends BasePreview {
  constructor() {
    super();
    this.currentIframe = null;
    this.currentContent = '';
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if HTML file
   */
  canPreview(language, filename) {
    return language === 'html' ||
           filename.toLowerCase().endsWith('.html') ||
           filename.toLowerCase().endsWith('.htm');
  }

  /**
   * Get preview type
   * @returns {string} 'html'
   */
  getType() {
    return 'html';
  }

  /**
   * Get human-readable name
   * @returns {string} 'HTML Preview'
   */
  getName() {
    return 'HTML Preview';
  }

  /**
   * Get security level
   * @returns {string} 'sandboxed' - Scripts run in iframe sandbox
   */
  getSecurityLevel() {
    return 'sandboxed';
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
   * @returns {Object} HTML preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: true,     // Can refresh preview
      supportsExport: false,     // No export (yet)
      supportsSearch: false,     // No search
      supportsPrint: true,       // Can print rendered HTML
      customToolbarButtons: [
        {
          id: 'html-refresh',
          icon: 'codicon-refresh',
          label: 'Refresh',
          title: 'Refresh HTML preview',
          action: () => this.refresh()
        },
        {
          id: 'html-open-external',
          icon: 'codicon-link-external',
          label: 'Open in Browser',
          title: 'Open HTML in external browser',
          action: () => this.openInBrowser()
        }
      ]
    };
  }

  /**
   * Get default settings
   * @returns {Object} Default settings for HTML preview
   */
  getDefaultSettings() {
    return {
      allowScripts: true,
      allowForms: true,
      allowSameOrigin: true,
      allowModals: true,
      allowPopups: false
    };
  }

  /**
   * Render HTML content in sandboxed iframe
   * @param {string} content - HTML content
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container html-preview-container';

    // Store content for refresh
    this.currentContent = content;

    if (!content || content.trim() === '') {
      this.showEmpty(container, 'No HTML content to preview');
      return;
    }

    // Get the file path from options (passed by PreviewManager)
    // We need the actual file path to serve it with correct base URL for relative paths
    const filename = options.filename || 'preview.html';

    // Check if we have a full file path (from EditorManager)
    // If options has a filePath, use server endpoint for proper relative path support
    // Otherwise fall back to srcdoc
    const useServerPreview = window.location.protocol === 'http:' || window.location.protocol === 'https:';

    // Create iframe wrapper (no warning bar - user is editing their own file)
    const iframeWrapper = document.createElement('div');
    iframeWrapper.className = 'html-preview-iframe-wrapper';

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.className = 'html-preview-iframe';

    // Build sandbox attributes from settings
    const sandboxAttrs = [];
    if (this.settings.allowScripts) sandboxAttrs.push('allow-scripts');
    if (this.settings.allowForms) sandboxAttrs.push('allow-forms');
    if (this.settings.allowSameOrigin) sandboxAttrs.push('allow-same-origin');
    if (this.settings.allowModals) sandboxAttrs.push('allow-modals');
    if (this.settings.allowPopups) sandboxAttrs.push('allow-popups');

    iframe.sandbox = sandboxAttrs.join(' ');

    // Store reference for cleanup
    this.currentIframe = iframe;
    this.currentFilePath = options.filePath;

    // Set iframe source
    if (useServerPreview && this.currentFilePath) {
      // Use server endpoint for proper relative path support
      // Normalize path for URL (replace backslashes with forward slashes for Windows)
      const normalizedPath = this.currentFilePath.replace(/\\/g, '/');
      iframe.src = `/preview-file/${encodeURIComponent(normalizedPath)}`;
      console.log('HTML preview using server endpoint:', iframe.src);
    } else {
      // Fallback to srcdoc (won't support relative paths)
      iframe.srcdoc = content;
      console.log('HTML preview using srcdoc (no relative path support)');
    }

    // Add load event listener
    iframe.addEventListener('load', () => {
      this.emit('preview-loaded', {
        type: 'html',
        contentSize: content.length
      });
    });

    // Add error event listener
    iframe.addEventListener('error', (error) => {
      console.error('HTML preview error:', error);
      this.emit('preview-error', {
        type: 'html',
        error: error.message || 'Unknown error'
      });
    });

    // Add iframe to wrapper
    iframeWrapper.appendChild(iframe);

    // Add wrapper to container
    container.appendChild(iframeWrapper);
  }

  /**
   * Create security warning banner
   * @returns {HTMLElement} Warning element
   */
  createSecurityWarning() {
    const warning = document.createElement('div');
    warning.className = 'preview-security-warning';

    const sandboxAttrs = [];
    if (this.settings.allowScripts) sandboxAttrs.push('scripts');
    if (this.settings.allowForms) sandboxAttrs.push('forms');
    if (this.settings.allowSameOrigin) sandboxAttrs.push('same-origin');
    if (this.settings.allowModals) sandboxAttrs.push('modals');
    if (this.settings.allowPopups) sandboxAttrs.push('popups');

    warning.innerHTML = `
      <span style="font-size: 16px;">⚠️</span>
      <strong>HTML Preview</strong> -
      Content runs in a sandboxed iframe with
      <strong>${sandboxAttrs.join(', ')}</strong> enabled.
      This is suitable for local development.
    `;

    return warning;
  }

  /**
   * Refresh the preview
   * Reloads the iframe with current content
   */
  refresh() {
    if (this.currentIframe && this.currentContent) {
      // Force reload by re-setting srcdoc
      this.currentIframe.srcdoc = '';
      setTimeout(() => {
        if (this.currentIframe) {
          this.currentIframe.srcdoc = this.currentContent;
          console.log('HTML preview refreshed');
        }
      }, 50);
    }
  }

  /**
   * Open HTML in external browser
   * Creates a blob URL and opens in new window
   */
  openInBrowser() {
    if (!this.currentContent) {
      console.warn('No content to open in browser');
      return;
    }

    try {
      // Create blob URL
      const blob = new Blob([this.currentContent], { type: 'text/html' });
      const url = URL.createObjectURL(blob);

      // Open in new window
      const win = window.open(url, '_blank');

      if (win) {
        // Clean up blob URL after window loads
        win.addEventListener('load', () => {
          // Give it a moment to fully load, then revoke
          setTimeout(() => {
            URL.revokeObjectURL(url);
          }, 1000);
        });
      } else {
        // Popup blocked or failed
        console.warn('Failed to open window - popup may be blocked');
        URL.revokeObjectURL(url);
        showErrorToast('Failed to open in browser. Please check popup settings.');
      }
    } catch (error) {
      console.error('Error opening in browser:', error);
      showErrorToast(`Error opening in browser: ${error.message}`);
    }
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.currentIframe) {
      // Remove iframe from DOM
      if (this.currentIframe.parentNode) {
        this.currentIframe.parentNode.removeChild(this.currentIframe);
      }
      this.currentIframe = null;
    }
    this.currentContent = '';
    super.cleanup();
  }

  /**
   * Check if dependencies are loaded
   * @returns {boolean} True - no dependencies needed
   */
  isLoaded() {
    return true; // HTML preview has no external dependencies
  }
}
