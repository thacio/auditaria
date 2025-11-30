/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser Agent Notification Component (Peek Mode)
 *
 * A compact, non-intrusive notification that appears when the AI
 * uses the browser_agent tool during conversation.
 *
 * Features:
 * - Compact inline display
 * - Expandable to show screenshot thumbnail
 * - Progress indicator
 * - Stop button
 * - Auto-dismiss on completion
 */
export class BrowserAgentNotification {
    /**
     * @param {import('../managers/BrowserAgentManager.js').BrowserAgentManager} manager
     */
    constructor(manager) {
        this.manager = manager;
        this.container = null;
        this.isExpanded = false;
        this.isVisible = false;
        this.autoHideTimeout = null;
        this.updateInterval = null;

        this.createContainer();
        this.setupEventListeners();
    }

    /**
     * Create the notification container
     */
    createContainer() {
        this.container = document.createElement('div');
        this.container.className = 'browser-agent-notification';
        this.container.setAttribute('role', 'status');
        this.container.setAttribute('aria-live', 'polite');
        this.container.style.display = 'none';

        this.render();
    }

    /**
     * Render notification content
     */
    render() {
        const state = this.manager.getState();
        const currentStep = this.manager.getCurrentStep();
        const totalSteps = this.manager.getSteps().length;

        this.container.innerHTML = '';
        // Preserve 'show' class to maintain visibility
        const showClass = this.isVisible ? 'show' : '';
        this.container.className = `browser-agent-notification ${state} ${this.isExpanded ? 'expanded' : ''} ${showClass}`.trim();

        // Header row
        const header = document.createElement('div');
        header.className = 'browser-agent-notification-header';

        // Icon
        const icon = document.createElement('span');
        icon.className = 'browser-agent-notification-icon';
        icon.textContent = this.getStateIcon(state);
        icon.setAttribute('aria-hidden', 'true');
        header.appendChild(icon);

        // Title and status
        const titleContainer = document.createElement('div');
        titleContainer.className = 'browser-agent-notification-title-container';

        const title = document.createElement('span');
        title.className = 'browser-agent-notification-title';
        title.textContent = 'Browser Agent';
        titleContainer.appendChild(title);

        const status = document.createElement('span');
        status.className = 'browser-agent-notification-status';
        status.textContent = this.getStatusText(state, currentStep, totalSteps);
        titleContainer.appendChild(status);

        header.appendChild(titleContainer);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'browser-agent-notification-actions';

        // Expand/collapse button
        if (this.manager.isActive() || state === 'completed' || state === 'stopped') {
            const expandBtn = document.createElement('button');
            expandBtn.className = 'browser-agent-notification-btn expand-btn';
            expandBtn.setAttribute('aria-label', this.isExpanded ? 'Collapse' : 'Expand');
            expandBtn.textContent = this.isExpanded ? '▲' : '▼';
            expandBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleExpand();
            });
            actions.appendChild(expandBtn);
        }

        // Stop button (only when active)
        if (this.manager.isActive()) {
            const stopBtn = document.createElement('button');
            stopBtn.className = 'browser-agent-notification-btn stop-btn';
            stopBtn.setAttribute('aria-label', 'Stop browser agent');
            stopBtn.textContent = '✕';
            stopBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.manager.stop();
            });
            actions.appendChild(stopBtn);
        }

        // Close button (only when not active)
        if (!this.manager.isActive()) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'browser-agent-notification-btn close-btn';
            closeBtn.setAttribute('aria-label', 'Dismiss');
            closeBtn.textContent = '✕';
            closeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.hide();
            });
            actions.appendChild(closeBtn);
        }

        header.appendChild(actions);
        this.container.appendChild(header);

        // Progress bar (only when active)
        if (this.manager.isActive()) {
            const progressContainer = document.createElement('div');
            progressContainer.className = 'browser-agent-notification-progress';

            const progressBar = document.createElement('div');
            progressBar.className = 'browser-agent-notification-progress-bar';
            // Estimate progress (steps tend to be 5-15)
            const estimatedTotal = Math.max(totalSteps, 10);
            const progress = (totalSteps / estimatedTotal) * 100;
            progressBar.style.width = `${Math.min(progress, 95)}%`;

            progressContainer.appendChild(progressBar);
            this.container.appendChild(progressContainer);
        }

        // Expanded content
        if (this.isExpanded) {
            const expandedContent = document.createElement('div');
            expandedContent.className = 'browser-agent-notification-expanded';

            // Current goal
            if (currentStep?.goal) {
                const goalEl = document.createElement('div');
                goalEl.className = 'browser-agent-notification-goal';
                goalEl.innerHTML = `<strong>Goal:</strong> ${this.escapeHtml(currentStep.goal)}`;
                expandedContent.appendChild(goalEl);
            }

            // Current URL
            if (currentStep?.url) {
                const urlEl = document.createElement('div');
                urlEl.className = 'browser-agent-notification-url';
                urlEl.innerHTML = `<strong>URL:</strong> <a href="${this.escapeHtml(currentStep.url)}" target="_blank" rel="noopener">${this.truncateUrl(currentStep.url)}</a>`;
                expandedContent.appendChild(urlEl);
            }

            // Screenshot thumbnail
            if (currentStep?.thumbnail || currentStep?.screenshot) {
                const imgContainer = document.createElement('div');
                imgContainer.className = 'browser-agent-notification-screenshot';

                const img = document.createElement('img');
                img.src = `data:image/jpeg;base64,${currentStep.thumbnail || currentStep.screenshot}`;
                img.alt = `Screenshot at step ${currentStep.step}`;
                img.loading = 'lazy';

                imgContainer.appendChild(img);
                expandedContent.appendChild(imgContainer);
            }

            // Result (when completed)
            if ((state === 'completed' || state === 'stopped') && this.manager.result) {
                const resultEl = document.createElement('div');
                resultEl.className = 'browser-agent-notification-result';
                resultEl.innerHTML = `<strong>Result:</strong> ${this.escapeHtml(this.manager.result)}`;
                expandedContent.appendChild(resultEl);
            }

            // Session link (when completed)
            if ((state === 'completed' || state === 'stopped') && this.manager.sessionPath) {
                const linkEl = document.createElement('div');
                linkEl.className = 'browser-agent-notification-session';
                linkEl.innerHTML = `<strong>Session:</strong> <code>${this.escapeHtml(this.manager.sessionPath)}</code>`;
                expandedContent.appendChild(linkEl);
            }

            // Error message
            if (state === 'error' && this.manager.error) {
                const errorEl = document.createElement('div');
                errorEl.className = 'browser-agent-notification-error';
                errorEl.innerHTML = `<strong>Error:</strong> ${this.escapeHtml(this.manager.error)}`;
                expandedContent.appendChild(errorEl);
            }

            this.container.appendChild(expandedContent);
        }

        // Click to expand/collapse
        header.addEventListener('click', () => {
            if (this.manager.isActive() || state === 'completed' || state === 'stopped') {
                this.toggleExpand();
            }
        });
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        this.manager.addEventListener('state-change', () => {
            const state = this.manager.getState();

            if (state === 'starting' || state === 'running') {
                this.show();
            } else if (state === 'completed' || state === 'stopped' || state === 'error') {
                // Keep visible - user must dismiss manually via close button
                this.render();
            }
            // Note: We intentionally do NOT hide on 'idle' state
            // The notification stays visible until user clicks close button
        });

        this.manager.addEventListener('step', () => {
            if (this.isVisible) {
                this.render();
            }
        });

        this.manager.addEventListener('done', () => {
            this.render();
        });

        this.manager.addEventListener('error', () => {
            this.render();
        });
    }

    /**
     * Show the notification
     */
    show() {
        if (this.isVisible) return;

        this.isVisible = true;
        this.container.style.display = 'block';
        this.render();

        // Animate in
        setTimeout(() => {
            this.container.classList.add('show');
        }, 10);

        // Clear any pending auto-hide
        this.clearAutoHide();

        // Start update interval for timer
        this.startUpdateInterval();
    }

    /**
     * Hide the notification
     */
    hide() {
        if (!this.isVisible) return;

        this.clearAutoHide();
        this.stopUpdateInterval();

        // Animate out
        this.container.classList.remove('show');
        this.container.classList.add('hide');

        setTimeout(() => {
            this.isVisible = false;
            this.isExpanded = false;
            this.container.style.display = 'none';
            this.container.classList.remove('hide');
        }, 300);
    }

    /**
     * Toggle expanded state
     */
    toggleExpand() {
        this.isExpanded = !this.isExpanded;
        this.render();
    }

    /**
     * Schedule auto-hide
     * @param {number} delay - Delay in milliseconds
     */
    scheduleAutoHide(delay) {
        this.clearAutoHide();
        this.autoHideTimeout = setTimeout(() => {
            this.hide();
        }, delay);
    }

    /**
     * Clear auto-hide timeout
     */
    clearAutoHide() {
        if (this.autoHideTimeout) {
            clearTimeout(this.autoHideTimeout);
            this.autoHideTimeout = null;
        }
    }

    /**
     * Start update interval for timer display
     */
    startUpdateInterval() {
        this.stopUpdateInterval();
        this.updateInterval = setInterval(() => {
            if (this.manager.isActive()) {
                this.render();
            } else {
                this.stopUpdateInterval();
            }
        }, 1000);
    }

    /**
     * Stop update interval
     */
    stopUpdateInterval() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }
    }

    /**
     * Get state icon
     * @param {string} state
     * @returns {string}
     */
    getStateIcon(state) {
        switch (state) {
            case 'starting':
            case 'running':
                return '🌐';
            case 'paused':
                return '⏸';
            case 'completed':
                return '✓';
            case 'stopped':
                return '⏹';
            case 'error':
                return '✕';
            default:
                return '🌐';
        }
    }

    /**
     * Get status text
     * @param {string} state
     * @param {Object|null} currentStep
     * @param {number} totalSteps
     * @returns {string}
     */
    getStatusText(state, currentStep, totalSteps) {
        switch (state) {
            case 'starting':
                return 'Starting...';
            case 'running':
                if (currentStep?.goal) {
                    const goalText = currentStep.goal.length > 50
                        ? currentStep.goal.slice(0, 50) + '...'
                        : currentStep.goal;
                    return `Step ${totalSteps}: ${goalText}`;
                }
                return `Running (Step ${totalSteps})...`;
            case 'paused':
                return 'Paused';
            case 'completed':
                return `Completed (${totalSteps} steps)`;
            case 'stopped':
                return `Stopped (${totalSteps} steps)`;
            case 'error':
                return 'Error';
            default:
                return '';
        }
    }

    /**
     * Truncate URL for display
     * @param {string} url
     * @returns {string}
     */
    truncateUrl(url) {
        try {
            const urlObj = new URL(url);
            const path = urlObj.pathname + urlObj.search;
            if (path.length > 40) {
                return urlObj.hostname + path.slice(0, 40) + '...';
            }
            return urlObj.hostname + path;
        } catch {
            return url.length > 50 ? url.slice(0, 50) + '...' : url;
        }
    }

    /**
     * Escape HTML for safe display
     * @param {string} str
     * @returns {string}
     */
    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Get the container element
     * @returns {HTMLElement}
     */
    getElement() {
        return this.container;
    }

    /**
     * Destroy the notification
     */
    destroy() {
        this.clearAutoHide();
        this.stopUpdateInterval();

        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }

        this.container = null;
    }
}
