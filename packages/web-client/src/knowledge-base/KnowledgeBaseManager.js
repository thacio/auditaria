/**
 * Knowledge Base Manager
 *
 * Manages state and WebSocket communication for the Knowledge Base
 * search and management feature.
 */

import { KnowledgeBaseModal } from './KnowledgeBaseModal.js';

export class KnowledgeBaseManager {
  constructor(wsManager) {
    this.wsManager = wsManager;
    this.modal = new KnowledgeBaseModal(this);

    // State
    this.status = {
      initialized: false,
      running: false,
      autoIndex: false,
      lastSync: null,
      stats: null,
      indexingProgress: null
    };

    this.searchState = {
      query: '',
      type: 'hybrid',
      filters: {},
      page: 1,
      limit: 25,
      results: [],
      total: 0,
      totalPages: 0,
      loading: false,
      error: null,
      // Diversity options
      diversityStrategy: 'score_penalty', // 'none' | 'score_penalty' | 'cap_then_fill'
      diversityDecay: 0.85,
      maxPerDocument: 5,
      semanticDedup: true,
      semanticDedupThreshold: 0.97
    };

    // Callbacks
    this.onOpenFile = null;

    // Setup WebSocket listeners
    this.setupWebSocketListeners();
  }

  /**
   * Setup WebSocket message listeners
   */
  setupWebSocketListeners() {
    // Status response
    this.wsManager.addEventListener('knowledge_base_status', (event) => {
      this.handleStatusResponse(event.detail);
    });

    // Init response
    this.wsManager.addEventListener('knowledge_base_init_response', (event) => {
      this.handleInitResponse(event.detail);
    });

    // Resume response
    this.wsManager.addEventListener('knowledge_base_resume_response', (event) => {
      this.handleResumeResponse(event.detail);
    });

    // Reindex progress
    this.wsManager.addEventListener('knowledge_base_reindex_progress', (event) => {
      this.handleReindexProgress(event.detail);
    });

    // Search response
    this.wsManager.addEventListener('knowledge_base_search_response', (event) => {
      this.handleSearchResponse(event.detail);
    });

    // Auto-index response
    this.wsManager.addEventListener('knowledge_base_autoindex_response', (event) => {
      this.handleAutoIndexResponse(event.detail);
    });
  }

  /**
   * Open the modal
   */
  openModal() {
    this.modal.show();
  }

  /**
   * Close the modal
   */
  closeModal() {
    this.modal.hide();
  }

  /**
   * Request current status from backend
   */
  requestStatus() {
    this.wsManager.send({
      type: 'knowledge_base_status_request'
    });
  }

  /**
   * Handle status response
   */
  handleStatusResponse(data) {
    this.status = {
      initialized: data.initialized || false,
      running: data.running || false,
      autoIndex: data.autoIndex || false,
      lastSync: data.lastSync || null,
      stats: data.stats || null,
      indexingProgress: data.indexingProgress || null
    };

    this.modal.updateStatus(this.status);

    // Update progress if indexing
    if (this.status.indexingProgress) {
      this.modal.updateProgress(this.status.indexingProgress);
    }
  }

  /**
   * Initialize the knowledge base
   */
  initialize() {
    this.wsManager.send({
      type: 'knowledge_base_init_request'
    });

    // Update status to show starting
    this.status.indexingProgress = {
      status: 'starting',
      totalFiles: 0,
      processedFiles: 0,
      currentFile: null
    };
    this.modal.updateStatus(this.status);
    this.modal.updateProgress(this.status.indexingProgress);
  }

  /**
   * Handle init response
   */
  handleInitResponse(data) {
    if (data.success) {
      this.status.initialized = true;
      this.status.running = true;
    } else {
      // Show error
      console.error('Knowledge base initialization failed:', data.error);
    }

    this.modal.updateStatus(this.status);
  }

  /**
   * Resume indexing - continue indexing pending files
   */
  resumeIndexing() {
    this.wsManager.send({
      type: 'knowledge_base_resume_request'
    });

    // Update status to show starting
    this.status.indexingProgress = {
      status: 'starting',
      totalFiles: 0,
      processedFiles: 0,
      currentFile: null
    };
    this.modal.updateStatus(this.status);
    this.modal.updateProgress(this.status.indexingProgress);
  }

  /**
   * Handle resume response
   */
  handleResumeResponse(data) {
    if (data.success) {
      this.status.running = true;
    } else {
      console.error('Knowledge base resume failed:', data.error);
    }
    this.modal.updateStatus(this.status);
  }

