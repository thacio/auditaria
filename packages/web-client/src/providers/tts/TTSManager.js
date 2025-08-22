/**
 * TTS Manager - Singleton that manages TTS operations
 * Coordinates between TTS buttons and providers
 */

import { BrowserTTSProvider } from './BrowserTTSProvider.js';

class TTSManager {
  constructor() {
    if (TTSManager.instance) {
      return TTSManager.instance;
    }
    
    this.provider = null;
    this.currentButton = null;
    this.isInitialized = false;
    this.listeners = new Map();
    
    TTSManager.instance = this;
  }
  
  /**
   * Initialize the TTS manager with a provider
   */
  initialize() {
    if (this.isInitialized) return;
    
    // Default to browser TTS provider
    this.setProvider(new BrowserTTSProvider());
    this.isInitialized = true;
  }
  
  /**
   * Set the TTS provider
   * @param {TTSProvider} provider
   */
  setProvider(provider) {
    // Stop current provider if speaking
    if (this.provider && this.provider.isSpeaking()) {
      this.provider.stop();
    }
    
    this.provider = provider;
    console.log(`TTS Provider set to: ${provider.getName()}`);
  }
  
  /**
   * Get current provider
   */
  getProvider() {
    return this.provider;
  }
  
  /**
   * Check if TTS is supported
   */
  isSupported() {
    return this.provider && this.provider.isSupported();
  }
  
  /**
   * Speak text from a button
   * @param {string} text - Text to speak
   * @param {TTSButton} button - The button requesting speech
   * @param {Object} options - Speech options
   */
  async speak(text, button, options = {}) {
    if (!this.provider) {
      console.warn('No TTS provider available');
      return;
    }
    
    if (!this.provider.isSupported()) {
      console.warn('TTS is not supported in this browser');
      this.notifyButton(button, 'unsupported');
      return;
    }
    
    // Stop any current speech and notify previous button
    if (this.currentButton && this.currentButton !== button) {
      this.stop();
    }
    
    // Set current button
    this.currentButton = button;
    
    try {
      // Notify button that speech is starting
      this.notifyButton(button, 'start');
      
      // Start speaking
      await this.provider.speak(text, options);
      
      // Notify button that speech ended
      this.notifyButton(button, 'end');
      
      // Clear current button
      if (this.currentButton === button) {
        this.currentButton = null;
      }
    } catch (error) {
      console.error('TTS error:', error);
      this.notifyButton(button, 'error', error);
      
      if (this.currentButton === button) {
        this.currentButton = null;
      }
    }
  }
  
  /**
   * Stop current speech
   */
  stop() {
    if (this.provider) {
      this.provider.stop();
    }
    
    if (this.currentButton) {
      this.notifyButton(this.currentButton, 'stop');
      this.currentButton = null;
    }
  }
  
  /**
   * Pause current speech
   */
  pause() {
    if (this.provider) {
      this.provider.pause();
      if (this.currentButton) {
        this.notifyButton(this.currentButton, 'pause');
      }
    }
  }
  
  /**
   * Resume paused speech
   */
  resume() {
    if (this.provider) {
      this.provider.resume();
      if (this.currentButton) {
        this.notifyButton(this.currentButton, 'resume');
      }
    }
  }
  
  /**
   * Check if currently speaking
   */
  isSpeaking() {
    return this.provider ? this.provider.isSpeaking() : false;
  }
  
  /**
   * Get available voices
   */
  getVoices() {
    return this.provider ? this.provider.getVoices() : [];
  }
  
  /**
   * Set voice
   */
  setVoice(voice) {
    if (this.provider) {
      this.provider.setVoice(voice);
    }
  }
  
  /**
   * Register a button for notifications
   */
  registerButton(button) {
    if (!this.listeners.has(button)) {
      this.listeners.set(button, true);
    }
  }
  
  /**
   * Unregister a button
   */
  unregisterButton(button) {
    this.listeners.delete(button);
    if (this.currentButton === button) {
      this.stop();
    }
  }
  
  /**
   * Notify a button of TTS events
   */
  notifyButton(button, event, data = null) {
    if (button && typeof button.onTTSEvent === 'function') {
      button.onTTSEvent(event, data);
    }
  }
  
  /**
   * Get provider settings
   */
  getSettings() {
    if (this.provider && typeof this.provider.getSettings === 'function') {
      return this.provider.getSettings();
    }
    return {
      isSupported: false,
      isSpeaking: false,
      voices: []
    };
  }
  
  /**
   * Update provider settings
   */
  updateSettings(settings) {
    if (!this.provider) return;
    
    if (settings.rate !== undefined && typeof this.provider.setRate === 'function') {
      this.provider.setRate(settings.rate);
    }
    
    if (settings.pitch !== undefined && typeof this.provider.setPitch === 'function') {
      this.provider.setPitch(settings.pitch);
    }
    
    if (settings.volume !== undefined && typeof this.provider.setVolume === 'function') {
      this.provider.setVolume(settings.volume);
    }
    
    if (settings.voice !== undefined) {
      this.provider.setVoice(settings.voice);
    }
  }
}

// Export singleton instance
export const ttsManager = new TTSManager();