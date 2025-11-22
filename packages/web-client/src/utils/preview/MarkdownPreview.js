/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Markdown preview component (refactored for multi-preview system)

import { BasePreview } from './BasePreview.js';

/**
 * Markdown Preview
 *
 * Renders markdown content using marked.js
 * - Converts markdown to HTML
 * - Syntax highlighting for code blocks (basic)
 * - Safe HTML rendering (sanitization)
 * - GitHub Flavored Markdown support
 *
 * @extends BasePreview
 */
export class MarkdownPreview extends BasePreview {
  constructor() {
    super();

    // Check if marked.js is available
    this.isMarkedLoaded = typeof window.marked !== 'undefined';

    if (!this.isMarkedLoaded) {
      console.warn('marked.js not loaded - markdown preview will not work');
    } else {
      this.configureMarked();
    }
  }

  /**
   * Configure marked.js options
   */
  configureMarked() {
    if (!window.marked) return;

    // Configure marked options
    window.marked.setOptions({
      breaks: true,        // GFM line breaks
      gfm: true,          // GitHub Flavored Markdown
      headerIds: true,    // Add IDs to headers
      mangle: false,      // Don't mangle email addresses
      pedantic: false,    // Don't be pedantic
      sanitize: false,    // We'll handle sanitization ourselves
      smartLists: true,   // Smarter list behavior
      smartypants: false, // Don't use smart typography
      xhtml: false        // Don't use XHTML tags
    });
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if markdown file
   */
  canPreview(language, filename) {
    return language === 'markdown' ||
           filename.toLowerCase().endsWith('.md') ||
           filename.toLowerCase().endsWith('.markdown');
  }

  /**
   * Get preview type
   * @returns {string} 'markdown'
   */
  getType() {
    return 'markdown';
  }

  /**
   * Get human-readable name
   * @returns {string} 'Markdown Preview'
   */
  getName() {
    return 'Markdown Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - HTML is sanitized
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
   * @returns {Object} Markdown preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: false,   // Markdown updates automatically in split mode
      supportsExport: false,    // No export feature (yet)
      supportsSearch: false,    // No search feature (yet)
      supportsPrint: true,      // Can print rendered markdown
      customToolbarButtons: []  // No custom buttons (parse button handled separately)
    };
  }

  /**
   * Check if marked.js is loaded
   * @returns {boolean} True if marked.js is available
   */
  isLoaded() {
    return this.isMarkedLoaded && typeof window.marked !== 'undefined';
  }

  /**
   * Render markdown content
   * @param {string} content - Markdown content
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options
   */
  render(content, container, options = {}) {
    if (!this.isLoaded()) {
      this.showError(container, 'marked.js library is not loaded. Cannot render markdown preview.');
      return;
    }

    if (!content || content.trim() === '') {
      this.showEmpty(container, 'No content to preview');
      return;
    }

    try {
      // Convert markdown to HTML
      const html = window.marked.parse(content);

      // Sanitize and render
      const sanitized = this.sanitizeHtml(html);

      // Clear container and add preview class
      container.innerHTML = '';
      container.className = 'preview-container markdown-preview-container';

      // Create content wrapper
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-preview-content';
      wrapper.innerHTML = sanitized;

      container.appendChild(wrapper);

      // Apply syntax highlighting to code blocks
      this.highlightCodeBlocks(wrapper);

      // Make external links safe
      this.makeLinksSecure(wrapper);

      // Emit loaded event
      this.emit('preview-loaded', {
        type: 'markdown',
        contentSize: content.length
      });

    } catch (error) {
      console.error('Error rendering markdown:', error);
      this.showError(container, `Failed to render markdown: ${error.message}`);
      this.emit('preview-error', {
        type: 'markdown',
        error: error.message
      });
    }
  }

  /**
   * Basic HTML sanitization
   * Removes potentially dangerous tags and attributes
   * @param {string} html - HTML string
   * @returns {string} Sanitized HTML
   */
  sanitizeHtml(html) {
    // Create a temporary div
    const temp = document.createElement('div');
    temp.innerHTML = html;

    // Remove script tags
    const scripts = temp.querySelectorAll('script');
    scripts.forEach(script => script.remove());

    // Remove on* event handlers
    const allElements = temp.querySelectorAll('*');
    allElements.forEach(el => {
      // Remove event handler attributes
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('on')) {
          el.removeAttribute(attr.name);
        }
      });

      // Remove javascript: links
      if (el.tagName === 'A' && el.getAttribute('href')?.startsWith('javascript:')) {
        el.removeAttribute('href');
      }
    });

    return temp.innerHTML;
  }

  /**
   * Apply basic syntax highlighting to code blocks
   * @param {HTMLElement} container
   */
  highlightCodeBlocks(container) {
    const codeBlocks = container.querySelectorAll('pre code');

    codeBlocks.forEach(block => {
      // Get language from class (e.g., class="language-javascript")
      const classes = block.className.split(' ');
      const langClass = classes.find(c => c.startsWith('language-'));
      const language = langClass ? langClass.replace('language-', '') : '';

      // Add language label
      if (language) {
        const pre = block.parentElement;
        if (pre && pre.tagName === 'PRE') {
          const label = document.createElement('div');
          label.className = 'code-block-language';
          label.textContent = language;
          label.style.cssText = `
            position: absolute;
            top: 4px;
            right: 8px;
            background: #007acc;
            color: #ffffff;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
          `;
          pre.style.position = 'relative';
          pre.insertBefore(label, pre.firstChild);
        }
      }

      // Basic syntax highlighting (very simple - just keywords)
      if (language === 'javascript' || language === 'typescript' || language === 'js' || language === 'ts') {
        this.highlightJavaScript(block);
      }
    });
  }

  /**
   * Very basic JavaScript syntax highlighting
   * @param {HTMLElement} block
   */
  highlightJavaScript(block) {
    const code = block.textContent;
    if (!code) return;

    // Simple keyword highlighting
    const keywords = [
      'const', 'let', 'var', 'function', 'class', 'if', 'else', 'for', 'while',
      'return', 'break', 'continue', 'switch', 'case', 'default', 'try', 'catch',
      'finally', 'throw', 'async', 'await', 'import', 'export', 'from', 'new',
      'this', 'super', 'extends', 'typeof', 'instanceof', 'void', 'delete'
    ];

    let highlighted = this.escapeHtml(code);

    // Highlight keywords (very basic)
    keywords.forEach(keyword => {
      const regex = new RegExp(`\\b(${keyword})\\b`, 'g');
      highlighted = highlighted.replace(regex, '<span style="color: #569cd6;">$1</span>');
    });

    // Highlight strings (basic)
    highlighted = highlighted.replace(
      /(['"`])(?:(?=(\\?))\2.)*?\1/g,
      '<span style="color: #ce9178;">$&</span>'
    );

    // Highlight comments (basic)
    highlighted = highlighted.replace(
      /\/\/.*/g,
      '<span style="color: #6a9955;">$&</span>'
    );

    block.innerHTML = highlighted;
  }

  /**
   * Make external links secure
   * @param {HTMLElement} container
   */
  makeLinksSecure(container) {
    const links = container.querySelectorAll('a');

    links.forEach(link => {
      const href = link.getAttribute('href');

      // External links
      if (href && (href.startsWith('http://') || href.startsWith('https://'))) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }

      // Add title if not present
      if (!link.getAttribute('title')) {
        link.setAttribute('title', href || '');
      }
    });
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    super.cleanup();
    // No special cleanup needed for markdown
  }
}
