/**
 * File handling utilities for web interface
 * Supports images, PDFs, audio, and other file types
 */

export class FileHandler {
  // Gemini 2.5 supported file types and limits
  static SUPPORTED_TYPES = {
    // Images - Max 7MB per image, max 3000 images per prompt
    'image/png': { category: 'image', maxSize: 7 * 1024 * 1024, maxCount: 3000 },
    'image/jpeg': { category: 'image', maxSize: 7 * 1024 * 1024, maxCount: 3000 },
    'image/webp': { category: 'image', maxSize: 7 * 1024 * 1024, maxCount: 3000 },
    
    // Documents - Max 50MB per file, max 3000 files per prompt
    'application/pdf': { category: 'document', maxSize: 50 * 1024 * 1024, maxCount: 3000 },
    'text/plain': { category: 'document', maxSize: 50 * 1024 * 1024, maxCount: 3000 },
    
    // Video - Max 10 videos per prompt
    'video/x-flv': { category: 'video', maxSize: null, maxCount: 10 },
    'video/quicktime': { category: 'video', maxSize: null, maxCount: 10 },
    'video/mpeg': { category: 'video', maxSize: null, maxCount: 10 },
    'video/mpegs': { category: 'video', maxSize: null, maxCount: 10 },
    'video/mpg': { category: 'video', maxSize: null, maxCount: 10 },
    'video/mp4': { category: 'video', maxSize: null, maxCount: 10 },
    'video/webm': { category: 'video', maxSize: null, maxCount: 10 },
    'video/wmv': { category: 'video', maxSize: null, maxCount: 10 },
    'video/3gpp': { category: 'video', maxSize: null, maxCount: 10 },
    
    // Audio - Max 1 audio file per prompt
    'audio/x-aac': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/aac': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/flac': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/mp3': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/m4a': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/x-m4a': { category: 'audio', maxSize: null, maxCount: 1 }, // Common browser variation
    'audio/mpeg': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/mpga': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/mp4': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/opus': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/pcm': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/wav': { category: 'audio', maxSize: null, maxCount: 1 },
    'audio/webm': { category: 'audio', maxSize: null, maxCount: 1 },
  };
  
  // Default max file size for unsupported types (we'll reject them anyway)
  static MAX_FILE_SIZE = 50 * 1024 * 1024;
  
  /**
   * Get file extension from filename
   */
  static getFileExtension(filename) {
    return filename.toLowerCase().split('.').pop() || '';
  }

  /**
   * Get file type by extension as fallback
   */
  static getTypeByExtension(extension) {
    const extensionMap = {
      // Images
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'webp': 'image/webp',
      
      // Documents
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      
      // Audio
      'm4a': 'audio/m4a',
      'mp3': 'audio/mp3',
      'wav': 'audio/wav',
      'flac': 'audio/flac',
      'aac': 'audio/aac',
      'opus': 'audio/opus',
      
      // Video
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mov': 'video/quicktime',
      'avi': 'video/x-msvideo',
      '3gp': 'video/3gpp',
    };
    return extensionMap[extension];
  }

