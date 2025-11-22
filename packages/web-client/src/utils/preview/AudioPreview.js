/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: Audio preview

import { BasePreview } from './BasePreview.js';

/**
 * Audio Preview
 *
 * Displays audio files using browser's native audio player
 * - HTML5 <audio> element with controls
 * - Supports MP3, WAV, OGG, AAC, FLAC, etc.
 * - Shows waveform visualization and metadata
 *
 * @extends BasePreview
 */
export class AudioPreview extends BasePreview {
  constructor() {
    super();
    this.currentAudio = null;
  }

  /**
   * Check if this preview can handle the file
   * @param {string} language - Monaco language ID
   * @param {string} filename - Full filename
   * @returns {boolean} True if audio file
   */
  canPreview(language, filename) {
    const audioExts = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.opus'];
    const lowerFilename = filename.toLowerCase();
    return audioExts.some(ext => lowerFilename.endsWith(ext));
  }

  /**
   * Get preview type
   * @returns {string} 'audio'
   */
  getType() {
    return 'audio';
  }

  /**
   * Get human-readable name
   * @returns {string} 'Audio Preview'
   */
  getName() {
    return 'Audio Preview';
  }

  /**
   * Get security level
   * @returns {string} 'safe' - Audio rendered by browser's built-in player
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
   * @returns {Object} Audio preview capabilities
   */
  getCapabilities() {
    return {
      supportsRefresh: false,     // No refresh needed
      supportsExport: false,       // Browser handles download
      supportsSearch: false,       // No search in audio
      supportsPrint: false,        // Can't print audio
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
   * Render audio preview
   * @param {string} content - File content (ignored for binary audio)
   * @param {HTMLElement} container - Container element
   * @param {Object} options - Rendering options { filename, filePath }
   */
  render(content, container, options = {}) {
    // Clear previous content
    this.cleanup();
    container.innerHTML = '';
    container.className = 'preview-container audio-preview-container';

    const { filename, filePath } = options;

    if (!filePath) {
      this.showError(container, 'No audio file path provided');
      return;
    }

    // Use /preview-file/* endpoint to load audio
    const normalizedPath = filePath.replace(/\\/g, '/');
    const audioUrl = `/preview-file/${encodeURIComponent(normalizedPath)}`;

    // Create wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'audio-preview-wrapper';

    // Create header with file info
    const header = document.createElement('div');
    header.className = 'audio-preview-header';
    header.innerHTML = `
      <div class="audio-icon">🎵</div>
      <div class="audio-info">
        <div class="audio-filename">${this.escapeHtml(filename || 'Audio File')}</div>
        <div class="audio-status">Loading...</div>
      </div>
    `;

    // Create audio element
    const audio = document.createElement('audio');
    audio.className = 'audio-preview-player';
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = audioUrl;

    // Set volume from settings
    const settings = this.getDefaultSettings();
    audio.volume = settings.volume;

    // Handle metadata loaded
    audio.addEventListener('loadedmetadata', () => {
      const statusEl = header.querySelector('.audio-status');
      if (statusEl) {
        const duration = this.formatDuration(audio.duration);
        statusEl.textContent = `Duration: ${duration}`;
        statusEl.style.color = '#666';
      }
    });

    // Handle load error
    audio.addEventListener('error', () => {
      const statusEl = header.querySelector('.audio-status');
      if (statusEl) {
        statusEl.textContent = 'Failed to load audio file';
        statusEl.style.color = '#d32f2f';
      }
      this.emit('preview-error', { filename, error: 'Failed to load audio' });
    });

    // Handle successful load
    audio.addEventListener('canplay', () => {
      this.emit('preview-loaded', { filename });
    });

    // Assemble preview
    wrapper.appendChild(header);
    wrapper.appendChild(audio);
    container.appendChild(wrapper);

    this.currentAudio = audio;
  }

  /**
   * Format duration in seconds to MM:SS
   * @param {number} seconds - Duration in seconds
   * @returns {string} Formatted duration
   */
  formatDuration(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) {
      return '0:00';
    }

    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.currentAudio) {
      // Pause and remove audio to free memory
      this.currentAudio.pause();
      this.currentAudio.src = '';
      if (this.currentAudio.parentNode) {
        this.currentAudio.parentNode.removeChild(this.currentAudio);
      }
      this.currentAudio = null;
    }
    super.cleanup();
  }
}
