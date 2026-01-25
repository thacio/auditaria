/**
 * Knowledge Base Modal UI Component
 *
 * Handles rendering and user interactions for the Knowledge Base
 * search and management interface.
 */

// SVG Icons
const ICONS = {
  search: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>`,
  settings: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`,
  book: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>`,
  chevronDown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"></path></svg>`,
  file: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>`,
  info: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>`,
  alertTriangle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>`,
  refresh: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>`,
  play: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>`,
  database: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5V19A9 3 0 0 0 21 19V5"></path><path d="M3 12A9 3 0 0 0 21 12"></path></svg>`,
  arrowRight: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>`,
  x: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>`,
  filter: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`,
  alertCircle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" x2="12" y1="8" y2="12"></line><line x1="12" x2="12.01" y1="16" y2="16"></line></svg>`,
  fileSearch: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3"></path><path d="m9 18-1.5-1.5"></path><circle cx="5" cy="14" r="3"></circle></svg>`,
};


export class KnowledgeBaseModal {
  constructor(manager) {
    this.manager = manager;
    this.container = null;
    this.activeTab = 'search';
    this.filtersExpanded = false;
    this.confirmDialog = null;
    this.selectedExtensions = []; // Track selected file extensions
    this.selectedFolders = []; // Track selected folder paths
    this.statusRefreshInterval = null; // Auto-refresh interval

    // Bind methods
    this.handleKeyDown = this.handleKeyDown.bind(this);
  }

  /**
   * Create and show the modal
   */
  show() {
    if (this.container) {
      this.container.classList.add('show');
      document.addEventListener('keydown', this.handleKeyDown);
      // Focus search input
      setTimeout(() => {
        const searchInput = this.container.querySelector('.kb-search-input');
        if (searchInput) searchInput.focus();
      }, 100);
      // Start auto-refresh
      this.startStatusRefresh();
      return;
    }

    this.container = document.createElement('div');
    this.container.className = 'kb-modal';
    this.container.innerHTML = this.renderModal();
    document.body.appendChild(this.container);

    // Setup event listeners
    this.setupEventListeners();

    // Render initial filter tags
    this.renderFolderTags();
    this.renderExtensionTags();

    // Show with animation
    requestAnimationFrame(() => {
      this.container.classList.add('show');
    });

    document.addEventListener('keydown', this.handleKeyDown);

    // Request initial status
    this.manager.requestStatus();

    // Start auto-refresh when management tab is active
    this.startStatusRefresh();
  }

  /**
   * Hide the modal
   */
  hide() {
    if (!this.container) return;

    this.container.classList.remove('show');
    document.removeEventListener('keydown', this.handleKeyDown);

    // Stop auto-refresh
    this.stopStatusRefresh();

    // Remove after animation
    setTimeout(() => {
      if (this.container && !this.container.classList.contains('show')) {
        this.container.remove();
        this.container = null;
      }
    }, 200);
  }

  /**
   * Handle keyboard events
   */
  handleKeyDown(event) {
    if (event.key === 'Escape') {
      if (this.confirmDialog) {
        this.hideConfirmDialog();
      } else {
        this.hide();
      }
    }
  }