  /**
   * Validate file size and type
   */
  static validateFile(file, currentAttachments = []) {
    // Check if file type is supported by Gemini
    let fileType = this.SUPPORTED_TYPES[file.type];
    let mimeType = file.type;
    
    if (!fileType) {
      // Try to determine type by file extension as fallback
      const extension = this.getFileExtension(file.name);
      const fallbackMimeType = this.getTypeByExtension(extension);
      
      if (fallbackMimeType) {
        fileType = this.SUPPORTED_TYPES[fallbackMimeType];
        mimeType = fallbackMimeType;
      }
    }
    
    if (!fileType) {
      // Unsupported file type
      const supportedCategories = ['image (PNG, JPEG, WebP)', 'PDF', 'text', 'video', 'audio'];
      throw new Error(`Unsupported file type: ${file.type || 'unknown'}. Supported: ${supportedCategories.join(', ')}`);
    }
    
    // Check 20MB inline limit for all files
    const inlineLimit = 20 * 1024 * 1024;
    if (file.size > inlineLimit) {
      throw new Error(`File size exceeds 20MB inline limit. File is ${(file.size / (1024 * 1024)).toFixed(1)}MB`);
    }
    
    // Check category-specific file size limits
    if (fileType.maxSize && file.size > fileType.maxSize) {
      const maxSizeMB = fileType.maxSize / (1024 * 1024);
      throw new Error(`File size exceeds ${maxSizeMB}MB limit for ${fileType.category} files`);
    }
    
    // Count existing files of the same category
    const categoryCount = currentAttachments.filter(att => {
      const attType = this.SUPPORTED_TYPES[att.mimeType];
      return attType && attType.category === fileType.category;
    }).length;
    
    // Check category-specific limits
    if (categoryCount >= fileType.maxCount) {
      if (fileType.category === 'audio') {
        throw new Error('Only 1 audio file allowed per prompt');
      } else if (fileType.category === 'video') {
        throw new Error('Maximum 10 video files allowed per prompt');
      } else {
        throw new Error(`Maximum ${fileType.maxCount} ${fileType.category} files allowed per prompt`);
      }
    }
    
    return { valid: true, category: fileType.category, mimeType };
  }
  
  /**
   * Convert file to base64
   */
  static async fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Remove data URL prefix to get pure base64
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  
  /**
   * Generate thumbnail for images
   */
  static async generateImageThumbnail(file, maxSize = 100) {
    if (!file.type.startsWith('image/')) {
      return null;
    }
    
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          
          // Calculate thumbnail dimensions
          let width = img.width;
          let height = img.height;
          
          if (width > height) {
            if (width > maxSize) {
              height = (height * maxSize) / width;
              width = maxSize;
            }
          } else {
            if (height > maxSize) {
              width = (width * maxSize) / height;
              height = maxSize;
            }
          }
          
          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);
          
          // Convert to base64
          resolve(canvas.toDataURL(file.type));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }
  
  /**
   * Get file icon based on type
   */
  static getFileIcon(mimeType) {
    const typeInfo = this.SUPPORTED_TYPES[mimeType];
    const category = typeInfo?.category || 'document';
    
    const icons = {
      image: '🖼️',
      document: '📄',
      pdf: '📑',
      audio: '🎵',
      video: '🎬',
      unknown: '📎'
    };
    
    if (mimeType === 'application/pdf') return icons.pdf;
    return icons[category] || icons.unknown;
  }
  
  /**
   * Format file size for display
   */
  static formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
  
  /**
   * Create attachment object from file
   */
  static async createAttachment(file, currentAttachments = []) {
    const validation = this.validateFile(file, currentAttachments);
    if (!validation.valid) {
      throw new Error(validation.error || 'Invalid file');
    }
    
    const base64 = await this.fileToBase64(file);
    const thumbnail = await this.generateImageThumbnail(file);
    
    return {
      type: validation.category,
      mimeType: validation.mimeType || file.type || 'application/octet-stream',
      data: base64,
      name: file.name,
      size: file.size,
      thumbnail: thumbnail,
      icon: this.getFileIcon(validation.mimeType || file.type),
      displaySize: this.formatFileSize(file.size)
    };
  }
  
  /**
   * Extract files from paste event
   */
  static getFilesFromPasteEvent(event) {
    const items = event.clipboardData?.items || [];
    const files = [];
    
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }
    
    return files;
  }
  
  /**
   * Check if browser supports required APIs
   */
  static checkBrowserSupport() {
    const support = {
      fileReader: typeof FileReader !== 'undefined',
      canvas: typeof HTMLCanvasElement !== 'undefined',
      clipboard: typeof ClipboardEvent !== 'undefined'
    };
    
    support.allFeatures = support.fileReader && support.canvas && support.clipboard;
    return support;
  }
}