/**
 * Browser TTS Provider using Web Speech Synthesis API
 */

import { TTSProvider } from './TTSProvider.js';

export class BrowserTTSProvider extends TTSProvider {
  constructor() {
    super();
    this.synthesis = null;
    this.currentVoice = null;
    this.voices = [];
    this.rate = 1.0;
    this.pitch = 1.0;
    this.volume = 1.0;
    
    // Initialize if supported
    if (this.isSupported()) {
      this.synthesis = window.speechSynthesis;
      this.loadVoices();
      
      // Some browsers load voices asynchronously
      if (this.synthesis.onvoiceschanged !== undefined) {
        this.synthesis.onvoiceschanged = () => this.loadVoices();
      }
    }
  }
  
  /**
   * Load available voices
   */
  loadVoices() {
    this.voices = this.synthesis.getVoices();
    
    // Try to select a good default voice
    if (this.voices.length > 0 && !this.currentVoice) {
      // Prefer local voices over remote for better performance
      const localVoices = this.voices.filter(v => v.localService);
      
      // Try to find an English voice
      const englishVoice = (localVoices.length > 0 ? localVoices : this.voices)
        .find(v => v.lang.startsWith('en'));
      
      this.currentVoice = englishVoice || this.voices[0];
    }
  }
  
  /**
   * Check if browser supports Speech Synthesis
   */
  isSupported() {
    return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  }
  
  /**
   * Speak the given text
   */
  async speak(text, options = {}) {
    if (!this.isSupported()) {
      console.warn('Speech synthesis is not supported in this browser');
      return;
    }
    
    // Stop any current speech
    this.stop();
    
    // Clean the text
    const cleanedText = this.cleanText(text);
    if (!cleanedText) return;
    
    // Create utterance
    const utterance = new SpeechSynthesisUtterance(cleanedText);
    
    // Set voice
    if (options.voice) {
      utterance.voice = options.voice;
    } else if (this.currentVoice) {
      utterance.voice = this.currentVoice;
    }
    
    // Set speech parameters
    utterance.rate = options.rate || this.rate;
    utterance.pitch = options.pitch || this.pitch;
    utterance.volume = options.volume || this.volume;
    utterance.lang = options.lang || 'en-US';
    
    // Store current utterance
    this.currentUtterance = utterance;
    this.isPaused = false;
    
    // Return a promise that resolves when speech ends
    return new Promise((resolve, reject) => {
      utterance.onend = () => {
        this.currentUtterance = null;
        resolve();
      };
      
      utterance.onerror = (event) => {
        this.currentUtterance = null;
        console.error('Speech synthesis error:', event);
        reject(event);
      };
      
      // Start speaking
      this.synthesis.speak(utterance);
    });
  }
  
  /**
   * Stop current speech
   */
  stop() {
    if (this.synthesis && this.synthesis.speaking) {
      this.synthesis.cancel();
      this.currentUtterance = null;
      this.isPaused = false;
    }
  }
  
  /**
   * Pause current speech
   */
  pause() {
    if (this.synthesis && this.synthesis.speaking && !this.synthesis.paused) {
      this.synthesis.pause();
      this.isPaused = true;
    }
  }
  
  /**
   * Resume paused speech
   */
  resume() {
    if (this.synthesis && this.synthesis.paused) {
      this.synthesis.resume();
      this.isPaused = false;
    }
  }
  
  /**
   * Get available voices
   */
  getVoices() {
    return this.voices;
  }
  
  /**
   * Set the voice to use
   */
  setVoice(voice) {
    if (voice && this.voices.includes(voice)) {
      this.currentVoice = voice;
    }
  }
  
  /**
   * Check if currently speaking
   */
  isSpeaking() {
    return this.synthesis ? this.synthesis.speaking && !this.synthesis.paused : false;
  }
  
  /**
   * Set speech rate (0.1 to 10)
   */
  setRate(rate) {
    this.rate = Math.max(0.1, Math.min(10, rate));
  }
  
  /**
   * Set speech pitch (0 to 2)
   */
  setPitch(pitch) {
    this.pitch = Math.max(0, Math.min(2, pitch));
  }
  
  /**
   * Set speech volume (0 to 1)
   */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
  }
  
  /**
   * Get current speech settings
   */
  getSettings() {
    return {
      voice: this.currentVoice,
      rate: this.rate,
      pitch: this.pitch,
      volume: this.volume,
      voices: this.voices,
      isSupported: this.isSupported(),
      isSpeaking: this.isSpeaking(),
      isPaused: this.isPaused
    };
  }
}