  /**
   * Render the main modal structure
   */
  renderModal() {
    return `
      <div class="kb-modal-backdrop"></div>
      <div class="kb-modal-content" role="dialog" aria-labelledby="kb-modal-title">
        <div class="kb-modal-header">
          <h2 class="kb-modal-title" id="kb-modal-title">
            <span class="kb-modal-title-icon">${ICONS.book}</span>
            Knowledge Base
          </h2>
          <button class="kb-modal-close" aria-label="Close">
            ${ICONS.close}
          </button>
        </div>
        <div class="kb-tabs" role="tablist">
          <button class="kb-tab active" role="tab" data-tab="search" aria-selected="true">
            <span class="kb-tab-icon">${ICONS.search}</span>
            Search
          </button>
          <button class="kb-tab" role="tab" data-tab="management" aria-selected="false">
            <span class="kb-tab-icon">${ICONS.settings}</span>
            Management
          </button>
        </div>
        <div class="kb-modal-body">
          <div class="kb-tab-content">
            <div class="kb-tab-panel active" id="kb-search-panel" role="tabpanel" data-panel="search">
              ${this.renderSearchTab()}
            </div>
            <div class="kb-tab-panel" id="kb-management-panel" role="tabpanel" data-panel="management">
              ${this.renderManagementTab()}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render the search tab content
   */
  renderSearchTab() {
    return `
      <div class="kb-search-container">
        <!-- Search Input -->
        <div class="kb-search-input-group">
          <div class="kb-search-input-wrapper">
            <input
              type="text"
              class="kb-search-input"
              placeholder="Search the knowledge base..."
              aria-label="Search query"
            />
            <button class="kb-search-clear" aria-label="Clear search">
              ${ICONS.x}
            </button>
          </div>
          <button class="kb-search-button">
            ${ICONS.search}
            Search
          </button>
        </div>

        <!-- Search Options -->
        <div class="kb-search-options">
          <div class="kb-option-group">
            <label class="kb-option-label" for="kb-search-type">Search type:</label>
            <select id="kb-search-type" class="kb-select kb-search-type-select">
              <option value="hybrid" selected>Hybrid (Recommended)</option>
              <option value="semantic">Semantic</option>
              <option value="keyword">Keyword</option>
            </select>
          </div>
          <div class="kb-option-group">
            <label class="kb-option-label" for="kb-results-limit">Results per page:</label>
            <select id="kb-results-limit" class="kb-select kb-limit-select">
              <option value="10">10</option>
              <option value="25" selected>25</option>
              <option value="50">50</option>
            </select>
          </div>
        </div>

        <!-- Filters -->
        <div class="kb-filters-panel">
          <button class="kb-filters-toggle">
            <span>${ICONS.filter} Filters</span>
            <span class="kb-filters-toggle-icon">${ICONS.chevronDown}</span>
          </button>
          <div class="kb-filters-content">
            <div class="kb-filters-grid">
              <div class="kb-filter-group">
                <label class="kb-filter-label">Folder paths</label>
                <div class="kb-filter-tags-container">
                  <div class="kb-filter-tags-input-row">
                    <input
                      type="text"
                      class="kb-filter-input kb-filter-folder"
                      placeholder="Add folder (e.g., src/components)"
                    />
                    <button class="kb-filter-add-btn kb-add-folder-btn" type="button" title="Add folder">+</button>
                  </div>
                  <div class="kb-filter-tags" id="kb-filter-folder-tags"></div>
                </div>
              </div>
              <div class="kb-filter-group">
                <label class="kb-filter-label">File types</label>
                <div class="kb-filter-tags-container">
                  <div class="kb-filter-tags-input-row">
                    <input
                      type="text"
                      class="kb-filter-input kb-filter-extension"
                      placeholder="Add extension (e.g., pdf, docx, md)"
                    />
                    <button class="kb-filter-add-btn kb-add-extension-btn" type="button" title="Add extension">+</button>
                  </div>
                  <div class="kb-filter-tags" id="kb-filter-extension-tags"></div>
                </div>
              </div>
            </div>
            <div class="kb-filters-actions">
              <button class="kb-clear-filters">Clear filters</button>
            </div>
          </div>
        </div>

        <!-- Results Area -->
        <div class="kb-results-container" id="kb-results-container">
          ${this.renderEmptyState()}
        </div>
      </div>
    `;
  }

  /**
   * Render the management tab content
   */
  renderManagementTab() {
    const status = this.manager.status;
    return `
      <div class="kb-management-container">
        <!-- Status Card -->
        <div class="kb-status-card" id="kb-status-card">
          ${this.renderStatusCard(status)}
        </div>

        <!-- Progress Card (below status, hidden by default) -->
        <div class="kb-progress-card" id="kb-progress-card" style="display: none;">
          ${this.renderProgressCard()}
        </div>

        <!-- Info Card -->
        <div class="kb-info-card">
          <div class="kb-info-header">
            <span class="kb-info-icon">${ICONS.info}</span>
            <h3 class="kb-info-title">What is the Knowledge Base?</h3>
          </div>
          <p class="kb-info-description">
            The Knowledge Base provides semantic search capabilities for your codebase.
            It indexes your files and creates embeddings that allow you to search not just
            by exact keywords, but by meaning and context. This enables finding relevant
            text or code even when you don't know the exact terms used.
          </p>
          <div class="kb-ram-warning">
            <span class="kb-ram-warning-icon">${ICONS.alertTriangle}</span>
            <p class="kb-ram-warning-text">
              <strong>Experimental Feature:</strong> Knowledge base indexing requires significant RAM.
              A computer with at least <strong>16GB RAM</strong> is required, and <strong>32GB+ is recommended</strong>
              for larger codebases. Memory usage may spike during indexing and cause a crash, you can restart Auditaria and resume indexing normally with '/knowledge init'. The process runs in the background and won't block your work.<br>
              If running Auditaria through node (npm install), crashes may happen more often for large bases, as there is a 4gb limit; Bun executable doesn't have a memory cap, so it may handle larger codebases more gracefully, but it will also require more memory resources.
            </p>
          </div>
        </div>

        <!-- Actions Card -->
        <div class="kb-actions-card" id="kb-actions-card">
          ${this.renderActionsCard(status)}
        </div>
      </div>
    `;
  }

  /**
   * Render the status card content
   */
  renderStatusCard(status) {
    const initialized = status.initialized;
    const running = status.running;
    const indexing = status.indexingProgress?.status === 'indexing' ||
                     status.indexingProgress?.status === 'discovering' ||
                     status.indexingProgress?.status === 'syncing';

    let indicatorClass = 'not-initialized';
    let statusText = 'Not Initialized';

    if (initialized) {
      indicatorClass = indexing ? 'indexing' : 'initialized';
      statusText = indexing ? 'Indexing...' : 'Ready';
    }

    const stats = status.stats || {};

    // Calculate if there are pending files (needs resume)
    const hasPending = (stats.pendingDocuments || 0) > 0 ||
                       (stats.totalDocuments && stats.filesIndexed && stats.totalDocuments > stats.filesIndexed);

    return `
      <div class="kb-status-header">
        <span class="kb-status-indicator ${indicatorClass}"></span>
        <span class="kb-status-title">${statusText}</span>
        ${hasPending && !indexing ? '<span class="kb-status-badge warning">Incomplete</span>' : ''}
        ${status.lastSync ? `<span class="kb-status-subtitle">Last sync: ${this.formatDate(status.lastSync)}</span>` : ''}
      </div>
      <div class="kb-stats-grid">
        <div class="kb-stat-item">
          <span class="kb-stat-label">Indexing Service</span>
          <span class="kb-stat-value">
            <span class="kb-service-status ${running ? 'running' : 'stopped'}">
              <span class="kb-service-dot"></span>
              ${running ? 'Running' : 'Offline'}
            </span>
          </span>
        </div>
        <div class="kb-stat-item">
          <span class="kb-stat-label">Indexed</span>
          <span class="kb-stat-value ${!stats.filesIndexed ? 'muted' : ''}">
            ${stats.filesIndexed || 0}
          </span>
        </div>
        <div class="kb-stat-item">
          <span class="kb-stat-label">Pending</span>
          <span class="kb-stat-value ${!stats.pendingDocuments ? 'muted' : (stats.pendingDocuments > 0 ? 'warning' : '')}">
            ${stats.pendingDocuments || 0}
          </span>
        </div>
        <div class="kb-stat-item">
          <span class="kb-stat-label">Failed</span>
          <span class="kb-stat-value ${!stats.failedDocuments ? 'muted' : (stats.failedDocuments > 0 ? 'error' : '')}">
            ${stats.failedDocuments || 0}
          </span>
        </div>
        <div class="kb-stat-item">
          <span class="kb-stat-label">Passages</span>
          <span class="kb-stat-value ${!stats.totalPassages ? 'muted' : ''}">${stats.totalPassages || '-'}</span>
        </div>
        <div class="kb-stat-item">
          <span class="kb-stat-label">DB Size</span>
          <span class="kb-stat-value ${!stats.dbSize ? 'muted' : ''}">${stats.dbSize ? this.formatBytes(stats.dbSize) : '-'}</span>
        </div>
        <div class="kb-stat-item">
          <span class="kb-stat-label">Auto-Index</span>
          <span class="kb-stat-value">${status.autoIndex ? 'Enabled' : 'Disabled'}</span>
        </div>
      </div>
    `;
  }

  /**
   * Render the actions card content
   */
  renderActionsCard(status) {
    const initialized = status.initialized;
    const running = status.running;
    const indexing = status.indexingProgress?.status === 'indexing' ||
                     status.indexingProgress?.status === 'discovering' ||
                     status.indexingProgress?.status === 'syncing';

    // Service can be started if: database exists (initialized) but service not running, or no database yet
    const canStartService = !running;
    const serviceButtonDisabled = running || indexing;

    return `
      <h3 class="kb-actions-title">Actions</h3>
      <div class="kb-actions-grid">
        <div class="kb-action-row">
          <div class="kb-action-info">
            <span class="kb-action-name">Start Indexing Service</span>
            <span class="kb-action-description">
              ${!initialized
                ? 'Initialize the knowledge base and start indexing your codebase.'
                : running
                  ? 'Service is already running.'
                  : 'Start the service to enable searching and process pending files.'}
            </span>
          </div>
          <button class="kb-action-button ${canStartService ? 'primary' : 'secondary'} kb-resume-button" ${serviceButtonDisabled ? 'disabled' : ''}>
            ${ICONS.play}
            ${running ? 'Running' : 'Start'}
          </button>
        </div>

        ${initialized ? `
          <div class="kb-action-row">
            <div class="kb-action-info">
              <span class="kb-action-name">Full Reindex</span>
              <span class="kb-action-description">Rebuild the entire index from scratch. Use if files are out of sync.</span>
            </div>
            <button class="kb-action-button secondary kb-reindex-button" ${indexing ? 'disabled' : ''}>
              ${ICONS.refresh}
              Reindex
            </button>
          </div>
        ` : ''}

        <div class="kb-action-row">
          <div class="kb-action-info">
            <span class="kb-action-name">Auto-Index</span>
            <span class="kb-action-description">Automatically index new and modified files on startup.</span>
          </div>
          <div class="kb-toggle-container">
            <div class="kb-toggle-switch ${status.autoIndex ? 'active' : ''} ${!initialized || indexing ? 'disabled' : ''}" data-action="autoindex">
              <div class="kb-toggle-slider"></div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render the progress card content
   */
  renderProgressCard(progress = {}) {
    const percent = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

    return `
      <div class="kb-progress-header">
        <span class="kb-progress-title">Indexing in progress...</span>
        <span class="kb-progress-percentage">${percent}%</span>
      </div>
      <div class="kb-progress-bar">
        <div class="kb-progress-fill" style="width: ${percent}%"></div>
      </div>
      <div class="kb-progress-details">
        <span class="kb-progress-current">${progress.currentFile || 'Starting...'}</span>
        <span class="kb-progress-stats">${progress.processed || 0} / ${progress.total || 0} files</span>
      </div>
    `;
  }

  /**
   * Render empty state for search results
   */
  renderEmptyState() {
    return `
      <div class="kb-empty-state">
        <div class="kb-empty-state-icon">${ICONS.fileSearch}</div>
        <h3 class="kb-empty-state-title">Search your codebase</h3>
        <p class="kb-empty-state-description">
          Enter a search query to find relevant code, documentation, and files
          in your knowledge base.
        </p>
      </div>
    `;
  }

  /**
   * Render not initialized state
   */
  renderNotInitializedState() {
    return `
      <div class="kb-not-initialized">
        <div class="kb-not-initialized-icon">${ICONS.database}</div>
        <h3 class="kb-not-initialized-title">Knowledge Base Not Initialized</h3>
        <p class="kb-not-initialized-description">
          The knowledge base needs to be initialized before you can search.
          Go to the Management tab to set it up.
        </p>
        <button class="kb-go-to-management">
          Go to Management
          ${ICONS.arrowRight}
        </button>
      </div>
    `;
  }

  /**
   * Render loading state
   */
  renderLoadingState() {
    return `
      <div class="kb-loading">
        <div class="kb-loading-spinner"></div>
        <span class="kb-loading-text">Searching...</span>
      </div>
    `;
  }

  /**
   * Render error state
   */
  renderErrorState(message) {
    return `
      <div class="kb-error">
        <div class="kb-error-icon">${ICONS.alertCircle}</div>
        <h3 class="kb-error-title">Search Failed</h3>
        <p class="kb-error-message">${message || 'An error occurred while searching.'}</p>
        <button class="kb-retry-button">Try Again</button>
      </div>
    `;
  }

  /**
   * Render no results state
   */
  renderNoResultsState(query) {
    return `
      <div class="kb-empty-state">
        <div class="kb-empty-state-icon">${ICONS.search}</div>
        <h3 class="kb-empty-state-title">No results found</h3>
        <p class="kb-empty-state-description">
          No matches found for "${this.escapeHtml(query)}".
          Try different keywords or adjust your filters.
        </p>
      </div>
    `;
  }

  /**
   * Render search results
   */
  renderResults(results, query, page, totalPages, total, limit = 25) {
    if (!results || results.length === 0) {
      return this.renderNoResultsState(query);
    }

    const startIndex = (page - 1) * limit + 1;
    const endIndex = Math.min(page * limit, total);

    // Check if indexing is in progress
    const isIndexing = this.manager.status.indexingProgress?.status === 'indexing' ||
                       this.manager.status.indexingProgress?.status === 'discovering' ||
                       this.manager.status.indexingProgress?.status === 'syncing';

    // Generate cards with correct numbering based on current page
    const cardsHtml = results.map((result, index) => this.renderResultCard(result, index, startIndex + index)).join('');

    return `
      ${isIndexing ? `
        <div class="kb-indexing-notice">
          <span class="kb-indexing-notice-icon">${ICONS.info}</span>
          <span>Indexing in progress. Results may be incomplete until indexing finishes.</span>
        </div>
      ` : ''}
      <div class="kb-results-header">
        <span class="kb-results-count">Found <strong>${total}</strong> result${total !== 1 ? 's' : ''}</span>
        <span class="kb-results-showing">Showing ${startIndex}-${endIndex}</span>
      </div>
      <div class="kb-results-list">
        ${cardsHtml}
      </div>
      ${totalPages > 1 ? this.renderPagination(page, totalPages) : ''}
    `;
  }

  /**
   * Render a single result card
   */
  renderResultCard(result, index, resultNumber) {
    // Handle both direct SearchResult format and our formatted version
    const filePath = result.filePath || result.fileName || 'Unknown file';
    const score = typeof result.score === 'number' ? result.score : 0;
    const scoreClass = score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low';
    const scorePercent = Math.round(score * 100);

    // Handle passages - could be our format or direct chunkText
    let passages = [];
    if (Array.isArray(result.passages) && result.passages.length > 0) {
      passages = result.passages;
    } else if (result.chunkText) {
      // Direct SearchResult format - create passage from chunkText
      passages = [{
        content: result.chunkText,
        lineNumber: result.metadata?.page || null
      }];
    }

    const visiblePassages = passages.slice(0, 2);

    // Build passage HTML with smart truncation and mark highlighting
    let passagesHtml = '';
    if (visiblePassages.length > 0) {
      passagesHtml = visiblePassages.map((p, pIndex) => {
        const content = p.content || p.text || '';
        const truncated = this.smartTruncate(content, 400);
        const safeHtml = this.escapeHtmlPreservingMarks(truncated);
        return `<div class="kb-passage">
          <div class="kb-passage-content">${safeHtml}</div>
        </div>`;
      }).join('');
    } else {
      passagesHtml = '<div class="kb-passage kb-passage-empty">No preview available</div>';
    }

    // Get file icon with explicit dimensions for proper scaling
    const fileIcon = ICONS.file.replace('<svg ', '<svg width="16" height="16" ');

    const html = `
      <div class="kb-result-card" data-result-index="${index}">
        <div class="kb-result-header">
          <span class="kb-result-number">${resultNumber}.</span>
          <div class="kb-result-file">
            <span class="kb-result-file-icon">${fileIcon}</span>
            <a class="kb-result-path" title="${this.escapeHtml(filePath)}" data-path="${this.escapeHtml(filePath)}">
              ${this.escapeHtml(this.shortenPath(filePath))}
            </a>
          </div>
          <div class="kb-result-meta">
            <span class="kb-result-score ${scoreClass}">${scorePercent}% match</span>
          </div>
        </div>
        <div class="kb-result-passages">
          ${passagesHtml}
        </div>
      </div>
    `;

    return html;
  }

  /**
   * Render score indicator with visual bar
   */
  renderScoreIndicator(score) {
    const scorePercent = Math.round(score * 100);
    const scoreClass = score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low';

    return `
      <div class="kb-result-score-wrapper">
        <div class="kb-result-score-bar">
          <div class="kb-result-score-fill ${scoreClass}" style="width: ${scorePercent}%"></div>
        </div>
        <span class="kb-result-score ${scoreClass}">${scorePercent}%</span>
      </div>
    `;
  }

  /**
   * Smart truncation that centers around <mark> tags when present
   * Inspired by SearchResponseFormatter - uses sentence-aware truncation
   */
  smartTruncate(text, minLen = 500) {
    if (!text || text.length <= minLen) {
      return text;
    }

    // Find all <mark> positions
    const marks = this.findMarkPositions(text);

    if (marks.length > 0) {
      // MARK-AWARE: Show all marked sentences with expanding context
      return this.truncateAroundMarks(text, marks, minLen);
    } else {
      // SEMANTIC (no marks): Bookend strategy
      return this.truncateSemantic(text, minLen);
    }
  }

  /**
   * Find all <mark>...</mark> positions in text
   */
  findMarkPositions(text) {
    const positions = [];
    const regex = /<mark>([\s\S]*?)<\/mark>/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
      positions.push({
        start: match.index,
        end: match.index + match[0].length
      });
    }

    return positions;
  }

