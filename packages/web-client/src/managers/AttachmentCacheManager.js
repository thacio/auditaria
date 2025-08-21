/**
 * AttachmentCacheManager - Caches AUDIO attachment data locally
 * Solves the issue where server strips base64 data from audio attachments
 */

export class AttachmentCacheManager {
  constructor() {
    // Use Map for efficient lookups
    this.cache = new Map();
    // Set a max cache size to prevent memory issues
    this.maxCacheSize = 30; // Maximum number of audio files to cache
  }
  
  /**
   * Check if attachment is an audio file
   */
  isAudioAttachment(attachment) {
    // Check multiple indicators that this is audio
    return (
      attachment.type === 'audio' ||
      (attachment.mimeType && attachment.mimeType.startsWith('audio/')) ||
      attachment.icon === '🎙️' || 
      attachment.icon === '🎵' ||
      (attachment.name && /\.(mp3|wav|m4a|webm|ogg|aac|flac|opus)$/i.test(attachment.name))
    );
  }
  
  /**
   * Generate a unique key for an attachment
   */
  generateKey(attachment) {
    // Use combination of name, size, and mimeType for uniqueness
    return `${attachment.name}_${attachment.size}_${attachment.mimeType || 'unknown'}`;
  }
  
  /**
   * Store audio attachments in cache (ignores non-audio files)
   */
  cacheAttachments(attachments) {
    if (!attachments || !Array.isArray(attachments)) return;
    
    attachments.forEach(attachment => {
      // Only cache audio files with data
      if (attachment.data && this.isAudioAttachment(attachment)) {
        const key = this.generateKey(attachment);
        console.log(`[AudioCache] Caching audio file: ${attachment.name} (${this.cache.size + 1}/${this.maxCacheSize})`);
        
        // Store the audio data
        this.cache.set(key, {
          data: attachment.data,
          thumbnail: attachment.thumbnail,
          cachedAt: Date.now()
        });
        
        // Enforce cache size limit (remove oldest entry)
        if (this.cache.size > this.maxCacheSize) {
          // Maps preserve insertion order, so the first key is the oldest
          const oldestKey = this.cache.keys().next().value;
          this.cache.delete(oldestKey);
          console.log(`[AudioCache] Cache limit reached, removed oldest: ${oldestKey}`);
        }
      }
    });
  }
  
  /**
   * Rehydrate audio attachments with cached data
   */
  rehydrateAttachments(attachments) {
    if (!attachments || !Array.isArray(attachments)) return attachments;
    
    return attachments.map(attachment => {
      // Only process audio files
      if (!this.isAudioAttachment(attachment)) {
        return attachment;
      }
      
      // If data already exists, no need to rehydrate
      if (attachment.data) return attachment;
      
      const key = this.generateKey(attachment);
      const cached = this.cache.get(key);
      
      if (cached) {
        console.log(`[AudioCache] Rehydrating audio: ${attachment.name}`);
        
        // Merge cached data back into attachment
        return {
          ...attachment,
          data: cached.data,
          thumbnail: cached.thumbnail
        };
      }
      
      // No cached data available for this audio file
      console.warn(`[AudioCache] No cached data for audio: ${attachment.name}`);
      return attachment;
    });
  }
  
  /**
   * Clear cache for specific audio attachments
   */
  clearAttachments(attachments) {
    if (!attachments || !Array.isArray(attachments)) return;
    
    attachments.forEach(attachment => {
      // Only process audio files
      if (!this.isAudioAttachment(attachment)) return;
      
      const key = this.generateKey(attachment);
      if (this.cache.delete(key)) {
        console.log(`[AudioCache] Cleared cache for: ${attachment.name}`);
      }
    });
  }
  
  /**
   * Clear entire audio cache
   */
  clearAll() {
    const size = this.cache.size;
    this.cache.clear();
    console.log(`[AudioCache] Cleared ${size} cached audio files`);
  }
  
  /**
   * Get audio cache statistics
   */
  getStats() {
    let totalSize = 0;
    let oldestTime = Infinity;
    let newestTime = 0;
    
    this.cache.forEach(item => {
      if (item.data) {
        totalSize += item.data.length;
      }
      if (item.cachedAt < oldestTime) oldestTime = item.cachedAt;
      if (item.cachedAt > newestTime) newestTime = item.cachedAt;
    });
    
    return {
      count: this.cache.size,
      maxCount: this.maxCacheSize,
      approximateSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      oldestCacheAge: oldestTime < Infinity ? Math.round((Date.now() - oldestTime) / 1000 / 60) + ' minutes' : 'N/A',
      newestCacheAge: newestTime > 0 ? Math.round((Date.now() - newestTime) / 1000 / 60) + ' minutes' : 'N/A'
    };
  }
}

// Export singleton instance
export const attachmentCacheManager = new AttachmentCacheManager();

// Expose to window for debugging (can check cache status in console)
if (typeof window !== 'undefined') {
  window.audioCache = {
    stats: () => attachmentCacheManager.getStats(),
    clear: () => attachmentCacheManager.clearAll(),
    size: () => attachmentCacheManager.cache.size
  };
}