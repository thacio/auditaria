/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser Agent Panel Component (Agent Mode)
 *
 * A full-featured panel for explicit browser agent tasks.
 * Shows browser screenshot, status, controls, and step history.
 *
 * Features:
 * - Task input field
 * - Browser screenshot display
 * - Real-time step progress
 * - Control buttons (Start, Stop, Pause)
 * - Step history log
 * - Duration timer
 */
export class BrowserAgentPanel {
    /**
     * @param {import('../managers/BrowserAgentManager.js').BrowserAgentManager} manager
     */
    constructor(manager) {
        this.manager = manager;
        this.container = null;
        this.isVisible = false;
        this.updateInterval = null;

        this.createContainer();
        this.setupEventListeners();
    }

    /**
     * Create the panel container
     */
    createContainer() {
        this.container = document.createElement('div');
        this.container.className = 'browser-agent-panel';
        this.container.style.display = 'none';

        this.render();
    }

    /**
     * Render panel content
     */
    render() {
        const state = this.manager.getState();
        const steps = this.manager.getSteps();
        const currentStep = this.manager.getCurrentStep();

        this.container.innerHTML = '';
        // Preserve 'show' class to maintain visibility during re-renders
        const showClass = this.isVisible ? 'show' : '';
        this.container.className = `browser-agent-panel ${state} ${showClass}`.trim();

        // Header
        const header = this.createHeader();
        this.container.appendChild(header);

        // Main content
        const content = document.createElement('div');
        content.className = 'browser-agent-panel-content';

        // Left side: Browser view
        const browserView = this.createBrowserView(currentStep);
        content.appendChild(browserView);

        // Right side: Status panel
        const statusPanel = this.createStatusPanel(state, steps, currentStep);
        content.appendChild(statusPanel);

        this.container.appendChild(content);

        // Task input (shown when idle)
        if (state === 'idle' || state === 'completed' || state === 'stopped' || state === 'error') {
            const taskInput = this.createTaskInput();
            this.container.appendChild(taskInput);
        }
    }

    /**
     * Create header section
     * @returns {HTMLElement}
     */
    createHeader() {
        const header = document.createElement('div');
        header.className = 'browser-agent-panel-header';

        // Title
        const title = document.createElement('h2');
        title.className = 'browser-agent-panel-title';
        title.textContent = 'Browser Agent';
        header.appendChild(title);

        // Window controls
        const controls = document.createElement('div');
        controls.className = 'browser-agent-panel-controls';

        // Minimize button
        const minBtn = document.createElement('button');
        minBtn.className = 'browser-agent-panel-btn minimize-btn';
        minBtn.setAttribute('aria-label', 'Minimize');
        minBtn.textContent = '─';
        minBtn.addEventListener('click', () => this.minimize());
        controls.appendChild(minBtn);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'browser-agent-panel-btn close-btn';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => this.hide());
        controls.appendChild(closeBtn);