  /**
   * Split text into sentences
   */
  splitIntoSentences(text) {
    const sentences = [];
    const normalizedText = text.replace(/\s+/g, ' ').trim();

    if (normalizedText.length === 0) {
      return [];
    }

    // Pattern: sentence-ending punctuation followed by space and capital letter (or end)
    const boundaryPattern = /[.!?](?=\s+[A-Z]|\s*$)/g;

    let lastEnd = 0;
    let match;
    let index = 0;

    while ((match = boundaryPattern.exec(normalizedText)) !== null) {
      const sentenceEnd = match.index + 1;
      const sentenceText = normalizedText.substring(lastEnd, sentenceEnd).trim();

      if (sentenceText.length > 0) {
        sentences.push({
          text: sentenceText,
          start: lastEnd,
          end: sentenceEnd,
          index: index++
        });
      }

      lastEnd = sentenceEnd;
      while (lastEnd < normalizedText.length && /\s/.test(normalizedText[lastEnd])) {
        lastEnd++;
      }
    }

    // Handle remaining text
    if (lastEnd < normalizedText.length) {
      const remaining = normalizedText.substring(lastEnd).trim();
      if (remaining.length > 0) {
        sentences.push({
          text: remaining,
          start: lastEnd,
          end: normalizedText.length,
          index
        });
      }
    }

    // If no sentences found, treat entire text as one
    if (sentences.length === 0) {
      sentences.push({
        text: normalizedText,
        start: 0,
        end: normalizedText.length,
        index: 0
      });
    }

    return sentences;
  }

