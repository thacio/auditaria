/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_PER_MESSAGE_DEFLATE } from '../config.js';
import { readBoolean, readNumber } from '../protocol.js';
import type { Broadcaster } from './broadcaster.js';
import type { ClientRegistry } from './clientRegistry.js';
import type { InboundRouter } from './inboundRouter.js';
import type { WebLogger, WsEndpoint, WsEndpointRegistry } from './types.js';

/** Close code for a server-initiated shutdown (RFC 6455 "going away"). */
const GOING_AWAY = 1001;

/**
 * Matches a `/a/:param/b` style pattern against a pathname. Returns the
 * captured parameters, or null when the pattern does not match.
 */
export function matchWsRoute(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternSegments = pattern.split('/').filter(Boolean);
  const pathSegments = pathname.split('/').filter(Boolean);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const expected = patternSegments[i];
    const actual = pathSegments[i];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

export interface WebSocketHubDeps {
  readonly clients: ClientRegistry;
  readonly broadcaster: Broadcaster;
  readonly inbound: InboundRouter;
  readonly logger: WebLogger;
  /**
   * Pushes the full current state to a chat client — on connect and when a
   * client has fallen too far behind for a gap replay (`force_resync`).
   */
  readonly sendInitialState: (ws: WebSocket) => void;
}

/**
 * Owns the `ws` server. Upgrade requests are routed by path to registered
 * endpoints (browser-agent stream/control sockets); everything else is a
 * chat client, which gets registered, wired to the inbound router, and
 * brought up to date. Also implements the transport-level resilience
 * messages (`ack`, `resync_request`, `force_resync`).
 */
export class WebSocketHub implements WsEndpointRegistry {
  private wss: WebSocketServer | undefined;
  private readonly endpoints: WsEndpoint[] = [];

  constructor(private readonly deps: WebSocketHubDeps) {
    deps.inbound.on('ack', (message, ws) => {
      const lastSequence = readNumber(message, 'lastSequence');
      if (lastSequence !== undefined) this.acknowledge(ws, lastSequence);
    });
    deps.inbound.on('resync_request', (message, ws) => {
      this.resync(
        ws,
        readNumber(message, 'from') ?? 0,
        readBoolean(message, 'persistentOnly') === true,
      );
    });
  }

  addEndpoint(endpoint: WsEndpoint): void {
    if (this.endpoints.some((e) => e.path === endpoint.path)) {
      throw new Error(`WebSocket endpoint "${endpoint.path}" already exists`);
    }
    this.endpoints.push(endpoint);
  }

  attach(server: Server): void {
    if (this.wss) {
      throw new Error('WebSocket hub is already attached');
    }
    this.wss = new WebSocketServer({
      server,
      perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
    });
    this.wss.on('connection', (ws, request) =>
      this.handleConnection(ws, request),
    );
    this.wss.on('error', (error) =>
      this.deps.logger.error('WebSocket server error:', error),
    );
  }

  /** Closes every socket (chat and endpoint alike) and stops accepting. */
  close(): void {
    const wss = this.wss;
    if (!wss) return;
    this.wss = undefined;
    for (const ws of this.deps.clients.removeAll()) {
      this.closeSocket(ws);
    }
    for (const ws of wss.clients) {
      this.closeSocket(ws);
    }
    wss.close();
  }

  private closeSocket(ws: WebSocket): void {
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close(GOING_AWAY, 'Server shutting down');
    }
  }

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const url = new URL(
      request.url || '/',
      `http://${request.headers.host || 'localhost'}`,
    );

    for (const endpoint of this.endpoints) {
      const params = matchWsRoute(endpoint.path, url.pathname);
      if (params) {
        Promise.resolve(endpoint.onConnection(ws, params, request)).catch(
          (error: unknown) => {
            this.deps.logger.error(
              `WebSocket endpoint "${endpoint.path}" failed:`,
              error,
            );
            this.closeSocket(ws);
          },
        );
        return;
      }
    }

    this.handleChatConnection(ws);
  }

  private handleChatConnection(ws: WebSocket): void {
    const { clients, inbound, logger } = this.deps;
    clients.add(ws);

    ws.on('close', () => {
      clients.remove(ws);
    });
    ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
      clients.remove(ws);
    });
    ws.on('message', (data) => inbound.dispatch(data, ws));

    this.deps.sendInitialState(ws);
  }

  private acknowledge(ws: WebSocket, lastSequence: number): void {
    const state = this.deps.clients.stateOf(ws);
    if (!state || lastSequence <= state.lastAcknowledgedSequence) return;
    state.lastAcknowledgedSequence = lastSequence;
    state.buffer.pruneAcknowledged(lastSequence);
  }

  private resync(
    ws: WebSocket,
    fromSequence: number,
    persistentOnly: boolean,
  ): void {
    const { clients, broadcaster } = this.deps;
    const state = clients.stateOf(ws);
    if (!state) return;

    const oldest = state.buffer.getOldestSequence();
    if (oldest !== null && fromSequence < oldest) {
      // Buffer overrun — the client is too far behind to replay.
      broadcaster.sendRaw(ws, {
        type: 'force_resync',
        currentSequence: broadcaster.currentSequence,
        timestamp: Date.now(),
      });
      this.deps.sendInitialState(ws);
      return;
    }

    for (const msg of state.buffer.getMessagesFrom(
      fromSequence,
      persistentOnly,
    )) {
      if (!broadcaster.replay(ws, msg.message)) break;
    }
  }
}
