/**
 * TTS Button Component
 * Provides play/stop button for text-to-speech on messages
 */

import { ttsManager } from '../providers/tts/TTSManager.js';

export class TTSButton {
  constructor(text, messageId) {
    this.text = text;
    this.messageId = messageId;
    this.isPlaying = false;
    this.button = null;
    this.boundClickHandler = this.handleClick.bind(this);
    
    // Register with TTSManager
    ttsManager.registerButton(this);
  }
  
  /**
   * Update the text content for TTS
   */
  updateText(newText) {
    this.text = newText;
    // If currently playing, stop and restart with new text
    if (this.isPlaying) {
      this.stop();
    }
  }
  
  /**
   * Create the button element
   */
  createElement() {
    const container = document.createElement('div');
    container.className = 'tts-button-container';
    
    // Store reference to this TTSButton instance on the container
    container.ttsButtonInstance = this;
    
    this.button = document.createElement('button');
    this.button.className = 'tts-button';
    this.button.title = 'Read aloud';
    this.button.setAttribute('aria-label', 'Read message aloud');
    this.button.addEventListener('click', this.boundClickHandler);
    
    this.updateButtonState();
    
    container.appendChild(this.button);
    return container;
  }
  
  /**
   * Update button visual state
   */
  updateButtonState() {
    if (!this.button) return;
    
    if (this.isPlaying) {
      // Stop icon
      this.button.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="2"></rect>
        </svg>
      `;
      this.button.title = 'Stop reading';
      this.button.classList.add('playing');
    } else {
      // Speaker icon
      this.button.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4V5z"></path>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
      `;
      this.button.title = 'Read aloud';
      this.button.classList.remove('playing');
    }
  }
  
  /**
   * Handle button click
   */
  handleClick(event) {
    event.preventDefault();
    event.stopPropagation();
    
    if (this.isPlaying) {
      this.stop();
    } else {
      this.play();
    }
  }
  
  /**
   * Start playing TTS
   */
  play() {
    if (!this.text || this.isPlaying) return;
    
    // Check if TTS is supported
    if (!ttsManager.isSupported()) {
      this.showUnsupportedMessage();
      return;
    }
    
    this.isPlaying = true;
    this.updateButtonState();
    
    // Start speaking through manager
    ttsManager.speak(this.text, this);
  }
  
  /**
   * Stop playing TTS
   */
  stop() {
    if (!this.isPlaying) return;
    
    this.isPlaying = false;
    this.updateButtonState();
    
    // Stop through manager (will stop if this is the current button)
    ttsManager.stop();
  }
  
  /**
   * Handle TTS events from manager
   */
  onTTSEvent(event, data) {
    switch (event) {
      case 'start':
        this.isPlaying = true;
        this.updateButtonState();
        break;
        
      case 'end':
      case 'stop':
        this.isPlaying = false;
        this.updateButtonState();
        break;
        
      case 'pause':
        // Could add paused state visualization
        break;
        
      case 'resume':
        // Could add resumed state visualization
        break;
        
      case 'error':
        this.isPlaying = false;
        this.updateButtonState();
        console.error('TTS error:', data);
        break;
        
      case 'unsupported':
        this.isPlaying = false;
        this.updateButtonState();
        this.showUnsupportedMessage();
        break;
    }
  }
  
  /**
   * Show unsupported message
   */
  showUnsupportedMessage() {
    if (this.button) {
      const originalTitle = this.button.title;
      this.button.title = 'Text-to-speech is not supported in your browser';
      this.button.disabled = true;
      
      setTimeout(() => {
        this.button.title = originalTitle;
        this.button.disabled = false;
      }, 3000);
    }
  }
  
  /**
   * Cleanup when button is removed
   */
  destroy() {
    if (this.button) {
      this.button.removeEventListener('click', this.boundClickHandler);
    }
    
    // Unregister from manager
    ttsManager.unregisterButton(this);
    
    // Stop if playing
    if (this.isPlaying) {
      this.stop();
    }
  }
}

/**
 * Create TTS button for a message
 * @param {string} text - Message text
 * @param {string} messageId - Unique message identifier
 * @returns {HTMLElement} TTS button container
 */
export function createTTSButton(text, messageId) {
  const ttsButton = new TTSButton(text, messageId);
  return ttsButton.createElement();
}