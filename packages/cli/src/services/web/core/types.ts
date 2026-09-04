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

/**
 * A host name the server answers for besides the console's own. Requests
 * whose `Host` matches are handled ONLY by `handler` (never by the console
 * routes or static files) and get a 404 when it does not answer. WebSocket
 * upgrades on a virtual host reach only endpoints scoped to it.
 */
export interface VirtualHost {
  /** Diagnostic name, unique per server. */
  readonly name: string;
  /** Lower-case host name without port. */
  matches(hostname: string): boolean;
  readonly handler: RequestHandler;
}

/** Path-scoped WebSocket handler, e.g. the browser-agent stream socket. */
export interface WsEndpoint {
  /**
   * Route pattern matched against the upgrade request path. Segments
   * starting with `:` capture a parameter: `/stream/browser/:sessionId`.
   */
  readonly path: string;
  /**
   * Scope the endpoint to virtual hosts (lower-case host name without
   * port). Endpoints without `host` exist only on the console's hosts.
   * Upgrades on a virtual host must carry an `Origin` equal to that host.
   */
  host?(hostname: string): boolean;
  onConnection(
    ws: WebSocket,
    params: Readonly<Record<string, string>>,
    request: IncomingMessage,
  ): void | Promise<void>;
}

/** Registration surface for HTTP handlers. */
export interface HttpRouteRegistry {
  /** Mount a handler on the console hosts, optionally under a path prefix. */
  mount(handler: RequestHandler): void;
  mount(path: string, handler: RequestHandler): void;
  /** Serve a virtual host. */
  mountHost(host: VirtualHost): void;
}

/** Registration surface for path-scoped WebSocket endpoints. */
export interface WsEndpointRegistry {
  addEndpoint(endpoint: WsEndpoint): void;
}

/** Where the server ended up listening; handed to features on start. */
export interface ListenInfo {
  readonly port: number;
  /** The configured bind host (`localhost` means both loopback addresses). */
  readonly host: string;
  /** True when every bound address is a loopback address. */
  readonly loopback: boolean;
  /** Origins at which the console itself is reachable. */
  readonly consoleOrigins: readonly string[];
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
