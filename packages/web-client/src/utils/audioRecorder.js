/**
 * Audio recording utilities for voice messages
 */

export class AudioRecorder {
  constructor() {
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.startTime = null;
    this.timerInterval = null;
    this.stream = null;
    this.isRecording = false;
    this.detectedMimeType = null;
    
    // Callbacks
    this.onDataAvailable = null;
    this.onStop = null;
    this.onError = null;
    this.onTimeUpdate = null;
  }
  
  /**
   * Check if browser supports audio recording
   */
  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  }
  
  /**
   * Request microphone permission and initialize recorder
   */
  async initialize() {
    if (!AudioRecorder.isSupported()) {
      throw new Error('Audio recording is not supported in this browser');
    }
    
    try {
      // Request microphone access
      this.stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        } 
      });
      
      // Determine the best supported MIME type
      const mimeType = this.getBestMimeType();
      this.detectedMimeType = mimeType || 'audio/webm'; // Store for later use
      
      // Create MediaRecorder instance
      const recorderOptions = {
        audioBitsPerSecond: 128000
      };
      
      // Only set mimeType if we found a supported one
      if (mimeType) {
        recorderOptions.mimeType = mimeType;
      }
      
      this.mediaRecorder = new MediaRecorder(this.stream, recorderOptions);
      
      // Set up event handlers
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
          if (this.onDataAvailable) {
            this.onDataAvailable(event.data);
          }
        }
      };
      
      this.mediaRecorder.onstop = () => {
        this.handleStop();
      };
      
      this.mediaRecorder.onerror = (error) => {
        console.error('MediaRecorder error:', error);
        if (this.onError) {
          this.onError(error);
        }
      };
      
      return true;
    } catch (error) {
      console.error('Failed to initialize audio recorder:', error);
      throw error;
    }
  }
  
  /**
   * Get the best supported MIME type for recording
   */
  getBestMimeType() {
    // Prioritize standard audio formats over WebM
    const types = [
      // Try MP4/AAC first (best compatibility)
      'audio/mp4',
      'audio/mp4;codecs=mp4a.40.2', // AAC-LC
      'audio/aac',
      'audio/mpeg', // MP3
      
      // Then try Ogg (good for audio-only)
      'audio/ogg;codecs=opus',
      'audio/ogg;codecs=vorbis',
      'audio/ogg',
      
      // WAV (large but universal)
      'audio/wav',
      
      // WebM as last resort (it's really a video container)
      'audio/webm;codecs=opus',
      'audio/webm',
    ];
    
    console.log('Testing audio formats...');
    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        console.log(`Using audio format: ${type}`);
        return type;
      }
    }
    
    // Fallback to default (browser will choose)
    console.log('Using browser default audio format');
    return '';
  }
  
  /**
   * Start recording audio
   */
  async start() {
    if (this.isRecording) {
      console.warn('Already recording');
      return false;
    }
    
    // Initialize if not already done
    if (!this.mediaRecorder) {
      await this.initialize();
    }
    
    // Reset state
    this.audioChunks = [];
    this.startTime = Date.now();
    this.isRecording = true;
    
    // Start recording
    this.mediaRecorder.start(1000); // Collect data every second
    
    // Start timer
    this.startTimer();
    
    return true;
  }
  
  /**
   * Stop recording audio
   */
  stop() {
    if (!this.isRecording || !this.mediaRecorder) {
      console.warn('Not recording');
      return false;
    }
    
    this.isRecording = false;
    this.stopTimer();
    
    // Stop recording
    if (this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    
    // Stop all tracks to release microphone
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    return true;
  }
  
  /**
   * Handle recording stop and create blob
   */
  handleStop() {
    if (this.audioChunks.length === 0) {
      console.warn('No audio data recorded');
      return;
    }
    
    // Get the actual MIME type used by the recorder
    const actualMimeType = this.mediaRecorder.mimeType || this.detectedMimeType || 'audio/webm';
    console.log(`Final audio MIME type: ${actualMimeType}`);
    
    // Create blob from chunks
    const audioBlob = new Blob(this.audioChunks, { type: actualMimeType });
    
    // Calculate duration
    const duration = this.startTime ? Date.now() - this.startTime : 0;
    
    // Create file object with appropriate extension
    const extension = this.getFileExtension(actualMimeType);
    const fileName = `Recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    
    const audioFile = new File([audioBlob], fileName, { 
      type: actualMimeType,
      lastModified: Date.now()
    });
    
    console.log(`Created audio file: ${fileName} (${actualMimeType}, ${audioFile.size} bytes)`);
    
    // Call callback with audio file
    if (this.onStop) {
      this.onStop(audioFile, duration);
    }
    
    // Reset
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.detectedMimeType = null;
  }
  
  /**
   * Get file extension from MIME type
   */
  getFileExtension(mimeType) {
    const extensions = {
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/webm': 'webm',
      'audio/3gpp': '3gp',
      'audio/3gpp2': '3g2',
      'audio/x-m4a': 'm4a',
      'audio/x-aac': 'aac'
    };
    
    const baseType = mimeType.split(';')[0].toLowerCase();
    const extension = extensions[baseType] || 'audio';
    
    console.log(`Audio format ${mimeType} -> .${extension}`);
    return extension;
  }
  
  /**
   * Start timer for recording duration
   */
  startTimer() {
    this.timerInterval = setInterval(() => {
      if (this.startTime && this.onTimeUpdate) {
        const elapsed = Date.now() - this.startTime;
        this.onTimeUpdate(this.formatTime(elapsed));
      }
    }, 100);
  }
  
  /**
   * Stop timer
   */
  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }
  
  /**
   * Format time in mm:ss format
   */
  formatTime(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }
  
  /**
   * Clean up resources
   */
  cleanup() {
    this.stop();
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.startTime = null;
    this.onDataAvailable = null;
    this.onStop = null;
    this.onError = null;
    this.onTimeUpdate = null;
  }
  
  /**
   * Get current recording state
   */
  getState() {
    return {
      isRecording: this.isRecording,
      isSupported: AudioRecorder.isSupported(),
      hasPermission: !!this.stream,
      duration: this.startTime ? Date.now() - this.startTime : 0
    };
  }
}