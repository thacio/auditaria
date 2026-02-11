/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WEB_INTERFACE_FEATURE: Browser Agent Execution Controls
 *
 * Provides pause/resume/stop controls for autonomous agent tasks.
 * Connects to WebSocket control channel at /control/agent/:sessionId
 */

import { useState, useEffect } from 'react';
import { showErrorToast } from './Toast.js';
import './BrowserAgentControls.css';

/**
 * BrowserAgentControls - Real-time control UI for agent execution
 *
 * Features:
 * - Live state updates via WebSocket
 * - Pause/Resume/Stop buttons
 * - Disabled state management based on current state
 * - Automatic reconnection handling
 *
 * @param {Object} props
 * @param {string} props.sessionId - Browser session ID (default: 'default')
 */
export function BrowserAgentControls({ sessionId = 'default' }) {
  const [state, setState] = useState('unknown');
  const [ws, setWs] = useState(null);
  const [connecting, setConnecting] = useState(true);
  const [takeoverMessage, setTakeoverMessage] = useState('');

  useEffect(() => {
    // Get WebSocket URL from current location
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/control/agent/${sessionId}`;

    console.log('[AgentControls] Connecting to:', wsUrl);

    // Connect to control WebSocket
    const websocket = new WebSocket(wsUrl);

    websocket.onopen = () => {
      console.log('[AgentControls] Connected');
      setConnecting(false);
      // Request current state
      websocket.send(JSON.stringify({ action: 'get_state' }));
    };

    websocket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'state') {
          console.log('[AgentControls] State update:', message.state);
          setState(message.state);
        } else if (message.type === 'takeover_ready') {
          setTakeoverMessage(message.message);
        } else if (message.type === 'takeover_ended') {
          setTakeoverMessage(message.message);
          setTimeout(() => setTakeoverMessage(''), 5000); // Clear after 5s
        } else if (message.type === 'error') {
          console.error('[AgentControls] Server error:', message.message);
          showErrorToast(message.message || 'Browser agent error');
        }
      } catch (error) {
        console.error('[AgentControls] Error parsing message:', error);
      }
    };

    websocket.onerror = (error) => {
      console.error('[AgentControls] WebSocket error:', error);
      setConnecting(false);
    };

    websocket.onclose = () => {
      console.log('[AgentControls] Disconnected');
      setConnecting(false);
      setState('unknown');
    };

    setWs(websocket);

    // Cleanup on unmount
    return () => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close();
      }
    };
  }, [sessionId]);

  const sendControl = (action) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      console.log('[AgentControls] Sending action:', action);
      ws.send(JSON.stringify({ action }));
    } else {
      console.warn('[AgentControls] WebSocket not connected');
    }
  };

  // Don't render controls if not in an active state
  const activeStates = ['running', 'paused', 'stopping', 'taking_over', 'taken_over', 'ending_takeover'];
  if (!activeStates.includes(state)) {
    return null;
  }

  // Determine if we're in a transition state
  const isTransitioning = state === 'taking_over' || state === 'ending_takeover';

  return (
    <div className="browser-agent-controls">
      <div className="control-status">
        <span className="status-label">Agent Status:</span>
        <span className={`status-badge status-${state}`}>
          {state === 'running' && '▶'}
          {state === 'paused' && '⏸'}
          {state === 'stopping' && '⏹'}
          {state === 'taking_over' && '⏳'}
          {state === 'taken_over' && '👤'}
          {state === 'ending_takeover' && '⏳'}
          {' '}
          {state.replace('_', ' ').charAt(0).toUpperCase() + state.replace('_', ' ').slice(1)}
        </span>
      </div>
      <div className="control-buttons">
        <button
          onClick={() => sendControl('pause')}
          disabled={state !== 'running' || isTransitioning}
          className="control-btn pause-btn"
          title="Pause execution after current step completes"
        >
          <span className="btn-icon">⏸</span>
          <span className="btn-label">Pause</span>
        </button>
        <button
          onClick={() => sendControl('resume')}
          disabled={state !== 'paused' || isTransitioning}
          className="control-btn resume-btn"
          title="Resume execution from paused state"
        >
          <span className="btn-icon">▶</span>
          <span className="btn-label">Resume</span>
        </button>

        {/* AUDITARIA_FEATURE: Takeover button - shown when running or paused */}
        {(state === 'running' || state === 'paused') && (
          <button
            onClick={() => sendControl('takeover')}
            disabled={isTransitioning}
            className="control-btn takeover-btn"
            title="Take manual control - browser becomes visible"
          >
            <span className="btn-icon">👤</span>
            <span className="btn-label">Take Over</span>
          </button>
        )}

        {/* AUDITARIA_FEATURE: End Takeover button - shown only when taken over */}
        {state === 'taken_over' && (
          <button
            onClick={() => sendControl('end_takeover')}
            disabled={isTransitioning}
            className="control-btn end-takeover-btn"
            title="Return control to agent - browser becomes headless"
          >
            <span className="btn-icon">🔙</span>
            <span className="btn-label">End Takeover</span>
          </button>
        )}

        <button
          onClick={() => sendControl('stop')}
          disabled={(state !== 'running' && state !== 'paused' && state !== 'taken_over') || isTransitioning}
          className="control-btn stop-btn"
          title="Stop execution and return partial results"
        >
          <span className="btn-icon">⏹</span>
          <span className="btn-label">Stop</span>
        </button>
      </div>
      {/* State-specific hints and messages */}
      {state === 'paused' && (
        <div className="control-hint">
          Agent paused. Next step will resume when you click Resume.
        </div>
      )}

      {state === 'taking_over' && (
        <div className="control-hint control-progress">
          ⏳ Switching to visible mode, please wait (3-4 seconds)...
        </div>
      )}

      {state === 'taken_over' && (
        <div className="control-hint control-info">
          <strong>👤 Manual Control Active</strong><br />
          The browser window is now visible on your screen. You can interact with it normally.<br />
          <small>If you don't see it, check your taskbar or press Alt+Tab (Windows) / Cmd+Tab (macOS).</small><br />
          {takeoverMessage && <em>{takeoverMessage}</em>}<br />
          Click <strong>"End Takeover"</strong> when you're done to return control to the agent.
        </div>
      )}

      {state === 'ending_takeover' && (
        <div className="control-hint control-progress">
          ⏳ Switching back to headless mode, please wait...
        </div>
      )}

      {state === 'stopping' && (
        <div className="control-hint">
          Agent stopping... Please wait.
        </div>
      )}
    </div>
  );
}