  /**
   * Truncate around marked content with expanding context
   */
  truncateAroundMarks(text, marks, minLen) {
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) return text;

    // Find sentences containing marks
    const markedIndices = new Set();
    for (const mark of marks) {
      for (let i = 0; i < sentences.length; i++) {
        const s = sentences[i];
        if (mark.start < s.end && mark.end > s.start) {
          markedIndices.add(i);
        }
      }
    }

    if (markedIndices.size === 0) {
      return this.truncateSemantic(text, minLen);
    }

    // Start with context radius of 1
    let contextRadius = 1;
    let selectedIndices = this.expandMarkedRegion(markedIndices, sentences.length, contextRadius);
    let currentLength = this.calculateSelectedLength(sentences, selectedIndices);

    // Expand context until we reach minimum OR include all sentences
    while (currentLength < minLen && selectedIndices.size < sentences.length) {
      contextRadius++;
      selectedIndices = this.expandMarkedRegion(markedIndices, sentences.length, contextRadius);
      currentLength = this.calculateSelectedLength(sentences, selectedIndices);
    }

    const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
    return this.buildResultWithGaps(sentences, sortedIndices);
  }

  /**
   * Expand selection around marked sentences by a given radius
   */
  expandMarkedRegion(markedIndices, totalSentences, radius) {
    const expanded = new Set();

    for (const idx of markedIndices) {
      for (let r = -radius; r <= radius; r++) {
        const newIdx = idx + r;
        if (newIdx >= 0 && newIdx < totalSentences) {
          expanded.add(newIdx);
        }
      }
    }

    return expanded;
  }

  /**
   * Truncate using bookend strategy for semantic search (no marks)
   */
  truncateSemantic(text, minLen) {
    const sentences = this.splitIntoSentences(text);

    if (sentences.length === 0) return text;
    if (sentences.length <= 2) {
      return sentences.map(s => s.text).join(' ');
    }

    // Start with first and last sentence
    const selectedIndices = new Set([0, sentences.length - 1]);
    let currentLength = this.calculateSelectedLength(sentences, selectedIndices);

    // Expand from both ends toward middle
    let leftBoundary = 0;
    let rightBoundary = sentences.length - 1;

    while (currentLength < minLen && leftBoundary < rightBoundary - 1) {
      if (leftBoundary + 1 < rightBoundary) {
        leftBoundary++;
        selectedIndices.add(leftBoundary);
        currentLength = this.calculateSelectedLength(sentences, selectedIndices);
        if (currentLength >= minLen) break;
      }

      if (rightBoundary - 1 > leftBoundary) {
        rightBoundary--;
        selectedIndices.add(rightBoundary);
        currentLength = this.calculateSelectedLength(sentences, selectedIndices);
        if (currentLength >= minLen) break;
      }
    }

    const sortedIndices = Array.from(selectedIndices).sort((a, b) => a - b);
    return this.buildResultWithGaps(sentences, sortedIndices);
  }

  /**
   * Calculate total length of selected sentences
   */
  calculateSelectedLength(sentences, indices) {
    let length = 0;
    const sortedIndices = Array.from(indices).sort((a, b) => a - b);

    for (const idx of sortedIndices) {
      length += sentences[idx].text.length + 1;
    }

    // Account for gap indicators
    let gaps = 0;
    for (let i = 1; i < sortedIndices.length; i++) {
      if (sortedIndices[i] > sortedIndices[i - 1] + 1) {
        gaps++;
      }
    }
    length += gaps * 7; // " [...] "

    // Account for start/end ellipsis
    if (sortedIndices.length > 0) {
      if (sortedIndices[0] > 0) length += 4;
      if (sortedIndices[sortedIndices.length - 1] < sentences.length - 1) length += 4;
    }

    return length;
  }

  /**
   * Build result string with gap indicators
   */
  buildResultWithGaps(sentences, selectedIndices) {
    if (selectedIndices.length === 0) {
      return '';
    }

    let result = '';
    let prevIdx = -2;

    // Check if we're skipping the beginning
    if (selectedIndices[0] > 0) {
      result = '... ';
    }

    for (const idx of selectedIndices) {
      if (prevIdx >= 0 && idx > prevIdx + 1) {
        result = result.trimEnd() + ' [...] ';
      } else if (result.length > 0 && !result.endsWith(' ')) {
        result += ' ';
      }

      result += sentences[idx].text;
      prevIdx = idx;
    }

    // Check if we're skipping the end
    if (selectedIndices[selectedIndices.length - 1] < sentences.length - 1) {
      result = result.trimEnd() + ' ...';
    }

    return result.trim();
  }

  /**
   * Escape HTML but preserve <mark> tags for highlighting
   */
  escapeHtmlPreservingMarks(text) {
    // Split by mark tags, escape each segment, then rejoin with actual mark tags
    const parts = text.split(/(<mark>|<\/mark>)/gi);

    return parts.map(part => {
      const lowerPart = part.toLowerCase();
      if (lowerPart === '<mark>') {
        return '<mark style="background: #fef08a; color: #854d0e; padding: 1px 3px; border-radius: 2px; font-weight: 500;">';
      } else if (lowerPart === '</mark>') {
        return '</mark>';
      } else {
        return this.escapeHtml(part);
      }
    }).join('');
  }

  /**
   * Render a passage
   */
  renderPassage(passage) {
    const content = passage.content || passage.text || '';
    const lineNumber = passage.lineNumber || passage.startLine;

    return `
      <div class="kb-passage">
        ${lineNumber ? `<span class="kb-passage-line-number">${lineNumber}</span>` : ''}
        ${this.escapeHtml(content)}
      </div>
    `;
  }

  /**
   * Render pagination controls
   */
  renderPagination(currentPage, totalPages) {
    const pages = this.getPaginationRange(currentPage, totalPages);

    return `
      <div class="kb-pagination">
        <button class="kb-page-button" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>
          Previous
        </button>
        ${pages.map(p => {
          if (p === '...') {
            return '<span class="kb-page-info">...</span>';
          }
          return `<button class="kb-page-button ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
        }).join('')}
        <button class="kb-page-button" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>
          Next
        </button>
      </div>
    `;
  }

  /**
   * Get pagination range
   */
  getPaginationRange(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }

    if (current <= 3) {
      return [1, 2, 3, 4, 5, '...', total];
    }

    if (current >= total - 2) {
      return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
    }

    return [1, '...', current - 1, current, current + 1, '...', total];
  }

  /**
   * Setup event listeners
   */
  setupEventListeners() {
    if (!this.container) return;

    // Close button and backdrop
    this.container.querySelector('.kb-modal-close').addEventListener('click', () => this.hide());
    this.container.querySelector('.kb-modal-backdrop').addEventListener('click', () => this.hide());

    // Tabs
    this.container.querySelectorAll('.kb-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });

    // Search input
    const searchInput = this.container.querySelector('.kb-search-input');
    const searchClear = this.container.querySelector('.kb-search-clear');
    const searchButton = this.container.querySelector('.kb-search-button');

    searchInput.addEventListener('input', () => {
      searchClear.classList.toggle('visible', searchInput.value.length > 0);
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.performSearch();
      }
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.classList.remove('visible');
      searchInput.focus();
    });

    searchButton.addEventListener('click', () => this.performSearch());

    // Filters toggle
    const filtersToggle = this.container.querySelector('.kb-filters-toggle');
    const filtersContent = this.container.querySelector('.kb-filters-content');

    filtersToggle.addEventListener('click', () => {
      this.filtersExpanded = !this.filtersExpanded;
      filtersToggle.classList.toggle('expanded', this.filtersExpanded);
      filtersContent.classList.toggle('expanded', this.filtersExpanded);
    });

    // Folder tag input
    const folderInput = this.container.querySelector('.kb-filter-folder');
    const addFolderBtn = this.container.querySelector('.kb-add-folder-btn');

    const addFolder = () => {
      const value = folderInput.value.trim();
      if (value && !this.selectedFolders.includes(value)) {
        this.selectedFolders.push(value);
        this.renderFolderTags();
        folderInput.value = '';
      }
      folderInput.focus();
    };

    folderInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addFolder();
      }
    });

    addFolderBtn.addEventListener('click', addFolder);

    // Extension tag input
    const extensionInput = this.container.querySelector('.kb-filter-extension');
    const addExtensionBtn = this.container.querySelector('.kb-add-extension-btn');

    const addExtension = () => {
      const value = extensionInput.value.trim().toLowerCase().replace(/^\./, '');
      if (value && !this.selectedExtensions.includes(value)) {
        this.selectedExtensions.push(value);
        this.renderExtensionTags();
        extensionInput.value = '';
      }
      extensionInput.focus();
    };

    extensionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addExtension();
      }
    });

    addExtensionBtn.addEventListener('click', addExtension);

    // Remove tag (delegated) - handles both folders and extensions
    this.container.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.kb-tag-remove');
      if (removeBtn) {
        const value = removeBtn.dataset.value;
        const tagType = removeBtn.dataset.type;
        if (tagType === 'folder') {
          this.selectedFolders = this.selectedFolders.filter(f => f !== value);
          this.renderFolderTags();
        } else if (tagType === 'extension') {
          this.selectedExtensions = this.selectedExtensions.filter(e => e !== value);
          this.renderExtensionTags();
        }
      }
    });

    // Clear filters
    this.container.querySelector('.kb-clear-filters').addEventListener('click', () => {
      this.selectedFolders = [];
      this.selectedExtensions = [];
      this.renderFolderTags();
      this.renderExtensionTags();
    });

    // Go to management button (in not initialized state)
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('.kb-go-to-management')) {
        this.switchTab('management');
      }
    });

    // Retry button
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('.kb-retry-button')) {
        this.performSearch();
      }
    });

    // Result card interactions
    this.container.addEventListener('click', (e) => {
      // Expand passages
      const expandBtn = e.target.closest('.kb-result-expand');
      if (expandBtn) {
        const card = expandBtn.closest('.kb-result-card');
        const hiddenPassages = card.querySelector('.kb-result-hidden-passages');
        if (hiddenPassages) {
          const isExpanded = hiddenPassages.style.display !== 'none';
          hiddenPassages.style.display = isExpanded ? 'none' : 'block';
          expandBtn.classList.toggle('expanded', !isExpanded);
          expandBtn.innerHTML = isExpanded
            ? `${ICONS.chevronDown} Show more passages`
            : `${ICONS.chevronDown} Hide passages`;
        }
      }

      // Open file in editor
      const resultPath = e.target.closest('.kb-result-path');
      if (resultPath) {
        const path = resultPath.dataset.path;
        if (path && this.manager.onOpenFile) {
          this.manager.onOpenFile(path);
        }
      }

      // Pagination
      const pageBtn = e.target.closest('.kb-page-button');
      if (pageBtn && !pageBtn.disabled) {
        const page = parseInt(pageBtn.dataset.page, 10);
        if (!isNaN(page)) {
          this.manager.search(null, { page });
        }
      }
    });

    // Management actions
    this.setupManagementListeners();
  }

  /**
   * Setup management tab listeners
   */
  setupManagementListeners() {
    if (!this.container) return;

    // Start Indexing Service button (replaces both init and resume)
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('.kb-resume-button')) {
        const isNewInit = !this.manager.status.initialized;
        this.showConfirmDialog(
          isNewInit ? 'Initialize Knowledge Base' : 'Start Indexing Service',
          isNewInit
            ? 'This will create a new knowledge base and start indexing your codebase. The process may take several minutes and use significant memory. Continue?'
            : 'This will start the indexing service and process any pending files. Continue?',
          () => {
            this.manager.resumeIndexing();
          }
        );
      }
    });

    // Reindex button
    this.container.addEventListener('click', (e) => {
      if (e.target.closest('.kb-reindex-button')) {
        this.showConfirmDialog(
          'Full Reindex',
          'This will rebuild the entire index from scratch. This process uses significant memory and may take a while for large codebases. Continue?',
          () => {
            this.manager.triggerReindex();
          },
          true
        );
      }
    });

    // Auto-index toggle
    this.container.addEventListener('click', (e) => {
      const toggle = e.target.closest('.kb-toggle-switch');
      if (toggle && !toggle.classList.contains('disabled')) {
        const isActive = toggle.classList.contains('active');
        this.manager.setAutoIndex(!isActive);
      }
    });
  }

  /**
   * Switch between tabs
   */
  switchTab(tabName) {
    this.activeTab = tabName;

    // Update tab buttons
    this.container.querySelectorAll('.kb-tab').forEach(tab => {
      const isActive = tab.dataset.tab === tabName;
      tab.classList.toggle('active', isActive);
      tab.setAttribute('aria-selected', isActive);
    });

    // Update tab panels
    this.container.querySelectorAll('.kb-tab-panel').forEach(panel => {
      const isActive = panel.dataset.panel === tabName;
      panel.classList.toggle('active', isActive);
    });

    // Focus search input if switching to search tab
    if (tabName === 'search') {
      const searchInput = this.container.querySelector('.kb-search-input');
      if (searchInput) searchInput.focus();
    }
  }

  /**
   * Perform a search
   */
  performSearch() {
    const query = this.container.querySelector('.kb-search-input').value.trim();
    if (!query) return;

    // Check if initialized
    if (!this.manager.status.initialized) {
      this.updateResultsContainer(this.renderNotInitializedState());
      return;
    }

    // Get search options
    const searchType = this.container.querySelector('.kb-search-type-select').value;
    const limit = parseInt(this.container.querySelector('.kb-limit-select').value, 10);

    // Get filters
    const filters = {};
    if (this.selectedFolders.length > 0) filters.folders = [...this.selectedFolders];
    if (this.selectedExtensions.length > 0) filters.extensions = [...this.selectedExtensions];

    // Show loading state
    this.updateResultsContainer(this.renderLoadingState());

    // Perform search
    this.manager.search(query, {
      type: searchType,
      limit,
      filters,
      page: 1
    });
  }

  /**
   * Update results container
   */
  updateResultsContainer(html) {
    const container = this.container?.querySelector('#kb-results-container');
    if (container) {
      container.innerHTML = html;
    }
  }

  /**
   * Update status display
   */
  updateStatus(status) {
    if (!this.container) return;

    const statusCard = this.container.querySelector('#kb-status-card');
    if (statusCard) {
      statusCard.innerHTML = this.renderStatusCard(status);
    }

    const actionsCard = this.container.querySelector('#kb-actions-card');
    if (actionsCard) {
      actionsCard.innerHTML = this.renderActionsCard(status);
    }

    // Update search tab based on initialization status
    const resultsContainer = this.container.querySelector('#kb-results-container');
    if (resultsContainer) {
      const hasResults = resultsContainer.querySelector('.kb-results-list');
      const showingNotInitialized = resultsContainer.querySelector('.kb-not-initialized');

      if (!status.initialized && !hasResults) {
        // Not initialized - show the not initialized message
        resultsContainer.innerHTML = this.renderNotInitializedState();
      } else if (status.initialized && showingNotInitialized) {
        // Just became initialized - show empty state so user can search
        resultsContainer.innerHTML = this.renderEmptyState();
      }
    }
  }

  /**
   * Update indexing progress
   */
  updateProgress(progress) {
    if (!this.container) return;

    const progressCard = this.container.querySelector('#kb-progress-card');
    if (!progressCard) return;

    const isIndexing = progress.status === 'indexing' ||
                       progress.status === 'discovering' ||
                       progress.status === 'syncing';

    progressCard.style.display = isIndexing ? 'block' : 'none';

    if (isIndexing) {
      progressCard.innerHTML = this.renderProgressCard({
        processed: progress.processedFiles || 0,
        total: progress.totalFiles || 0,
        currentFile: progress.currentFile || ''
      });
    }

    // Update status card to show indexing state
    this.updateStatus(this.manager.status);
  }

  /**
   * Update search results
   */
  updateSearchResults(data) {
    if (!this.container) return;

    if (data.error) {
      this.updateResultsContainer(this.renderErrorState(data.error));
      return;
    }

    const { results, total, page, totalPages, query } = data;
    const limit = this.manager.searchState.limit || 25;
    this.updateResultsContainer(this.renderResults(results, query, page, totalPages, total, limit));
  }

  /**
   * Show confirmation dialog
   */
  showConfirmDialog(title, message, onConfirm, isDanger = false) {
    // Create dialog overlay
    this.confirmDialog = document.createElement('div');
    this.confirmDialog.className = 'kb-confirm-overlay';
    this.confirmDialog.innerHTML = `
      <div class="kb-confirm-dialog">
        <h3 class="kb-confirm-title">${title}</h3>
        <p class="kb-confirm-message">${message}</p>
        <div class="kb-confirm-actions">
          <button class="kb-confirm-cancel">Cancel</button>
          <button class="kb-confirm-proceed ${isDanger ? 'danger' : ''}">Proceed</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.confirmDialog);

    // Show with animation
    requestAnimationFrame(() => {
      this.confirmDialog.classList.add('show');
    });

    // Event listeners
    const cancel = this.confirmDialog.querySelector('.kb-confirm-cancel');
    const proceed = this.confirmDialog.querySelector('.kb-confirm-proceed');

    cancel.addEventListener('click', () => this.hideConfirmDialog());
    proceed.addEventListener('click', () => {
      this.hideConfirmDialog();
      onConfirm();
    });
  }

  /**
   * Hide confirmation dialog
   */
  hideConfirmDialog() {
    if (!this.confirmDialog) return;

    this.confirmDialog.classList.remove('show');
    setTimeout(() => {
      this.confirmDialog?.remove();
      this.confirmDialog = null;
    }, 200);
  }

  /**
   * Render folder tags in the filter area
   */
  renderFolderTags() {
    const tagsContainer = this.container?.querySelector('#kb-filter-folder-tags');
    if (!tagsContainer) return;

    if (this.selectedFolders.length === 0) {
      tagsContainer.innerHTML = '<span class="kb-tags-placeholder">No folders selected</span>';
      return;
    }

    tagsContainer.innerHTML = this.selectedFolders.map(folder => `
      <span class="kb-tag kb-tag-folder">
        ${this.escapeHtml(folder)}
        <button class="kb-tag-remove" data-value="${this.escapeHtml(folder)}" data-type="folder" title="Remove">${ICONS.x}</button>
      </span>
    `).join('');
  }

  /**
   * Render extension tags in the filter area
   */
  renderExtensionTags() {
    const tagsContainer = this.container?.querySelector('#kb-filter-extension-tags');
    if (!tagsContainer) return;

    if (this.selectedExtensions.length === 0) {
      tagsContainer.innerHTML = '<span class="kb-tags-placeholder">No extensions selected</span>';
      return;
    }

    tagsContainer.innerHTML = this.selectedExtensions.map(ext => `
      <span class="kb-tag">
        .${this.escapeHtml(ext)}
        <button class="kb-tag-remove" data-value="${this.escapeHtml(ext)}" data-type="extension" title="Remove">${ICONS.x}</button>
      </span>
    `).join('');
  }

  /**
   * Utility: Escape HTML
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Utility: Shorten file path
   */
  shortenPath(path, maxLength = 60) {
    if (!path || path.length <= maxLength) return path;

    const parts = path.split(/[/\\]/);
    if (parts.length <= 3) return path;

    const fileName = parts.pop();
    const parentDir = parts.pop();

    return `.../${parentDir}/${fileName}`;
  }

  /**
   * Utility: Format date
   */
  formatDate(dateString) {
    if (!dateString) return '';

    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;

    // Less than 1 minute
    if (diff < 60000) return 'Just now';

    // Less than 1 hour
    if (diff < 3600000) {
      const mins = Math.floor(diff / 60000);
      return `${mins} minute${mins > 1 ? 's' : ''} ago`;
    }

    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    }

    // Format as date
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  /**
   * Utility: Format bytes
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  /**
   * Start auto-refresh of status when modal is open
   */
  startStatusRefresh() {
    // Clear any existing interval
    this.stopStatusRefresh();

    // Refresh status every 10 seconds
    this.statusRefreshInterval = setInterval(() => {
      // Only refresh if modal is visible and management tab is active
      if (this.container?.classList.contains('show') && this.activeTab === 'management') {
        this.manager.requestStatus();
      }
    }, 10000);
  }

  /**
   * Stop auto-refresh
   */
  stopStatusRefresh() {
    if (this.statusRefreshInterval) {
      clearInterval(this.statusRefreshInterval);
      this.statusRefreshInterval = null;
    }
  }
}
