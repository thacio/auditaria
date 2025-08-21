/**
 * Audio Player Modal Component
 * Provides a professional audio playback interface with controls
 */

export class AudioPlayerModal {
  constructor() {
    this.modal = null;
    this.audio = null;
    this.currentAttachment = null;
    this.isPlaying = false;
    this.isDragging = false;
    this.animationFrameId = null;
    
    // UI elements (will be initialized after DOM is ready)
    this.playPauseBtn = null;
    this.progressBar = null;
    this.progressFill = null;
    this.progressThumb = null;
    this.currentTimeEl = null;
    this.durationEl = null;
    this.volumeSlider = null;
    this.volumeIcon = null;
    this.downloadBtn = null;
    this.fileNameEl = null;
    this.waveformContainer = null;
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.init());
    } else {
      this.init();
    }
  }
  
  init() {
    // Get modal element
    this.modal = document.getElementById('audio-player-modal');
    if (!this.modal) {
      console.warn('Audio player modal element not found');
      return;
    }
    
    // Get UI elements
    this.playPauseBtn = document.getElementById('audio-play-pause');
    this.progressBar = document.getElementById('audio-progress-bar');
    this.progressFill = document.getElementById('audio-progress-fill');
    this.progressThumb = document.getElementById('audio-progress-thumb');
    this.currentTimeEl = document.getElementById('audio-current-time');
    this.durationEl = document.getElementById('audio-duration');
    this.volumeSlider = document.getElementById('audio-volume-slider');
    this.volumeIcon = document.getElementById('audio-volume-icon');
    this.downloadBtn = document.getElementById('audio-download-btn');
    this.fileNameEl = document.getElementById('audio-file-name');
    this.waveformContainer = document.getElementById('audio-waveform');
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Create audio element
    this.audio = new Audio();
    this.audio.addEventListener('loadedmetadata', () => this.onAudioLoaded());
    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.audio.addEventListener('ended', () => this.onAudioEnded());
    this.audio.addEventListener('error', (e) => this.onAudioError(e));
  }
  
  setupEventListeners() {
    // Close button
    const closeBtn = document.getElementById('audio-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.close());
    }
    
    // Play/Pause button
    if (this.playPauseBtn) {
      this.playPauseBtn.addEventListener('click', () => this.togglePlayPause());
    }
    
    // Progress bar interactions
    if (this.progressBar) {
      this.progressBar.addEventListener('click', (e) => this.seekToPosition(e));
      this.progressBar.addEventListener('mousedown', (e) => this.startDragging(e));
    }
    
    // Volume control
    if (this.volumeSlider) {
      this.volumeSlider.addEventListener('input', (e) => this.updateVolume(e));
    }
    
    if (this.volumeIcon) {
      this.volumeIcon.addEventListener('click', () => this.toggleMute());
    }
    
    // Download button
    if (this.downloadBtn) {
      this.downloadBtn.addEventListener('click', () => this.downloadAudio());
    }
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleKeyPress(e));
    
    // Drag events
    document.addEventListener('mousemove', (e) => this.handleDragging(e));
    document.addEventListener('mouseup', () => this.stopDragging());
    
    // Click outside to close
    if (this.modal) {
      this.modal.addEventListener('click', (e) => {
        if (e.target === this.modal) {
          this.close();
        }
      });
    }
  }
  
  /**
   * Open the modal with an audio attachment
   */
  open(attachment) {
    if (!this.modal || !attachment) return;
    
    console.log('Opening audio player with attachment:', {
      name: attachment.name,
      mimeType: attachment.mimeType,
      hasData: !!attachment.data,
      dataLength: attachment.data ? attachment.data.length : 0,
      size: attachment.size,
      type: attachment.type
    });
    
    this.currentAttachment = attachment;
    this.modal.style.display = 'flex';
    
    // Set file name
    if (this.fileNameEl) {
      this.fileNameEl.textContent = attachment.name || 'Audio File';
    }
    
    // Load audio
    this.loadAudio(attachment);
    
    // Generate waveform visualization
    this.generateWaveform();
    
    // Reset UI
    this.resetUI();
    
    // Add open class for animation
    setTimeout(() => {
      this.modal.classList.add('open');
    }, 10);
  }
  
  /**
   * Load audio from attachment
   */
  loadAudio(attachment) {
    if (!this.audio) return;
    
    try {
      // Check if we have base64 data
      if (!attachment.data) {
        console.error('No audio data found in attachment');
        this.showError('No audio data available');
        return;
      }
      
      // Determine the MIME type
      const mimeType = attachment.mimeType || 'audio/mpeg';
      console.log('Loading audio with MIME type:', mimeType);
      console.log('Base64 data length:', attachment.data.length);
      
      // ALWAYS use Blob URL approach for better compatibility
      // The attachment.data is pure base64 (without data URL prefix)
      try {
        // Convert base64 to binary
        const byteCharacters = atob(attachment.data);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        
        // Create blob from binary data
        const blob = new Blob([byteArray], { type: mimeType });
        console.log('Created blob:', blob.size, 'bytes, type:', blob.type);
        
        // Create blob URL for the audio element
        const blobUrl = URL.createObjectURL(blob);
        console.log('Created blob URL:', blobUrl);
        
        // Set the audio source
        this.audio.src = blobUrl;
        this.currentAudioUrl = blobUrl;
        this.isUsingBlobUrl = true;
        
        // Load the audio
        this.audio.load();
        console.log('Audio element loading from blob URL');
        
      } catch (blobError) {
        console.error('Failed to create blob from base64:', blobError);
        
        // Fallback: try data URL (less compatible but worth trying)
        try {
          const dataUrl = `data:${mimeType};base64,${attachment.data}`;
          console.log('Falling back to data URL approach');
          this.audio.src = dataUrl;
          this.currentAudioUrl = dataUrl;
          this.isUsingBlobUrl = false;
          this.audio.load();
        } catch (dataUrlError) {
          console.error('Data URL fallback also failed:', dataUrlError);
          throw new Error('Could not load audio in any format');
        }
      }
      
    } catch (error) {
      console.error('Failed to load audio:', error);
      this.showError('Failed to load audio file: ' + error.message);
    }
  }
  
  /**
   * Generate waveform visualization
   */
  generateWaveform() {
    if (!this.waveformContainer) return;
    
    // Clear existing waveform
    this.waveformContainer.innerHTML = '';
    
    // Create waveform bars (visual representation)
    const barCount = 50;
    for (let i = 0; i < barCount; i++) {
      const bar = document.createElement('div');
      bar.className = 'waveform-bar';
      
      // Random height for visual effect
      const height = Math.random() * 60 + 20;
      bar.style.height = `${height}%`;
      
      // Add progress indicator
      const progress = document.createElement('div');
      progress.className = 'waveform-bar-progress';
      bar.appendChild(progress);
      
      this.waveformContainer.appendChild(bar);
    }
  }
  
  /**
   * Update waveform progress
   */
  updateWaveformProgress(percentage) {
    if (!this.waveformContainer) return;
    
    const bars = this.waveformContainer.querySelectorAll('.waveform-bar');
    const filledBars = Math.floor((percentage / 100) * bars.length);
    
    bars.forEach((bar, index) => {
      const progress = bar.querySelector('.waveform-bar-progress');
      if (progress) {
        if (index < filledBars) {
          progress.style.height = '100%';
        } else if (index === filledBars) {
          const partial = ((percentage / 100) * bars.length) - filledBars;
          progress.style.height = `${partial * 100}%`;
        } else {
          progress.style.height = '0';
        }
      }
    });
  }
  
  /**
   * Reset UI to initial state
   */
  resetUI() {
    this.isPlaying = false;
    this.updatePlayPauseButton();
    this.updateProgress(0);
    
    if (this.currentTimeEl) {
      this.currentTimeEl.textContent = '0:00';
    }
    
    if (this.volumeSlider) {
      this.volumeSlider.value = this.audio ? this.audio.volume * 100 : 100;
    }
  }
  
  /**
   * Handle audio loaded event
   */
  onAudioLoaded() {
    if (!this.audio || !this.durationEl) return;
    
    const duration = this.formatTime(this.audio.duration);
    this.durationEl.textContent = duration;
  }
  
  /**
   * Handle time update event
   */
  onTimeUpdate() {
    if (!this.audio || this.isDragging) return;
    
    const currentTime = this.audio.currentTime;
    const duration = this.audio.duration;
    
    if (duration) {
      const percentage = (currentTime / duration) * 100;
      this.updateProgress(percentage);
      
      if (this.currentTimeEl) {
        this.currentTimeEl.textContent = this.formatTime(currentTime);
      }
    }
  }
  
  /**
   * Handle audio ended event
   */
  onAudioEnded() {
    this.isPlaying = false;
    this.updatePlayPauseButton();
    this.updateProgress(0);
    
    if (this.currentTimeEl) {
      this.currentTimeEl.textContent = '0:00';
    }
  }
  
  /**
   * Handle audio error event
   */
  onAudioError(error) {
    console.error('Audio playback error:', error);
    this.showError('Error playing audio file');
  }
  
  /**
   * Toggle play/pause
   */
  togglePlayPause() {
    if (!this.audio) return;
    
    if (this.isPlaying) {
      this.audio.pause();
      this.isPlaying = false;
    } else {
      this.audio.play().catch(error => {
        console.error('Failed to play audio:', error);
        this.showError('Failed to play audio');
      });
      this.isPlaying = true;
    }
    
    this.updatePlayPauseButton();
  }
  
  /**
   * Update play/pause button
   */
  updatePlayPauseButton() {
    if (!this.playPauseBtn) return;
    
    if (this.isPlaying) {
      this.playPauseBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <rect x="6" y="4" width="4" height="16" rx="1"></rect>
          <rect x="14" y="4" width="4" height="16" rx="1"></rect>
        </svg>
      `;
      this.playPauseBtn.title = 'Pause';
    } else {
      this.playPauseBtn.innerHTML = `
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M8 5v14l11-7z"></path>
        </svg>
      `;
      this.playPauseBtn.title = 'Play';
    }
  }
  
  /**
   * Update progress bar
   */
  updateProgress(percentage) {
    if (this.progressFill) {
      this.progressFill.style.width = `${percentage}%`;
    }
    
    if (this.progressThumb) {
      this.progressThumb.style.left = `${percentage}%`;
    }
    
    // Update waveform
    this.updateWaveformProgress(percentage);
  }
  
  /**
   * Seek to position on progress bar click
   */
  seekToPosition(event) {
    if (!this.audio || !this.progressBar) return;
    
    const rect = this.progressBar.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const percentage = (x / rect.width) * 100;
    
    const newTime = (percentage / 100) * this.audio.duration;
    this.audio.currentTime = newTime;
    this.updateProgress(percentage);
  }
  
  /**
   * Start dragging the progress thumb
   */
  startDragging(event) {
    if (event.target === this.progressThumb || event.target.closest('#audio-progress-thumb')) {
      this.isDragging = true;
      event.preventDefault();
    }
  }
  
  /**
   * Handle dragging movement
   */
  handleDragging(event) {
    if (!this.isDragging || !this.progressBar || !this.audio) return;
    
    const rect = this.progressBar.getBoundingClientRect();
    let x = event.clientX - rect.left;
    x = Math.max(0, Math.min(x, rect.width));
    
    const percentage = (x / rect.width) * 100;
    this.updateProgress(percentage);
    
    // Update time display
    const newTime = (percentage / 100) * this.audio.duration;
    if (this.currentTimeEl) {
      this.currentTimeEl.textContent = this.formatTime(newTime);
    }
  }
  
  /**
   * Stop dragging
   */
  stopDragging() {
    if (this.isDragging && this.audio && this.progressBar) {
      const rect = this.progressBar.getBoundingClientRect();
      const percentage = parseFloat(this.progressFill.style.width);
      const newTime = (percentage / 100) * this.audio.duration;
      this.audio.currentTime = newTime;
    }
    
    this.isDragging = false;
  }
  
  /**
   * Update volume
   */
  updateVolume(event) {
    if (!this.audio) return;
    
    const volume = event.target.value / 100;
    this.audio.volume = volume;
    
    // Update volume icon
    this.updateVolumeIcon(volume);
  }
  
  /**
   * Update volume icon based on level
   */
  updateVolumeIcon(volume) {
    if (!this.volumeIcon) return;
    
    if (volume === 0) {
      this.volumeIcon.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
          <line x1="23" y1="9" x2="17" y2="15"></line>
          <line x1="17" y1="9" x2="23" y2="15"></line>
        </svg>
      `;
    } else if (volume < 0.5) {
      this.volumeIcon.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      `;
    } else {
      this.volumeIcon.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        </svg>
      `;
    }
  }
  
  /**
   * Toggle mute
   */
  toggleMute() {
    if (!this.audio || !this.volumeSlider) return;
    
    if (this.audio.volume > 0) {
      this.previousVolume = this.audio.volume;
      this.audio.volume = 0;
      this.volumeSlider.value = 0;
    } else {
      this.audio.volume = this.previousVolume || 1;
      this.volumeSlider.value = this.audio.volume * 100;
    }
    
    this.updateVolumeIcon(this.audio.volume);
  }
  
  /**
   * Download audio file
   */
  downloadAudio() {
    if (!this.currentAttachment) {
      console.error('No attachment available');
      this.showError('No audio file loaded');
      return;
    }
    
    if (!this.currentAttachment.data) {
      console.error('No data in attachment:', this.currentAttachment);
      this.showError('No audio data available for download');
      return;
    }
    
    try {
      const mimeType = this.currentAttachment.mimeType || 'audio/mpeg';
      
      // Always use blob approach for better compatibility
      console.log('Creating blob for download...');
      const byteCharacters = atob(this.currentAttachment.data);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: mimeType });
      
      console.log('Blob created, size:', blob.size, 'type:', blob.type);
      
      // Create blob URL and download
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = this.currentAttachment.name || 'audio.mp3';
      link.style.display = 'none';
      document.body.appendChild(link);
      
      console.log('Triggering download for:', link.download);
      link.click();
      
      // Clean up
      setTimeout(() => {
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
        console.log('Download cleanup complete');
      }, 100);
      
    } catch (error) {
      console.error('Failed to download audio:', error);
      this.showError('Failed to download audio file: ' + error.message);
    }
  }
  
  /**
   * Handle keyboard shortcuts
   */
  handleKeyPress(event) {
    if (!this.modal || this.modal.style.display === 'none') return;
    
    switch(event.key) {
      case ' ':
      case 'Spacebar':
        event.preventDefault();
        this.togglePlayPause();
        break;
      case 'Escape':
        this.close();
        break;
      case 'ArrowLeft':
        if (this.audio) {
          this.audio.currentTime = Math.max(0, this.audio.currentTime - 5);
        }
        break;
      case 'ArrowRight':
        if (this.audio) {
          this.audio.currentTime = Math.min(this.audio.duration, this.audio.currentTime + 5);
        }
        break;
    }
  }
  
  /**
   * Format time in mm:ss
   */
  formatTime(seconds) {
    if (isNaN(seconds) || !isFinite(seconds)) return '0:00';
    
    const minutes = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  }
  
  /**
   * Show error message
   */
  showError(message) {
    // You can implement a toast notification here
    console.error(message);
    
    // Show error in the modal
    const errorEl = document.getElementById('audio-error-message');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.style.display = 'block';
      setTimeout(() => {
        errorEl.style.display = 'none';
      }, 3000);
    }
  }
  
  /**
   * Close the modal
   */
  close() {
    if (!this.modal) return;
    
    // Stop audio playback
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
      
      // Clean up blob URL if we created one
      if (this.isUsingBlobUrl && this.currentAudioUrl) {
        URL.revokeObjectURL(this.currentAudioUrl);
      }
      
      // Clear the audio source
      this.audio.src = '';
      this.currentAudioUrl = null;
      this.isUsingBlobUrl = false;
    }
    
    // Remove open class for animation
    this.modal.classList.remove('open');
    
    // Hide modal after animation
    setTimeout(() => {
      this.modal.style.display = 'none';
      this.currentAttachment = null;
      this.isPlaying = false;
      this.updatePlayPauseButton();
    }, 300);
  }
}

// Export singleton instance
export const audioPlayerModal = new AudioPlayerModal();