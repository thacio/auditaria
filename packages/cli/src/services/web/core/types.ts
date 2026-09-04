/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { IncomingMessage } from 'node:http';
import type { RequestHandler } from 'express';
import type { WebSocket } from 'ws';
import type { ClientRegistry } from './clientRegistry.js';
import type { Broadcaster } from './broadcaster.js';
import type { InboundRouter } from './inboundRouter.js';

/**
 * Minimal logger contract so the transport core stays free of any
 * application dependency (the CLI injects core's `debugLogger`).
 */
export interface WebLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Path-scoped WebSocket handler, e.g. the browser-agent stream socket. */
export interface WsEndpoint {
  /**
   * Route pattern matched against the upgrade request path. Segments
   * starting with `:` capture a parameter: `/stream/browser/:sessionId`.
   */
  readonly path: string;
  onConnection(
    ws: WebSocket,
    params: Readonly<Record<string, string>>,
    request: IncomingMessage,
  ): void | Promise<void>;
}

/** Registration surface for HTTP handlers. */
export interface HttpRouteRegistry {
  /** Mount a handler, optionally under a path prefix. */
  mount(handler: RequestHandler): void;
  mount(path: string, handler: RequestHandler): void;
}

/** Registration surface for path-scoped WebSocket endpoints. */
export interface WsEndpointRegistry {
  addEndpoint(endpoint: WsEndpoint): void;
}

/**
 * Everything a feature needs while the server is running. Built once per
 * `start()` and handed to every feature's `attach()`.
 */
export interface WebFeatureContext {
  readonly workspaceRoot: string;
  readonly logger: WebLogger;
  readonly clients: ClientRegistry;
  readonly broadcaster: Broadcaster;
  readonly inbound: InboundRouter;
  readonly http: HttpRouteRegistry;
  readonly ws: WsEndpointRegistry;
}
