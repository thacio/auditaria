/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Video preview

import { BasePreview } from './BasePreview.js';

/**
 * Video Preview
 *
 * Displays video files using browser's native video player
 * - HTML5 <video> element with controls
 * - Supports MP4, WebM, AVI, MOV, etc.
 * - Shows video metadata and dimensions
 *
 * @extends BasePreview
 */
export class VideoPreview extends BasePreview {
  constructor() {
    super();
    this.currentVideo = null;
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if video file
   */
  canPreview(language, filename) {
    const videoExts = ['.mp4', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.m4v', '.ogv'];
    const lowerFilename = filename.toLowerCase();
    return videoExts.some(ext => lowerFilename.endsWith(ext));
  }

  /**
   * Get preview type
   * @returns {string} 'video'
   */
  getType() {
    return 'video';
  }

  /**
   * Get human-readable name
   * @returns {string} 'Video Preview'
   */
  getName() {
    return 'Video Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - Video rendered by browser's built-in player
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
   * @returns {Object} Video preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: false,     // No refresh needed
      supportsExport: false,       // Browser handles download
      supportsSearch: false,       // No search in video
      supportsPrint: false,        // Can't print video
      customToolbarButtons: []
    };
  }

  /**
   * Get default settings
   * @returns {Object} Default settings
   */
  getDefaultSettings() {
    return {
      autoplay: false,
      showMetadata: true,
      volume: 0.8
    };
  }

  /**
   * Render video preview
   * @param {string} content - File content (ignored for binary video)
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options { filename, filePath }
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container video-preview-container';

    const { filename, filePath } = options;

    if (!filePath) {
      this.showError(container, 'No video file path provided');
      return;
    }

    // Use /preview-file/* endpoint to load video
    const normalizedPath = filePath.replace(/\\/g, '/');
    const videoUrl = `/preview-file/${encodeURIComponent(normalizedPath)}`;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'video-preview-wrapper';

    // Create header with file info
    const header = document.createElement('div');
    header.className = 'video-preview-header';
    header.innerHTML = `
      <div class="video-icon">🎬</div>
      <div class="video-info">
        <div class="video-filename">${this.escapeHtml(filename || 'Video File')}</div>
        <div class="video-status">Loading...</div>
      </div>
    `;

    // Create video element
    const video = document.createElement('video');
    video.className = 'video-preview-player';
    video.controls = true;
    video.preload = 'metadata';
    video.src = videoUrl;

    // Set volume from settings
    const settings = this.getDefaultSettings();
    video.volume = settings.volume;

    // Handle metadata loaded
    video.addEventListener('loadedmetadata', () => {
      const statusEl = header.querySelector('.video-status');
      if (statusEl) {
        const duration = this.formatDuration(video.duration);
        const resolution = `${video.videoWidth} × ${video.videoHeight}`;
        statusEl.innerHTML = `
          <span class="video-resolution">${resolution}</span>
          <span class="video-divider">•</span>
          <span class="video-duration">${duration}</span>
        `;
        statusEl.style.color = '#666';
      }
    });

    // Handle load error
    video.addEventListener('error', () => {
      const statusEl = header.querySelector('.video-status');
      if (statusEl) {
        statusEl.textContent = 'Failed to load video file';
        statusEl.style.color = '#d32f2f';
      }
      this.emit('preview-error', { filename, error: 'Failed to load video' });
    });

    // Handle successful load
    video.addEventListener('canplay', () => {
      this.emit('preview-loaded', { filename });
    });

    // Assemble preview
    wrapper.appendChild(header);
    wrapper.appendChild(video);
    container.appendChild(wrapper);

    this.currentVideo = video;
  }

  /**
   * Format duration in seconds to HH:MM:SS or MM:SS
   * @param {number} seconds - Duration in seconds
   * @returns {string} Formatted duration
   */
  formatDuration(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) {
      return '0:00';
    }

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.currentVideo) {
      // Pause and remove video to free memory
      this.currentVideo.pause();
      this.currentVideo.src = '';
      if (this.currentVideo.parentNode) {
        this.currentVideo.parentNode.removeChild(this.currentVideo);
      }
      this.currentVideo = null;
    }
    super.cleanup();
  }
}
