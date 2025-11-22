/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Preview manager for multi-preview system

import { EventEmitter } from '../EventEmitter.js';
import { BasePreview } from './BasePreview.js';

/**
 * Preview Manager
 *
 * Central manager for all preview types.
 * - Factory Pattern: Selects appropriate preview based on file type
 * - Registry: Maintains list of available previews
 * - Configuration: Manages preview settings and enabled/disabled state
 * - Priority: Handles multiple previews for same file type
 * - Event Aggregation: Forwards events from previews
 *
 * Architecture:
 * - EditorPanel uses PreviewManager instead of specific preview
 * - PreviewManager delegates to appropriate preview based on file type
 * - Adding new preview type: Create class extending BasePreview, register it
 * - No changes to EditorPanel needed when adding new preview types
 *
 * @extends EventEmitter
 */
export class PreviewManager extends EventEmitter {
  /**
   * @param {Object} config - Configuration object
   * @param {Array<string>} config.enabledPreviews - List of enabled preview types
   * @param {Object} config.settings - Preview-specific settings
   */
  constructor(config = {}) {
    super();

    // Registry of preview instances
    this.previewers = [];

    // Configuration
    this.config = {
      // Which preview types are enabled (by type identifier)
      enabledPreviews: config.enabledPreviews || [
        'markdown',
        'html',
        'pdf',
        'video',
        'audio',
        'image',
        'svg',
        'json'
      ],

      // Preview-specific settings
      settings: config.settings || {
        html: {
          allowScripts: true,
          allowForms: true,
          allowSameOrigin: true,
          allowModals: true,
          allowPopups: false
        },
        image: {
          showDimensions: true,
          showFileSize: true,
          maxDisplaySize: 5 * 1024 * 1024 // 5MB
        },
        json: {
          indentSize: 2,
          expandDepth: 2,
          sortKeys: false
        },
        markdown: {
          // Existing markdown settings
        }
      }
    };

    // Currently active previewer (for cleanup)
    this.activePreviewer = null;
  }

  /**
   * Register a preview instance
   * @param {BasePreview} previewer - Preview instance to register
   */
  registerPreviewer(previewer) {
    if (!(previewer instanceof BasePreview)) {
      throw new Error('Previewer must extend BasePreview');
    }

    const previewType = previewer.getType();

    // Check if this preview type is enabled
    if (!this.config.enabledPreviews.includes(previewType)) {
      console.log(`Preview type "${previewType}" is disabled, skipping registration`);
      return;
    }

    // Configure previewer with user settings
    const settings = this.config.settings[previewType] || {};
    previewer.configure(settings);

    // Listen to previewer events and forward them
    this.setupPreviewerEvents(previewer);

    // Add to registry
    this.previewers.push(previewer);

    console.log(`Registered preview: ${previewer.getName()} (type: ${previewType}, priority: ${previewer.getPriority()})`);
  }

  /**
   * Register multiple previewers from registry
   * @param {Array} previewRegistry - Array of {name, class, enabled} objects
   */
  registerDefaults(previewRegistry) {
    previewRegistry
      .filter(p => p.enabled !== false)
      .forEach(({ class: PreviewClass }) => {
        const instance = new PreviewClass();
        this.registerPreviewer(instance);
      });
  }

  /**
   * Setup event forwarding from previewer to manager
   * @param {BasePreview} previewer - Previewer instance
   */
  setupPreviewerEvents(previewer) {
    // Forward all events from previewer
    const eventTypes = [
      'preview-loaded',
      'preview-error',
      'preview-ready',
      'preview-updated'
    ];

    eventTypes.forEach(eventType => {
      previewer.on(eventType, (data) => {
        this.emit(eventType, {
          ...data,
          previewType: previewer.getType()
        });
      });
    });
  }

  /**
   * Check if any previewer can handle this file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename with extension
   * @returns {boolean} True if at least one previewer can handle the file
   */
  canPreview(language, filename) {
    return this.getPreviewerFor(language, filename) !== null;
  }

  /**
   * Get the appropriate previewer for a file
   * Selects based on priority if multiple previewers can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename with extension
   * @returns {BasePreview|null} Previewer instance or null if none found
   */
  getPreviewerFor(language, filename) {
    // Find all previewers that can handle this file
    const candidates = this.previewers.filter(p => {
      try {
        return p.canPreview(language, filename);
      } catch (error) {
        console.error(`Error checking canPreview for ${p.getType()}:`, error);
        return false;
      }
    });

    if (candidates.length === 0) {
      return null;
    }

    // Sort by priority (higher priority first)
    candidates.sort((a, b) => b.getPriority() - a.getPriority());

    // Return highest priority previewer
    return candidates[0];
  }

