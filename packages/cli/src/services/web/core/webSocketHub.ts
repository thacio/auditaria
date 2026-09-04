/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_PER_MESSAGE_DEFLATE } from '../config.js';
import { readBoolean, readNumber } from '../protocol.js';
import type { Broadcaster } from './broadcaster.js';
import type { ClientRegistry } from './clientRegistry.js';
import { isLoopbackHost, parseHostHeader } from './httpServer.js';
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

/** What the hub must know about the listener to judge upgrade requests. */
export interface UpgradePolicyInfo {
  /** True when the server is bound to loopback addresses only. */
  readonly loopback: boolean;
  /** The bound port. */
  readonly port: number;
  /** Whether a (lower-case, port-less) host name is a virtual host. */
  isVirtualHost(hostname: string): boolean;
}

export type UpgradeVerdict =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly status: 403 | 404;
      readonly reason: string;
    };

/**
 * The upgrade policy, as a pure function so it can be tested exhaustively.
 *
 * Rules:
 *  - On a virtual host (an artifact origin) only endpoints scoped to that
 *    host exist, and the browser's `Origin` must be exactly that host.
 *    Nothing else — in particular never the chat socket — is served there.
 *  - On the console hosts, a browser's `Origin` must belong to the console:
 *    a loopback origin on the bound port when the server is bound to
 *    loopback (this closes DNS-rebinding hijacks of the chat socket), or
 *    the request's own host otherwise (reverse-proxied deployments).
 *    Requests without `Origin` are non-browser clients and pass.
 */
export function judgeUpgrade(
  info: UpgradePolicyInfo,
  hostHeader: string | undefined,
  origin: string | undefined,
  endpoint: WsEndpoint | undefined,
): UpgradeVerdict {
  const { hostname } = parseHostHeader(hostHeader);
  if (info.isVirtualHost(hostname)) {
    if (!endpoint || !endpoint.host) {
      return { allow: false, status: 404, reason: 'no such endpoint' };
    }
    if (
      !origin ||
      origin.toLowerCase() !== `http://${(hostHeader ?? '').toLowerCase()}`
    ) {
      return { allow: false, status: 403, reason: 'origin mismatch' };
    }
    return { allow: true };
  }

  if (endpoint?.host) {
    return { allow: false, status: 404, reason: 'endpoint is host-scoped' };
  }
  if (origin === undefined) {
    return { allow: true };
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { allow: false, status: 403, reason: 'malformed origin' };
  }
  const originPort = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  if (info.loopback) {
    if (isLoopbackHost(parsed.hostname) && originPort === info.port) {
      return { allow: true };
    }
    return { allow: false, status: 403, reason: 'foreign origin' };
  }
  const { port: hostPort } = parseHostHeader(hostHeader);
  if (
    parsed.hostname.toLowerCase() === hostname &&
    originPort === (hostPort ?? originPort)
  ) {
    return { allow: true };
  }
  return { allow: false, status: 403, reason: 'foreign origin' };
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

function isServerList(
  value: Server | readonly Server[],
): value is readonly Server[] {
  return Array.isArray(value);
}

interface UpgradeListener {
  readonly server: Server;
  readonly listener: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
}

/**
 * Owns the `ws` server. Every HTTP upgrade is judged by the policy above,
 * then routed by host and path to a registered endpoint (browser-agent
 * sockets, artifact runtimes, …); on the console hosts an unmatched path
 * is a chat client, which gets registered, wired to the inbound router,
 * and brought up to date. Also implements the transport-level resilience
 * messages (`ack`, `resync_request`, `force_resync`).
 */
export class WebSocketHub implements WsEndpointRegistry {
  private wss: WebSocketServer | undefined;
  private upgradeListeners: UpgradeListener[] = [];
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
    const scoped = endpoint.host !== undefined;
    if (
      this.endpoints.some(
        (e) => e.path === endpoint.path && (e.host !== undefined) === scoped,
      )
    ) {
      throw new Error(`WebSocket endpoint "${endpoint.path}" already exists`);
    }
    this.endpoints.push(endpoint);
  }

  /** Accepts upgrades on every given server under the policy. */
  attach(servers: Server | readonly Server[], info: UpgradePolicyInfo): void {
    if (this.wss) {
      throw new Error('WebSocket hub is already attached');
    }
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: WS_PER_MESSAGE_DEFLATE,
    });
    this.wss.on('error', (error) =>
      this.deps.logger.error('WebSocket server error:', error),
    );
    const list: readonly Server[] = isServerList(servers) ? servers : [servers];
    for (const server of list) {
      const listener = (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        this.handleUpgrade(req, socket, head, info);
      server.on('upgrade', listener);
      this.upgradeListeners.push({ server, listener });
    }
  }

  /** Closes every socket (chat and endpoint alike) and stops accepting. */
  close(): void {
    const wss = this.wss;
    if (!wss) return;
    this.wss = undefined;
    for (const { server, listener } of this.upgradeListeners) {
      server.off('upgrade', listener);
    }
    this.upgradeListeners = [];
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

  private findEndpoint(
    hostname: string,
    pathname: string,
    info: UpgradePolicyInfo,
  ): { endpoint: WsEndpoint; params: Record<string, string> } | undefined {
    const onVirtualHost = info.isVirtualHost(hostname);
    for (const endpoint of this.endpoints) {
      const inScope = endpoint.host ? endpoint.host(hostname) : !onVirtualHost;
      if (!inScope) continue;
      const params = matchWsRoute(endpoint.path, pathname);
      if (params) return { endpoint, params };
    }
    return undefined;
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    info: UpgradePolicyInfo,
  ): void {
    const wss = this.wss;
    if (!wss) {
      socket.destroy();
      return;
    }
    const hostHeader = request.headers.host;
    const { hostname } = parseHostHeader(hostHeader);
    const url = new URL(
      request.url || '/',
      `http://${hostHeader || 'localhost'}`,
    );
    const match = this.findEndpoint(hostname, url.pathname, info);
    const origin =
      typeof request.headers.origin === 'string'
        ? request.headers.origin
        : undefined;

    const verdict = judgeUpgrade(info, hostHeader, origin, match?.endpoint);
    if (!verdict.allow) {
      this.deps.logger.debug(
        `Refused WebSocket upgrade ${hostHeader ?? ''}${url.pathname} (${verdict.reason})`,
      );
      const text = verdict.status === 404 ? 'Not Found' : 'Forbidden';
      socket.write(
        `HTTP/1.1 ${verdict.status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      if (match) {
        Promise.resolve(
          match.endpoint.onConnection(ws, match.params, request),
        ).catch((error: unknown) => {
          this.deps.logger.error(
            `WebSocket endpoint "${match.endpoint.path}" failed:`,
            error,
          );
          this.closeSocket(ws);
        });
      } else {
        this.handleChatConnection(ws);
      }
    });
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