  /**
   * Trigger a full reindex
   */
  triggerReindex() {
    this.wsManager.send({
      type: 'knowledge_base_reindex_request',
      force: true
    });

    // Update status to show starting
    this.status.indexingProgress = {
      status: 'syncing',
      totalFiles: 0,
      processedFiles: 0,
      currentFile: null
    };
    this.modal.updateStatus(this.status);
    this.modal.updateProgress(this.status.indexingProgress);
  }

  /**
   * Handle reindex progress
   */
  handleReindexProgress(data) {
    this.status.indexingProgress = {
      status: data.status,
      totalFiles: data.totalFiles || 0,
      processedFiles: data.processedFiles || 0,
      currentFile: data.currentFile || null,
      failedFiles: data.failedFiles || 0
    };

    this.modal.updateProgress(this.status.indexingProgress);

    // Update live stats if provided (for real-time display)
    if (data.stats) {
      this.status.stats = data.stats;
      this.modal.updateStatus(this.status);
    }

    // Update stats if completed
    if (data.status === 'completed') {
      this.status.lastSync = new Date().toISOString();
      this.modal.updateStatus(this.status);
    }
  }

  /**
   * Set auto-index enabled/disabled
   */
  setAutoIndex(enabled) {
    this.wsManager.send({
      type: 'knowledge_base_autoindex_request',
      enabled
    });

    // Optimistic update
    this.status.autoIndex = enabled;
    this.modal.updateStatus(this.status);
  }

  /**
   * Handle auto-index response
   */
  handleAutoIndexResponse(data) {
    if (data.success) {
      this.status.autoIndex = data.enabled;
    } else {
      // Revert optimistic update
      this.status.autoIndex = !this.status.autoIndex;
      console.error('Failed to set auto-index:', data.error);
    }

    this.modal.updateStatus(this.status);
  }

  /**
   * Perform a search
   */
  search(query, options = {}) {
    // Use provided query or existing
    const searchQuery = query !== null ? query : this.searchState.query;

    if (!searchQuery) {
      return;
    }

    // Update search state
    this.searchState = {
      ...this.searchState,
      query: searchQuery,
      type: options.type || this.searchState.type,
      filters: options.filters || this.searchState.filters,
      page: options.page || 1,
      limit: options.limit || this.searchState.limit,
      loading: true,
      error: null,
      // Update diversity options if provided
      diversityStrategy: options.diversityStrategy ?? this.searchState.diversityStrategy,
      diversityDecay: options.diversityDecay ?? this.searchState.diversityDecay,
      maxPerDocument: options.maxPerDocument ?? this.searchState.maxPerDocument,
      semanticDedup: options.semanticDedup ?? this.searchState.semanticDedup,
      semanticDedupThreshold: options.semanticDedupThreshold ?? this.searchState.semanticDedupThreshold
    };

    // Send search request
    this.wsManager.send({
      type: 'knowledge_base_search_request',
      query: this.searchState.query,
      searchType: this.searchState.type,
      filters: this.searchState.filters,
      page: this.searchState.page,
      limit: this.searchState.limit,
      // Include diversity options
      diversityStrategy: this.searchState.diversityStrategy,
      diversityDecay: this.searchState.diversityDecay,
      maxPerDocument: this.searchState.maxPerDocument,
      semanticDedup: this.searchState.semanticDedup,
      semanticDedupThreshold: this.searchState.semanticDedupThreshold
    });
  }

  /**
   * Update diversity settings
   */
  setDiversitySettings(settings) {
    this.searchState = {
      ...this.searchState,
      ...settings
    };
  }

  /**
   * Get current diversity settings
   */
  getDiversitySettings() {
    return {
      diversityStrategy: this.searchState.diversityStrategy,
      diversityDecay: this.searchState.diversityDecay,
      maxPerDocument: this.searchState.maxPerDocument,
      semanticDedup: this.searchState.semanticDedup,
      semanticDedupThreshold: this.searchState.semanticDedupThreshold
    };
  }

  /**
   * Handle search response
   */
  handleSearchResponse(data) {
    this.searchState.loading = false;

    if (data.error) {
      this.searchState.error = data.error;
      this.modal.updateSearchResults({
        error: data.error
      });
      return;
    }

    this.searchState.results = data.results || [];
    this.searchState.total = data.total || 0;
    this.searchState.totalPages = Math.ceil(this.searchState.total / this.searchState.limit);

    this.modal.updateSearchResults({
      results: this.searchState.results,
      total: this.searchState.total,
      page: this.searchState.page,
      totalPages: this.searchState.totalPages,
      query: this.searchState.query
    });
  }

  /**
   * Set callback for opening files
   */
  setOpenFileCallback(callback) {
    this.onOpenFile = callback;
  }
}
