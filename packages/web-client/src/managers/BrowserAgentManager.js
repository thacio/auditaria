/**
 * Browser Agent Manager
 *
 * Manages browser agent state and communication with server.
 * Handles state machine transitions and UI updates.
 */

/**
 * Browser agent states
 * @typedef {'idle'|'starting'|'running'|'paused'|'stopped'|'completed'|'error'} BrowserAgentState
 */

/**
 * Step data from browser agent
 * @typedef {Object} BrowserAgentStep
 * @property {number} step
 * @property {string} timestamp
 * @property {string|null} url
 * @property {string|null} title
 * @property {string|null} goal
 * @property {string|null} action
 * @property {string|null} evaluation
 * @property {string|null} screenshotPath
 * @property {string} [screenshot] - Base64 encoded screenshot
 * @property {string} [thumbnail] - Base64 encoded thumbnail
 */

export class BrowserAgentManager extends EventTarget {
    constructor() {
        super();

        /** @type {BrowserAgentState} */
        this.state = 'idle';

        /** @type {string|null} */
        this.currentTask = null;

        /** @type {BrowserAgentStep[]} */
        this.steps = [];

        /** @type {string|null} */
        this.sessionPath = null;

        /** @type {string|null} */
        this.error = null;

        /** @type {string|null} */
        this.result = null;

        /** @type {number} */
        this.startTime = 0;

        /** @type {WebSocket|null} */
        this.wsManager = null;
    }

    /**
     * Initialize with WebSocket manager
     * @param {Object} wsManager - WebSocket manager instance
     */
    init(wsManager) {
        this.wsManager = wsManager;
        this.setupEventListeners();
    }

    /**
     * Set up WebSocket event listeners
     */
    setupEventListeners() {
        if (!this.wsManager) return;

        // State changes
        this.wsManager.addEventListener('browser_agent_state', (e) => {
            this.handleStateUpdate(e.detail);
        });

        // Step updates
        this.wsManager.addEventListener('browser_agent_step', (e) => {
            this.handleStep(e.detail);
        });

        // Completion
        this.wsManager.addEventListener('browser_agent_done', (e) => {
            this.handleDone(e.detail);
        });

        // Errors
        this.wsManager.addEventListener('browser_agent_error', (e) => {
            this.handleError(e.detail);
        });
    }

    /**
     * Start a browser agent task
     * @param {string} task - Task description
     * @param {Object} [options] - Additional options
     */
    start(task, options = {}) {
        if (this.state !== 'idle' && this.state !== 'completed' && this.state !== 'error' && this.state !== 'stopped') {
            console.warn(`Cannot start browser agent: currently ${this.state}`);
            return false;
        }

        // Reset state
        this.currentTask = task;
        this.steps = [];
        this.sessionPath = null;
        this.error = null;
        this.result = null;
        this.startTime = Date.now();

        // Send start message
        this.wsManager?.send({
            type: 'browser_agent_start',
            task: task,
            options: {
                headless: options.headless !== false,
                model: options.model || 'gemini-2.0-flash',
                screenshotMode: options.screenshotMode || 'all',
                maxSteps: options.maxSteps || 50,
            }
        });

        return true;
    }

    /**
     * Stop the current task
     */
    stop() {
        if (this.state !== 'running' && this.state !== 'starting') {
            return;
        }

        this.wsManager?.send({
            type: 'browser_agent_stop'
        });
    }

    /**
     * Request current status from server
     */
    requestStatus() {
        this.wsManager?.send({
            type: 'browser_agent_status'
        });
    }

    /**
     * Handle state update from server
     * @param {Object} data
     */
    handleStateUpdate(data) {
        const oldState = this.state;
        this.state = data.state || 'idle';

        if (data.task) {
            this.currentTask = data.task;
        }
        if (data.sessionPath) {
            this.sessionPath = data.sessionPath;
        }
        if (data.error) {
            this.error = data.error;
        }

        // Dispatch state change event
        this.dispatchEvent(new CustomEvent('state-change', {
            detail: {
                oldState,
                newState: this.state,
                task: this.currentTask,
                sessionPath: this.sessionPath,
                error: this.error,
            }
        }));
    }

    /**
     * Handle step update from server
     * @param {BrowserAgentStep} step
     */
    handleStep(step) {
        this.steps.push(step);

        // Dispatch step event
        this.dispatchEvent(new CustomEvent('step', {
            detail: {
                step,
                totalSteps: this.steps.length,
            }
        }));
    }

    /**
     * Handle completion from server
     * @param {Object} data
     */
    handleDone(data) {
        this.state = data.stopped ? 'stopped' : 'completed';
        this.result = data.result;
        this.sessionPath = data.sessionPath;

        // Dispatch done event
        this.dispatchEvent(new CustomEvent('done', {
            detail: {
                success: data.success,
                result: data.result,
                sessionPath: data.sessionPath,
                totalSteps: data.totalSteps,
                durationMs: data.durationMs,
                stopped: data.stopped,
            }
        }));
    }

    /**
     * Handle error from server
     * @param {Object} data
     */
    handleError(data) {
        this.state = 'error';
        this.error = data.message;

        // Dispatch error event
        this.dispatchEvent(new CustomEvent('error', {
            detail: {
                message: data.message,
                code: data.code,
            }
        }));
    }

    /**
     * Get current state
     * @returns {BrowserAgentState}
     */
    getState() {
        return this.state;
    }

    /**
     * Get current task
     * @returns {string|null}
     */
    getTask() {
        return this.currentTask;
    }

    /**
     * Get all steps
     * @returns {BrowserAgentStep[]}
     */
    getSteps() {
        return this.steps;
    }

    /**
     * Get current step
     * @returns {BrowserAgentStep|null}
     */
    getCurrentStep() {
        return this.steps.length > 0 ? this.steps[this.steps.length - 1] : null;
    }

    /**
     * Get elapsed time in milliseconds
     * @returns {number}
     */
    getElapsedTime() {
        if (this.startTime === 0) return 0;
        return Date.now() - this.startTime;
    }

    /**
     * Format elapsed time as MM:SS
     * @returns {string}
     */
    getElapsedTimeFormatted() {
        const elapsed = Math.floor(this.getElapsedTime() / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    /**
     * Check if browser agent is currently active
     * @returns {boolean}
     */
    isActive() {
        return this.state === 'starting' || this.state === 'running' || this.state === 'paused';
    }

    /**
     * Reset manager to idle state
     */
    reset() {
        this.state = 'idle';
        this.currentTask = null;
        this.steps = [];
        this.sessionPath = null;
        this.error = null;
        this.result = null;
        this.startTime = 0;
    }
}