  /**
   * Render content using appropriate previewer
   * Main method called by EditorPanel
   * @param {string} content - File content to preview
   * @param {HTMLElement} container - Container element
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @param {string} filePath - Full file path (optional, for previews that need it)
   */
  render(content, container, language, filename, filePath = null) {
    // Find appropriate previewer
    const previewer = this.getPreviewerFor(language, filename);

    if (!previewer) {
      container.innerHTML = `
        <div class="preview-error">
          <h3>No Preview Available</h3>
          <p>No preview is available for this file type.</p>
          <p class="preview-error-details">
            File: ${this.escapeHtml(filename)}<br>
            Language: ${this.escapeHtml(language)}
          </p>
        </div>
      `;
      return;
    }

    // Check if previewer dependencies are loaded
    if (!previewer.isLoaded()) {
      container.innerHTML = `
        <div class="preview-error">
          <h3>Preview Not Available</h3>
          <p>Preview library not loaded for ${this.escapeHtml(previewer.getName())}</p>
          <p class="preview-error-details">
            The required dependencies for this preview type are not available.
          </p>
        </div>
      `;
      return;
    }

    // Cleanup previous previewer if different
    if (this.activePreviewer && this.activePreviewer !== previewer) {
      try {
        this.activePreviewer.cleanup();
      } catch (error) {
        console.error('Error cleaning up previous previewer:', error);
      }
    }

    // Set active previewer
    this.activePreviewer = previewer;

    // Render preview
    try {
      previewer.render(content, container, { language, filename, filePath });
      this.emit('preview-rendered', {
        previewType: previewer.getType(),
        filename,
        contentSize: content.length
      });
    } catch (error) {
      console.error('Preview render error:', error);
      container.innerHTML = `
        <div class="preview-error">
          <h3>Preview Error</h3>
          <p>${this.escapeHtml(error.message)}</p>
          <p class="preview-error-details">
            Preview Type: ${this.escapeHtml(previewer.getName())}<br>
            File: ${this.escapeHtml(filename)}
          </p>
        </div>
      `;
      this.emit('preview-error', {
        previewType: previewer.getType(),
        filename,
        error: error.message
      });
    }
  }

  /**
   * Check if any previewer is loaded
   * For backward compatibility with MarkdownPreview.isLoaded()
   * @returns {boolean} True if at least one previewer is loaded
   */
  isLoaded() {
    return this.previewers.some(p => p.isLoaded());
  }

  /**
   * Cleanup all previewers
   */
  cleanup() {
    this.previewers.forEach(p => {
      try {
        p.cleanup();
      } catch (error) {
        console.error(`Error cleaning up previewer ${p.getType()}:`, error);
      }
    });
    this.activePreviewer = null;
    this.removeAllListeners();
  }

  /**
   * Get list of registered preview types
   * @returns {Array<Object>} Array of {type, name, priority, securityLevel}
   */
  getRegisteredPreviews() {
    return this.previewers.map(p => ({
      type: p.getType(),
      name: p.getName(),
      priority: p.getPriority(),
      securityLevel: p.getSecurityLevel(),
      isLoaded: p.isLoaded()
    }));
  }

  /**
   * Escape HTML to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} Escaped HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Update configuration for a specific preview type
   * @param {string} previewType - Preview type identifier
   * @param {Object} settings - New settings
   */
  updatePreviewSettings(previewType, settings) {
    this.config.settings[previewType] = {
      ...this.config.settings[previewType],
      ...settings
    };

    // Reconfigure the previewer
    const previewer = this.previewers.find(p => p.getType() === previewType);
    if (previewer) {
      previewer.configure(this.config.settings[previewType]);
    }
  }

  /**
   * Enable or disable a preview type
   * @param {string} previewType - Preview type identifier
   * @param {boolean} enabled - Enable or disable
   */
  setPreviewEnabled(previewType, enabled) {
    if (enabled) {
      if (!this.config.enabledPreviews.includes(previewType)) {
        this.config.enabledPreviews.push(previewType);
      }
    } else {
      const index = this.config.enabledPreviews.indexOf(previewType);
      if (index > -1) {
        this.config.enabledPreviews.splice(index, 1);
      }
    }
  }
}
