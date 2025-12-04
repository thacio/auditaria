/**
 * Browser Stream Viewer Component
 *
 * Displays real-time browser video stream in a canvas element.
 * Designed to be embedded within the ToolRenderer for browser agent tasks.
 * Supports click-to-fullscreen for better viewing and future takeover capability.
 */

import { createAgentControls } from './agentControlsFactory.js';

const QUALITIES = ['low', 'medium', 'high'];

/**
 * Parse binary frame packet
 * Format: 8-byte timestamp + 2-byte width + 2-byte height + JPEG data
 */
function parseFramePacket(buffer) {
  const view = new DataView(buffer);
  const timestamp = view.getFloat64(0, true); // little-endian
  const width = view.getUint16(8, true);
  const height = view.getUint16(10, true);
  const imageData = buffer.slice(12);

  return { timestamp, width, height, imageData };
}

/**
 * Create and manage browser stream viewer
 * @param {HTMLElement} container - Container element to render into
 * @param {string} sessionId - Browser session ID to stream
 * @param {object} options - Configuration options
 * @returns {object} - Control interface
 */
export function createBrowserStreamViewer(container, sessionId, options = {}) {
  const {
    wsUrl = `ws://${window.location.host}/stream/browser/${sessionId}`,
    quality = 'medium',
    onStatusChange = () => {},
    onError = () => {},
    showControls = true,
    agentStatus = null, // AUDITARIA: Agent execution status for showing pause/resume/stop controls
  } = options;

  // State
  let ws = null;
  let canvas = null;
  let ctx = null;
  let currentQuality = quality;
  let isConnected = false;
  let frameCount = 0;
  let lastFrameTime = 0;
  let fps = 0;
  let fpsInterval = null;
  let reconnectTimeout = null;
  let isDestroyed = false;
  let isFullscreen = false;
  let isFrozen = false;

  // Create DOM elements
  const wrapper = document.createElement('div');
  wrapper.className = 'browser-stream-wrapper';
  wrapper.innerHTML = `
    <div class="browser-stream-header" ${!showControls ? 'style="display:none"' : ''}>
      <span class="stream-status">Connecting...</span>
      <span class="stream-fps">-- FPS</span>
      <div class="stream-controls-right">
        <select class="stream-quality">
          ${QUALITIES.map(q =>
            `<option value="${q}" ${q === quality ? 'selected' : ''}>${q}</option>`
          ).join('')}
        </select>
        <button class="stream-fullscreen-btn" title="Toggle fullscreen (click stream to expand)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
          </svg>
        </button>
        <button class="stream-close-btn" title="Close (ESC)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="browser-stream-canvas-container">
      <canvas class="browser-stream-canvas"></canvas>
      <div class="browser-stream-overlay" style="display: none;">
        <span class="overlay-message">Connecting to browser stream...</span>
      </div>
      <div class="stream-expand-hint">Click to expand</div>
    </div>
  `;

  container.appendChild(wrapper);

  // AUDITARIA: Add agent execution controls if agent status is provided
  if (agentStatus && (agentStatus === 'running' || agentStatus === 'paused' || agentStatus === 'stopping')) {
    const agentControls = createAgentControls(sessionId, agentStatus);
    // Insert controls after header, before canvas container
    const header = wrapper.querySelector('.browser-stream-header');
    if (header && header.nextSibling) {
      wrapper.insertBefore(agentControls, header.nextSibling);
    } else {
      wrapper.appendChild(agentControls);
    }
  }

  // Get element references
  canvas = wrapper.querySelector('.browser-stream-canvas');
  ctx = canvas.getContext('2d');
  const statusEl = wrapper.querySelector('.stream-status');
  const fpsEl = wrapper.querySelector('.stream-fps');
  const qualitySelect = wrapper.querySelector('.stream-quality');
  const overlay = wrapper.querySelector('.browser-stream-overlay');
  const overlayMsg = wrapper.querySelector('.overlay-message');
  const canvasContainer = wrapper.querySelector('.browser-stream-canvas-container');
  const fullscreenBtn = wrapper.querySelector('.stream-fullscreen-btn');
  const closeBtn = wrapper.querySelector('.stream-close-btn');
  const expandHint = wrapper.querySelector('.stream-expand-hint');

  // Quality change handler
  if (qualitySelect) {
    qualitySelect.addEventListener('change', (e) => {
      currentQuality = e.target.value;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_quality', quality: currentQuality }));
      }
    });
  }

  // Fullscreen backdrop element
  let backdrop = null;
  let originalParent = null;

  // Fullscreen toggle
  function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    wrapper.classList.toggle('fullscreen', isFullscreen);
    document.body.classList.toggle('stream-fullscreen-active', isFullscreen);

    if (isFullscreen) {
      // Create backdrop and move wrapper into it
      originalParent = wrapper.parentNode;
      backdrop = document.createElement('div');
      backdrop.className = 'stream-fullscreen-backdrop';
      backdrop.addEventListener('click', (e) => {
        // Only close if clicking directly on backdrop, not on wrapper
        if (e.target === backdrop) {
          toggleFullscreen();
        }
      });
      document.body.appendChild(backdrop);
      backdrop.appendChild(wrapper);

      // Switch to higher quality
      if (currentQuality === 'low') {
        setQualityInternal('medium');
      }
    } else {
      // Move wrapper back to original parent and remove backdrop
      if (originalParent && backdrop) {
        originalParent.appendChild(wrapper);
        backdrop.remove();
        backdrop = null;
      }
    }
  }

  function setQualityInternal(q) {
    currentQuality = q;
    if (qualitySelect) {
      qualitySelect.value = q;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'set_quality', quality: q }));
    }
  }

  // Click on canvas to enter fullscreen (only when not already fullscreen)
  canvasContainer.addEventListener('click', (e) => {
    // Don't toggle if clicking on overlay
    if (e.target === overlay || overlay.contains(e.target)) {
      return;
    }
    // Only enter fullscreen, not exit (exit via ESC or clicking outside)
    if (!isFullscreen) {
      toggleFullscreen();
    }
  });

  // Fullscreen button click
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFullscreen();
    });
  }

  // Close button click (exits fullscreen)
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (isFullscreen) {
        toggleFullscreen();
      }
    });
  }

  // ESC key to exit fullscreen
  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && isFullscreen) {
      toggleFullscreen();
    }
  };
  document.addEventListener('keydown', handleKeyDown);

  // FPS counter
  fpsInterval = setInterval(() => {
    if (!isDestroyed) {
      fpsEl.textContent = `${fps} FPS`;
      fps = 0;
    }
  }, 1000);

  /**
   * Update status display
   */
  function updateStatus(status, className) {
    if (statusEl) {
      statusEl.textContent = status;
      statusEl.className = `stream-status ${className}`;
    }
  }

  /**
   * Connect to stream
   */
  function connect() {
    if (ws || isDestroyed) {
      return;
    }

    updateStatus('Connecting...', 'connecting');
    overlay.style.display = 'flex';
    overlayMsg.textContent = 'Connecting to browser stream...';

    try {
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
    } catch (error) {
      console.error('[BrowserStreamViewer] Failed to create WebSocket:', error);
      updateStatus('Error', 'error');
      overlay.style.display = 'flex';
      overlayMsg.textContent = 'Failed to connect';
      onError(error);
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      if (isDestroyed) {
        ws.close();
        return;
      }
      isConnected = true;
      updateStatus('Connected', 'connected');
      overlay.style.display = 'none';
      onStatusChange('connected');
    };

    ws.onmessage = (event) => {
      if (isDestroyed) return;

      if (event.data instanceof ArrayBuffer) {
        // Binary frame
        handleFrame(event.data);
      } else {
        // JSON message
        try {
          const msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch (e) {
          console.warn('[BrowserStreamViewer] Invalid JSON message:', e);
        }
      }
    };

    ws.onclose = () => {
      ws = null;
      isConnected = false;

      if (isDestroyed) return;

      updateStatus('Disconnected', 'disconnected');
      overlay.style.display = 'flex';
      overlayMsg.textContent = 'Connection lost. Reconnecting...';
      onStatusChange('disconnected');

      scheduleReconnect();
    };

    ws.onerror = (error) => {
      console.error('[BrowserStreamViewer] WebSocket error:', error);
      onError(error);
    };
  }

  /**
   * Schedule reconnection attempt
   */
  function scheduleReconnect() {
    if (isDestroyed || isFrozen || reconnectTimeout) return;

    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      if (!isDestroyed && !isFrozen) {
        connect();
      }
    }, 3000);
  }

  // Fixed canvas resolution for consistent display
  const CANVAS_WIDTH = 1280;
  const CANVAS_HEIGHT = 800;

  /**
   * Handle binary frame
   */
  function handleFrame(buffer) {
    try {
      const { imageData } = parseFramePacket(buffer);

      // Ensure canvas is at fixed resolution
      if (canvas.width !== CANVAS_WIDTH || canvas.height !== CANVAS_HEIGHT) {
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
      }

      // Create blob and draw to canvas
      const blob = new Blob([imageData], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = new Image();

      img.onload = () => {
        if (!isDestroyed && ctx) {
          // Clear canvas with black background
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

          // Validate image dimensions
          if (img.width > 0 && img.height > 0) {
            // Calculate scaling to fit while maintaining aspect ratio (contain)
            const scale = Math.min(CANVAS_WIDTH / img.width, CANVAS_HEIGHT / img.height);
            const scaledWidth = img.width * scale;
            const scaledHeight = img.height * scale;
            const x = (CANVAS_WIDTH - scaledWidth) / 2;
            const y = (CANVAS_HEIGHT - scaledHeight) / 2;

            ctx.drawImage(img, x, y, scaledWidth, scaledHeight);
          } else {
            console.warn('[BrowserStreamViewer] Invalid image dimensions:', img.width, img.height);
          }
        }
        URL.revokeObjectURL(url);

        frameCount++;
        fps++;
        lastFrameTime = Date.now();
      };

      img.onerror = (e) => {
        console.error('[BrowserStreamViewer] Image load error:', e);
        URL.revokeObjectURL(url);
      };

      img.src = url;
    } catch (error) {
      console.warn('[BrowserStreamViewer] Error handling frame:', error);
    }
  }

  /**
   * Handle JSON message
   */
  function handleMessage(msg) {
    switch (msg.type) {
      case 'connected':
        console.log('[BrowserStreamViewer] Stream connected:', msg);
        break;

      case 'started':
        updateStatus('Streaming', 'streaming');
        overlay.style.display = 'none';
        break;

      case 'stopped':
        updateStatus('Stopped', 'stopped');
        overlay.style.display = 'flex';
        overlayMsg.textContent = 'Stream stopped';
        break;

      case 'error':
        console.error('[BrowserStreamViewer] Stream error:', msg.message);
        overlay.style.display = 'flex';
        overlayMsg.textContent = msg.message;
        onError(new Error(msg.message));
        break;

      case 'status':
        console.log('[BrowserStreamViewer] Stream status:', msg.status);
        break;

      case 'quality_changed':
        console.log('[BrowserStreamViewer] Quality changed to:', msg.quality);
        break;

      case 'pong':
        // Heartbeat response
        break;
    }
  }

  /**
   * Disconnect from stream
   */
  function disconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }

    if (ws) {
      ws.close();
      ws = null;
    }
    isConnected = false;
  }

  /**
   * Freeze the viewer - disconnect but keep last frame visible
   * Used when task completes to preserve the final state
   */
  function freeze() {
    isFrozen = true;
    disconnect();

    // Hide overlay to show last frame
    overlay.style.display = 'none';

    // Update status to show frozen state
    updateStatus('Completed', 'completed');

    // Hide expand hint since we're frozen
    if (expandHint) {
      expandHint.style.display = 'none';
    }
  }

  /**
   * Destroy the viewer completely
   */
  function destroy() {
    isDestroyed = true;
    disconnect();

    // Exit fullscreen if active
    if (isFullscreen) {
      document.body.classList.remove('stream-fullscreen-active');
    }

    // Remove event listeners
    document.removeEventListener('keydown', handleKeyDown);

    // Remove backdrop if exists
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }

    if (fpsInterval) {
      clearInterval(fpsInterval);
      fpsInterval = null;
    }

    wrapper.remove();
  }

  // Start connection
  connect();

  // Return control interface
  return {
    connect,
    disconnect,
    freeze,
    destroy,
    toggleFullscreen,
    isFullscreen: () => isFullscreen,
    isFrozen: () => isFrozen,
    setQuality: setQualityInternal,
    getStats: () => ({
      isConnected,
      frameCount,
      fps,
      quality: currentQuality,
      isFullscreen,
      isFrozen,
    }),
    getWrapper: () => wrapper,
  };
}

