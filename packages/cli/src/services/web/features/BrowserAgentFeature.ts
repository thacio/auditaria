/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_BROWSER_AGENT: live browser streaming + execution control sockets.

import { WebSocket, type RawData } from 'ws';
import {
  SessionManager,
  StreamManager,
  type StreamFrame,
} from '@thacio/browser-agent';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext, WebLogger } from '../core/types.js';
import { isRecord } from '../protocol.js';

type QualityPreset = NonNullable<Parameters<StreamManager['subscribe']>[3]>;
const QUALITY_PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high'];
const DEFAULT_QUALITY: QualityPreset = 'medium';

/** `/stream/browser/<sessionId>` — JPEG frames of the agent's browser. */
const STREAM_PATH = '/stream/browser/:sessionId';
/** `/control/agent/<sessionId>` — pause/resume/stop/takeover. */
const CONTROL_PATH = '/control/agent/:sessionId';

/** Binary frame header: timestamp (f64) + width (u16) + height (u16). */
const FRAME_HEADER_BYTES = 12;

interface StreamSubscription {
  readonly sessionId: string;
  readonly unsubscribe: () => Promise<void>;
}

function parseJson(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendError(ws: WebSocket, message: string): void {
  sendJson(ws, { type: 'error', message });
}

/**
 * Two path-scoped WebSocket endpoints for the browser agent, both keyed by
 * the agent session id and independent of the chat protocol:
 *
 *  - the stream socket subscribes to `StreamManager` and forwards frames as
 *    binary packets (header + JPEG), with quality/status/ping controls;
 *  - the control socket drives `SessionManager` (pause, resume, stop,
 *    takeover → headful, end takeover → headless + resume).
 */
export class BrowserAgentFeature extends WebFeature {
  readonly name = 'browser-agent';
  private streamManager: StreamManager | null = null;
  private readonly streamClients = new Map<WebSocket, StreamSubscription>();

  protected onAttach(ctx: WebFeatureContext): void {
    const streamManager = StreamManager.getInstance();
    streamManager.setPageResolver(async (sessionId) => {
      const sessions = SessionManager.getInstance();
      return sessions.hasSession(sessionId)
        ? sessions.getPage(sessionId)
        : null;
    });
    this.streamManager = streamManager;

    ctx.ws.addEndpoint({
      path: STREAM_PATH,
      onConnection: (ws, params) =>
        this.handleStreamConnection(ws, params['sessionId'], ctx.logger),
    });
    ctx.ws.addEndpoint({
      path: CONTROL_PATH,
      onConnection: (ws, params) =>
        this.handleControlConnection(ws, params['sessionId'], ctx.logger),
    });
  }

  protected async onDetach(): Promise<void> {
    for (const [ws, subscription] of this.streamClients) {
      try {
        await subscription.unsubscribe();
      } catch {
        // Ignore errors during cleanup.
      }
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    this.streamClients.clear();
    await this.streamManager?.stopAll();
    this.streamManager = null;
  }

  // ---------------------------------------------------------------------
  // Stream socket
  // ---------------------------------------------------------------------

  private async handleStreamConnection(
    ws: WebSocket,
    sessionId: string,
    logger: WebLogger,
  ): Promise<void> {
    const streamManager = this.streamManager;
    if (!streamManager) {
      sendError(ws, 'Stream manager not initialized');
      ws.close();
      return;
    }
    if (!SessionManager.getInstance().hasSession(sessionId)) {
      sendError(ws, `Session '${sessionId}' not found`);
      ws.close();
      return;
    }

    sendJson(ws, {
      type: 'connected',
      clientId: `stream-${Date.now()}`,
      sessionId,
      availableQualities: QUALITY_PRESETS,
    });

    try {
      const unsubscribe = await streamManager.subscribe(
        sessionId,
        `ws-${Date.now()}`,
        (frame) => this.sendStreamFrame(ws, frame, logger),
        DEFAULT_QUALITY,
      );
      this.streamClients.set(ws, { sessionId, unsubscribe });
      sendJson(ws, { type: 'started', sessionId });
    } catch (error) {
      logger.error('[BrowserStream] Error starting stream:', error);
      sendError(ws, error instanceof Error ? error.message : String(error));
      ws.close();
      return;
    }

    ws.on('message', (data) => {
      const message = parseJson(data);
      if (!message) return;
      this.handleStreamControl(ws, sessionId, message).catch((error: unknown) =>
        logger.error('[BrowserStream] Error handling message:', error),
      );
    });

    const release = async () => {
      const subscription = this.streamClients.get(ws);
      this.streamClients.delete(ws);
      await subscription?.unsubscribe();
    };
    ws.on('close', () => {
      logger.debug(`[BrowserStream] Client disconnected from ${sessionId}`);
      void release();
    });
    ws.on('error', (error) => {
      logger.error('[BrowserStream] WebSocket error:', error);
      void release();
    });
  }

  private sendStreamFrame(
    ws: WebSocket,
    frame: StreamFrame,
    logger: WebLogger,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const header = Buffer.alloc(FRAME_HEADER_BYTES);
      header.writeDoubleLE(frame.timestamp, 0);
      header.writeUInt16LE(frame.width, 8);
      header.writeUInt16LE(frame.height, 10);
      const image = Buffer.from(frame.data, 'base64');
      ws.send(Buffer.concat([header, image]), { binary: true });
    } catch (error) {
      logger.warn('[BrowserStream] Error sending frame:', error);
    }
  }

  private async handleStreamControl(
    ws: WebSocket,
    sessionId: string,
    message: Record<string, unknown>,
  ): Promise<void> {
    const streamManager = this.streamManager;
    if (!streamManager) return;

    switch (message['type']) {
      case 'set_quality': {
        const quality = message['quality'];
        if (typeof quality === 'string' && QUALITY_PRESETS.includes(quality)) {
          await streamManager.setQuality(sessionId, quality);
          sendJson(ws, { type: 'quality_changed', quality });
        }
        break;
      }
      case 'get_status':
        sendJson(ws, {
          type: 'status',
          status: streamManager.getStatus(sessionId),
        });
        break;
      case 'ping':
        sendJson(ws, { type: 'pong' });
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // Control socket
  // ---------------------------------------------------------------------

  private handleControlConnection(
    ws: WebSocket,
    sessionId: string,
    logger: WebLogger,
  ): void {
    const sessions = SessionManager.getInstance();

    // Without an explicit state, report the session's current one together
    // with `headless`, which tells the client whether to offer takeover.
    const sendState = (state?: string) => {
      if (state !== undefined) {
        sendJson(ws, { type: 'state', state, sessionId });
        return;
      }
      const info = sessions.getSessionInfo(sessionId);
      sendJson(ws, {
        type: 'state',
        state: info?.state ?? 'unknown',
        sessionId,
        headless: info?.headless ?? true,
      });
    };

    sendState();

    ws.on('message', (data) => {
      const message = parseJson(data);
      if (!message) return;
      try {
        switch (message['action']) {
          case 'pause':
            sessions.pauseExecution(sessionId);
            sendState('paused');
            break;
          case 'resume':
            sessions.resumeExecution(sessionId);
            sendState('running');
            break;
          case 'stop':
            sessions.stopExecution(sessionId);
            sendState('stopping');
            break;
          case 'takeover':
            void this.takeOver(ws, sessionId, sendState, logger);
            break;
          case 'end_takeover':
            void this.endTakeOver(ws, sessionId, sendState, logger);
            break;
          case 'get_state':
            sendState();
            break;
          default:
            sendError(ws, `Unknown action: ${String(message['action'])}`);
        }
      } catch (error) {
        logger.error('[AgentControl] Error handling message:', error);
        sendError(ws, error instanceof Error ? error.message : String(error));
      }
    });

    ws.on('error', (error) => {
      logger.error(
        `[AgentControl] WebSocket error for session ${sessionId}:`,
        error,
      );
    });
  }

  /** Pause and switch the browser to headful so the user can drive it. */
  private async takeOver(
    ws: WebSocket,
    sessionId: string,
    sendState: (state: string) => void,
    logger: WebLogger,
  ): Promise<void> {
    try {
      sendState('taking_over');
      await SessionManager.getInstance().takeOverSession(sessionId);
      sendState('taken_over');
      sendJson(ws, {
        type: 'takeover_ready',
        message: 'Browser is now visible. You can interact with it manually.',
      });
    } catch (error) {
      logger.error('[AgentControl] Takeover failed:', error);
      sendError(
        ws,
        error instanceof Error
          ? error.message || 'Takeover failed'
          : 'Takeover failed',
      );
    }
  }

  /** Back to headless; the session manager resumes the agent itself. */
  private async endTakeOver(
    ws: WebSocket,
    sessionId: string,
    sendState: (state: string) => void,
    logger: WebLogger,
  ): Promise<void> {
    try {
      sendState('ending_takeover');
      await SessionManager.getInstance().endTakeOver(sessionId);
      sendState('running');
      sendJson(ws, {
        type: 'takeover_ended',
        message: 'Browser minimized. Agent execution resumed automatically.',
      });
    } catch (error) {
      logger.error('[AgentControl] End takeover failed:', error);
      sendError(
        ws,
        error instanceof Error
          ? error.message || 'End takeover failed'
          : 'End takeover failed',
      );
    }
  }
}