        header.appendChild(controls);
        return header;
    }

    /**
     * Create browser view section
     * @param {Object|null} currentStep
     * @returns {HTMLElement}
     */
    createBrowserView(currentStep) {
        const browserView = document.createElement('div');
        browserView.className = 'browser-agent-panel-browser';

        if (currentStep?.screenshot || currentStep?.thumbnail) {
            const img = document.createElement('img');
            img.className = 'browser-agent-panel-screenshot';
            img.src = `data:image/png;base64,${currentStep.screenshot || currentStep.thumbnail}`;
            img.alt = `Browser screenshot at step ${currentStep.step}`;
            browserView.appendChild(img);

            // URL bar
            if (currentStep.url) {
                const urlBar = document.createElement('div');
                urlBar.className = 'browser-agent-panel-urlbar';
                urlBar.textContent = currentStep.url;
                browserView.appendChild(urlBar);
            }
        } else {
            // Placeholder
            const placeholder = document.createElement('div');
            placeholder.className = 'browser-agent-panel-placeholder';
            placeholder.innerHTML = `
                <div class="browser-agent-panel-placeholder-icon">🌐</div>
                <div class="browser-agent-panel-placeholder-text">
                    ${this.manager.isActive() ? 'Waiting for screenshot...' : 'Start a task to see browser output'}
                </div>
            `;
            browserView.appendChild(placeholder);
        }

        return browserView;
    }

    /**
     * Create status panel section
     * @param {string} state
     * @param {Array} steps
     * @param {Object|null} currentStep
     * @returns {HTMLElement}
     */
    createStatusPanel(state, steps, currentStep) {
        const statusPanel = document.createElement('div');
        statusPanel.className = 'browser-agent-panel-status';

        // Status header
        const statusHeader = document.createElement('div');
        statusHeader.className = 'browser-agent-panel-status-header';

        const statusDot = document.createElement('span');
        statusDot.className = `browser-agent-panel-status-dot ${state}`;
        statusHeader.appendChild(statusDot);

        const statusText = document.createElement('span');
        statusText.className = 'browser-agent-panel-status-text';
        statusText.textContent = this.getStateText(state);
        statusHeader.appendChild(statusText);

        statusPanel.appendChild(statusHeader);

        // Stats row
        const stats = document.createElement('div');
        stats.className = 'browser-agent-panel-stats';

        const stepCount = document.createElement('div');
        stepCount.className = 'browser-agent-panel-stat';
        stepCount.innerHTML = `<span class="label">Steps:</span> <span class="value">${steps.length}</span>`;
        stats.appendChild(stepCount);

        const duration = document.createElement('div');
        duration.className = 'browser-agent-panel-stat';
        duration.innerHTML = `<span class="label">Duration:</span> <span class="value">${this.manager.getElapsedTimeFormatted()}</span>`;
        stats.appendChild(duration);

        statusPanel.appendChild(stats);

        // Current goal
        if (currentStep?.goal) {
            const goalSection = document.createElement('div');
            goalSection.className = 'browser-agent-panel-goal';

            const goalLabel = document.createElement('div');
            goalLabel.className = 'browser-agent-panel-section-label';
            goalLabel.textContent = 'Current Goal';
            goalSection.appendChild(goalLabel);

            const goalText = document.createElement('div');
            goalText.className = 'browser-agent-panel-goal-text';
            goalText.textContent = currentStep.goal;
            goalSection.appendChild(goalText);

            statusPanel.appendChild(goalSection);
        }

        // Step history
        const historySection = document.createElement('div');
        historySection.className = 'browser-agent-panel-history';

        const historyLabel = document.createElement('div');
        historyLabel.className = 'browser-agent-panel-section-label';
        historyLabel.textContent = 'Steps';
        historySection.appendChild(historyLabel);

        const historyList = document.createElement('div');
        historyList.className = 'browser-agent-panel-history-list';

        // Show steps in reverse order (newest first)
        const recentSteps = [...steps].reverse().slice(0, 10);
        for (const step of recentSteps) {
            const stepEl = document.createElement('div');
            stepEl.className = 'browser-agent-panel-step';

            const stepNum = document.createElement('span');
            stepNum.className = 'browser-agent-panel-step-num';
            stepNum.textContent = `${step.step}.`;
            stepEl.appendChild(stepNum);

            const stepText = document.createElement('span');
            stepText.className = 'browser-agent-panel-step-text';
            stepText.textContent = step.goal || step.action || 'Processing...';
            stepEl.appendChild(stepText);

            historyList.appendChild(stepEl);
        }

        if (steps.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'browser-agent-panel-step empty';
            emptyEl.textContent = 'No steps yet';
            historyList.appendChild(emptyEl);
        }

        historySection.appendChild(historyList);
        statusPanel.appendChild(historySection);

        // Control buttons
        const controls = document.createElement('div');
        controls.className = 'browser-agent-panel-action-buttons';

        if (this.manager.isActive()) {
            // Stop button
            const stopBtn = document.createElement('button');
            stopBtn.className = 'browser-agent-panel-action-btn stop';
            stopBtn.innerHTML = '<span class="icon">⏹</span> Stop';
            stopBtn.addEventListener('click', () => this.manager.stop());
            controls.appendChild(stopBtn);
        }

        statusPanel.appendChild(controls);

        // Result section (when completed/stopped)
        if ((state === 'completed' || state === 'stopped') && this.manager.result) {
            const resultSection = document.createElement('div');
            resultSection.className = 'browser-agent-panel-result';

            const resultLabel = document.createElement('div');
            resultLabel.className = 'browser-agent-panel-section-label';
            resultLabel.textContent = 'Result';
            resultSection.appendChild(resultLabel);

            const resultText = document.createElement('div');
            resultText.className = 'browser-agent-panel-result-text';
            resultText.textContent = this.manager.result;
            resultSection.appendChild(resultText);

            statusPanel.appendChild(resultSection);
        }

        // Error section
        if (state === 'error' && this.manager.error) {
            const errorSection = document.createElement('div');
            errorSection.className = 'browser-agent-panel-error';

            const errorLabel = document.createElement('div');
            errorLabel.className = 'browser-agent-panel-section-label';
            errorLabel.textContent = 'Error';
            errorSection.appendChild(errorLabel);

            const errorText = document.createElement('div');
            errorText.className = 'browser-agent-panel-error-text';
            errorText.textContent = this.manager.error;
            errorSection.appendChild(errorText);

            statusPanel.appendChild(errorSection);
        }

        return statusPanel;
    }

    /**
     * Create task input section
     * @returns {HTMLElement}
     */
    createTaskInput() {
        const inputSection = document.createElement('div');
        inputSection.className = 'browser-agent-panel-input';

        const inputContainer = document.createElement('div');
        inputContainer.className = 'browser-agent-panel-input-container';

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'browser-agent-panel-task-input';
        input.placeholder = 'Enter a task for the browser agent...';
        input.setAttribute('aria-label', 'Browser agent task');

        const submitBtn = document.createElement('button');
        submitBtn.className = 'browser-agent-panel-submit-btn';
        submitBtn.textContent = 'Start';
        submitBtn.disabled = true;

        input.addEventListener('input', () => {
            submitBtn.disabled = !input.value.trim();
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && input.value.trim()) {
                this.startTask(input.value.trim());
                input.value = '';
                submitBtn.disabled = true;
            }
        });

        submitBtn.addEventListener('click', () => {
            if (input.value.trim()) {
                this.startTask(input.value.trim());
                input.value = '';
                submitBtn.disabled = true;
            }
        });

        inputContainer.appendChild(input);
        inputContainer.appendChild(submitBtn);
        inputSection.appendChild(inputContainer);

        return inputSection;
    }

    /**
     * Start a task
     * @param {string} task
     */
    startTask(task) {
        this.manager.start(task, {
            headless: false // Show browser window for agent mode
            // Note: screenshotMode defaults to 'none' (no disk saving)
            // Screenshots are always sent to web interface for live viewing
        });
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        this.manager.addEventListener('state-change', () => {
            this.render();
        });

        this.manager.addEventListener('step', () => {
            this.render();
        });

        this.manager.addEventListener('done', () => {
            this.render();
            this.stopUpdateInterval();
        });

        this.manager.addEventListener('error', () => {
            this.render();
            this.stopUpdateInterval();
        });
    }

    /**
     * Show the panel
     */
    show() {
        if (this.isVisible) return;

        this.isVisible = true;
        this.container.style.display = 'flex';
        this.render();

        // Animate in
        setTimeout(() => {
            this.container.classList.add('show');
        }, 10);

        // Start update interval for timer
        this.startUpdateInterval();

        // Dispatch event
        this.dispatchEvent('show');
    }

    /**
     * Hide the panel
     */
    hide() {
        if (!this.isVisible) return;

        this.stopUpdateInterval();

        // Animate out
        this.container.classList.remove('show');
        this.container.classList.add('hide');

        setTimeout(() => {
            this.isVisible = false;
            this.container.style.display = 'none';
            this.container.classList.remove('hide');
        }, 300);

        // Dispatch event
        this.dispatchEvent('hide');
    }

    /**
     * Minimize the panel (show only title bar)
     */
    minimize() {
        this.container.classList.toggle('minimized');
    }

    /**
     * Toggle visibility
     */
    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
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
     * Get state text
     * @param {string} state
     * @returns {string}
     */
    getStateText(state) {
        switch (state) {
            case 'idle':
                return 'Ready';
            case 'starting':
                return 'Starting...';
            case 'running':
                return 'Running';
            case 'paused':
                return 'Paused';
            case 'completed':
                return 'Completed';
            case 'stopped':
                return 'Stopped';
            case 'error':
                return 'Error';
            default:
                return state;
        }
    }

    /**
     * Dispatch a custom event
     * @param {string} eventName
     * @param {any} [detail]
     */
    dispatchEvent(eventName, detail = null) {
        const event = new CustomEvent(`browser-agent-panel-${eventName}`, { detail });
        document.dispatchEvent(event);
    }

    /**
     * Get the container element
     * @returns {HTMLElement}
     */
    getElement() {
        return this.container;
    }

    /**
     * Check if panel is visible
     * @returns {boolean}
     */
    getIsVisible() {
        return this.isVisible;
    }

    /**
     * Destroy the panel
     */
    destroy() {
        this.stopUpdateInterval();

        if (this.container && this.container.parentNode) {
            this.container.parentNode.removeChild(this.container);
        }

        this.container = null;
    }
}