/**
 * Create a minimal embedded stream viewer for ToolRenderer
 * @param {string} sessionId - Browser session ID
 * @param {string} agentStatus - Optional agent execution status for controls
 * @returns {HTMLElement} - The viewer wrapper element
 */
export function createEmbeddedStreamViewer(sessionId, agentStatus = null) {
  const container = document.createElement('div');
  container.className = 'embedded-stream-container';

  // Create viewer with minimal controls
  const viewer = createBrowserStreamViewer(container, sessionId, {
    showControls: true,
    quality: 'medium', // Start with medium quality for embedded view
    agentStatus: agentStatus, // AUDITARIA: Pass agent status for pause/resume/stop controls
  });

  // Store viewer reference for cleanup
  container._streamViewer = viewer;

  return container;
}

/**
 * Cleanup an embedded stream viewer
 * @param {HTMLElement} container - Container with the viewer
 */
export function destroyEmbeddedStreamViewer(container) {
  if (container && container._streamViewer) {
    container._streamViewer.destroy();
    container._streamViewer = null;
  }
}

/**
 * Freeze an embedded stream viewer - keep last frame visible
 * @param {HTMLElement} container - Container with the viewer
 */
export function freezeEmbeddedStreamViewer(container) {
  if (container && container._streamViewer) {
    container._streamViewer.freeze();
  }
}
