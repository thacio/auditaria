/**
 * Abstract base class for TTS providers
 * Defines the interface that all TTS providers must implement
 */

import { convertHtmlToFormattedText } from '../../utils/markdown.js';

export class TTSProvider {
  constructor() {
    if (this.constructor === TTSProvider) {
      throw new Error('TTSProvider is an abstract class and cannot be instantiated directly');
    }
    
    this.currentUtterance = null;
    this.isPaused = false;
  }
  
  /**
   * Check if this provider is supported in the current environment
   * @returns {boolean}
   */
  isSupported() {
    throw new Error('isSupported() must be implemented by subclass');
  }
  
  /**
   * Start speaking the given text
   * @param {string} text - The text to speak
   * @param {Object} options - Speaking options (rate, pitch, volume, voice, etc.)
   * @returns {Promise<void>}
   */
  async speak(text, options = {}) {
    throw new Error('speak() must be implemented by subclass');
  }
  
  /**
   * Stop the current speech
   * @returns {void}
   */
  stop() {
    throw new Error('stop() must be implemented by subclass');
  }
  
  /**
   * Pause the current speech
   * @returns {void}
   */
  pause() {
    throw new Error('pause() must be implemented by subclass');
  }
  
  /**
   * Resume the paused speech
   * @returns {void}
   */
  resume() {
    throw new Error('resume() must be implemented by subclass');
  }
  
  /**
   * Get available voices
   * @returns {Array} Array of available voices
   */
  getVoices() {
    throw new Error('getVoices() must be implemented by subclass');
  }
  
  /**
   * Set the voice to use
   * @param {Object} voice - The voice object
   * @returns {void}
   */
  setVoice(voice) {
    throw new Error('setVoice() must be implemented by subclass');
  }
  
  /**
   * Check if currently speaking
   * @returns {boolean}
   */
  isSpeaking() {
    throw new Error('isSpeaking() must be implemented by subclass');
  }
  
  /**
   * Get the current provider name
   * @returns {string}
   */
  getName() {
    return this.constructor.name;
  }
  
  /**
   * Clean the text before speaking (remove markdown, code blocks, etc.)
   * @param {string} text - Raw text or HTML
   * @returns {string} Cleaned text
   */
  cleanText(text) {
    if (!text) return '';
    
    // Check if the text contains HTML tags
    if (/<[^>]*>/.test(text)) {
      // If it contains HTML, use the existing convertHtmlToFormattedText function
      // This is the same function used by the "Copy as Text" button
      text = convertHtmlToFormattedText(text);
    }

        // Remove code blocks
    text = text.replace(/```[\s\S]*?```/g, ' code block ');
    text = text.replace(/`[^`]+`/g, (match) => match.slice(1, -1));
    
    // Remove markdown formatting
    text = text.replace(/#{1,6}\s+/g, ''); // Headers
    text = text.replace(/\*\*([^*]+)\*\*/g, '$1'); // Bold
    text = text.replace(/\*([^*]+)\*/g, '$1'); // Italic
    text = text.replace(/__([^_]+)__/g, '$1'); // Bold
    text = text.replace(/_([^_]+)_/g, '$1'); // Italic
    text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // Links
    text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1'); // Images
    
    // Remove HTML tags
    text = text.replace(/<[^>]*>/g, '');
    
    // Replace multiple spaces/newlines with single space
    text = text.replace(/\s+/g, ' ');
    
    // Additional cleanup for TTS
    text = text.replace(/\*/g, ''); // Remove asterisks
    text = text.replace(/\n{3,}/g, '\n\n'); // Limit to max 2 newlines
    text = text.replace(/\s+/g, ' '); // Replace multiple spaces with single space
    text = text.trim();
    
    return text;
  }
  
  /**
   * Split long text into chunks for better TTS handling
   * @param {string} text - Text to split
   * @param {number} maxLength - Maximum chunk length
   * @returns {Array<string>} Array of text chunks
   */
  splitText(text, maxLength = 200) {
    if (text.length <= maxLength) return [text];
    
    const chunks = [];
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length > maxLength && currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = sentence;
      } else {
        currentChunk += sentence;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks;
  }
}