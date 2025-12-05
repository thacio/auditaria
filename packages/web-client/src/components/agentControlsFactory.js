/**
 * AUDITARIA_FEATURE: Agent Controls Factory
 *
 * Vanilla JavaScript factory for creating browser agent execution controls.
 * Shared between ToolRenderer and BrowserStreamViewer for consistent controls in both embedded and fullscreen modes.
 */

/**
 * Create agent execution control buttons
 * @param {string} sessionId - Browser session ID
 * @param {string} initialState - Initial execution state
 * @returns {HTMLElement} - Control panel element
 */
export function createAgentControls(sessionId, initialState) {
    const controlsEl = document.createElement('div');
    controlsEl.className = 'browser-agent-controls';

    // Import CSS dynamically
    if (!document.querySelector('link[href*="BrowserAgentControls.css"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/components/BrowserAgentControls.css';
        document.head.appendChild(link);
    }

    let currentState = initialState;
    let ws = null;
    let isHeadless = false;  // AUDITARIA: Track headless mode to hide takeover button

    // Create status display
    const statusEl = document.createElement('div');
    statusEl.className = 'control-status';
    statusEl.innerHTML = `
        <span class="status-label">Agent Status:</span>
        <span class="status-badge status-${currentState}">
            ${getStateIcon(currentState)} ${capitalize(currentState)}
        </span>
    `;

    // Create control buttons
    const buttonsEl = document.createElement('div');
    buttonsEl.className = 'control-buttons';

    const pauseBtn = createControlButton('pause', '⏸', 'Pause', 'Pause execution after current step completes');
    const resumeBtn = createControlButton('resume', '▶', 'Resume', 'Resume execution from paused state');
    const takeoverBtn = createControlButton('takeover', '👤', 'Take Over', 'Take manual control - browser becomes visible');
    const endTakeoverBtn = createControlButton('end_takeover', '🔙', 'End Takeover', 'Return control to agent - browser becomes headless');
    const stopBtn = createControlButton('stop', '⏹', 'Stop', 'Stop execution and return partial results');

    buttonsEl.appendChild(pauseBtn);
    buttonsEl.appendChild(resumeBtn);
    buttonsEl.appendChild(takeoverBtn);
    buttonsEl.appendChild(endTakeoverBtn);
    buttonsEl.appendChild(stopBtn);

    // Create hint message
    const hintEl = document.createElement('div');
    hintEl.className = 'control-hint';
    hintEl.style.display = 'none';

    controlsEl.appendChild(statusEl);
    controlsEl.appendChild(buttonsEl);
    controlsEl.appendChild(hintEl);

    // Update button states
    function updateButtonStates() {
        const isTransitioning = currentState === 'taking_over' || currentState === 'ending_takeover';

        pauseBtn.disabled = currentState !== 'running' || isTransitioning;
        resumeBtn.disabled = currentState !== 'paused' || isTransitioning;
        stopBtn.disabled = (currentState !== 'running' && currentState !== 'paused' && currentState !== 'taken_over') || isTransitioning;

        // AUDITARIA: Show/hide takeover buttons based on state AND headless mode
        // Takeover only available for headed (non-headless) browsers
        takeoverBtn.style.display = (!isHeadless && (currentState === 'running' || currentState === 'paused')) ? 'inline-flex' : 'none';
        endTakeoverBtn.style.display = (!isHeadless && currentState === 'taken_over') ? 'inline-flex' : 'none';
        takeoverBtn.disabled = isTransitioning;
        endTakeoverBtn.disabled = isTransitioning;

        // Update status badge
        const statusBadge = statusEl.querySelector('.status-badge');
        statusBadge.className = `status-badge status-${currentState}`;
        statusBadge.innerHTML = `${getStateIcon(currentState)} ${capitalize(currentState.replace('_', ' '))}`;

        // Update hint
        if (currentState === 'paused') {
            hintEl.textContent = 'Agent paused. Next step will resume when you click Resume.';
            hintEl.className = 'control-hint';
            hintEl.style.display = 'block';
        } else if (currentState === 'taking_over') {
            hintEl.textContent = '⏳ Switching to visible mode, please wait (3-4 seconds)...';
            hintEl.className = 'control-hint control-progress';
            hintEl.style.display = 'block';
        } else if (currentState === 'taken_over') {
            hintEl.innerHTML = '<strong>👤 Manual Control Active</strong><br>The browser window is now visible on your screen. You can interact with it normally.<br><small>If you don\'t see it, check your taskbar or press Alt+Tab (Windows) / Cmd+Tab (macOS).</small><br>Click <strong>"End Takeover"</strong> when you\'re done to return control to the agent.';
            hintEl.className = 'control-hint control-info';
            hintEl.style.display = 'block';
        } else if (currentState === 'ending_takeover') {
            hintEl.textContent = '⏳ Switching back to headless mode, please wait...';
            hintEl.className = 'control-hint control-progress';
            hintEl.style.display = 'block';
        } else if (currentState === 'stopping') {
            hintEl.textContent = 'Agent stopping... Please wait.';
            hintEl.className = 'control-hint';
            hintEl.style.display = 'block';
        } else {
            hintEl.style.display = 'none';
        }
    }

    // Connect to WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/control/agent/${sessionId}`;

    console.log('[AgentControls] Connecting to:', wsUrl);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('[AgentControls] Connected');
        ws.send(JSON.stringify({ action: 'get_state' }));
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.type === 'state') {
                console.log('[AgentControls] State update:', message.state, 'headless:', message.headless);
                currentState = message.state;
                // AUDITARIA: Update headless flag from server
                if (message.headless !== undefined) {
                    isHeadless = message.headless;
                }
                updateButtonStates();
            } else if (message.type === 'error') {
                console.error('[AgentControls] Server error:', message.message);
            }
        } catch (error) {
            console.error('[AgentControls] Error parsing message:', error);
        }
    };

    ws.onerror = (error) => {
        console.error('[AgentControls] WebSocket error:', error);
    };

    ws.onclose = () => {
        console.log('[AgentControls] Disconnected');
        currentState = 'unknown';
        updateButtonStates();
    };

    // Button click handlers
    function sendControl(action) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            console.log('[AgentControls] Sending action:', action);
            ws.send(JSON.stringify({ action }));
        } else {
            console.warn('[AgentControls] WebSocket not connected');
        }
    }

    pauseBtn.addEventListener('click', () => sendControl('pause'));
    resumeBtn.addEventListener('click', () => sendControl('resume'));
    takeoverBtn.addEventListener('click', () => sendControl('takeover'));
    endTakeoverBtn.addEventListener('click', () => sendControl('end_takeover'));
    stopBtn.addEventListener('click', () => sendControl('stop'));

    // Initial button state
    updateButtonStates();

    // Cleanup when element is removed
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.removedNodes) {
                if (node === controlsEl || node.contains(controlsEl)) {
                    console.log('[AgentControls] Cleaning up WebSocket');
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.close();
                    }
                    observer.disconnect();
                    break;
                }
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return controlsEl;
}

/**
 * Create a control button
 */
function createControlButton(action, icon, label, title) {
    const btn = document.createElement('button');
    btn.className = `control-btn ${action}-btn`;
    btn.title = title;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'btn-icon';
    iconSpan.textContent = icon;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'btn-label';
    labelSpan.textContent = label;

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);

    return btn;
}

/**
 * Get state icon
 */
function getStateIcon(state) {
    const icons = {
        running: '▶',
        paused: '⏸',
        stopping: '⏹',
        taking_over: '⏳',
        taken_over: '👤',
        ending_takeover: '⏳',
        unknown: '?'
    };
    return icons[state] || icons.unknown;
}

/**
 * Capitalize first letter
 */
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
