/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { createServer, type Server } from 'node:http';
import type { HttpRouteRegistry, VirtualHost, WebLogger } from './types.js';

export interface ListenOptions {
  readonly port: number;
  /**
   * Bind host. `localhost` binds BOTH loopback addresses (`127.0.0.1` and
   * `::1`): browsers and Node resolve the name to either, and Node alone
   * would pick `::1` only.
   */
  readonly host: string;
  /** Ports tried after `port` before falling back to a random one. */
  readonly sequentialAttempts: number;
}

export interface ListenResult {
  /** The port actually bound. */
  readonly port: number;
  /** True when `port` differs from the requested one. */
  readonly usedFallback: boolean;
  /** Addresses actually bound (a secondary loopback address may be skipped). */
  readonly addresses: readonly string[];
}

/** requested, requested+1, …, requested+attempts (deduplicated, in range). */
export function buildPortCandidates(
  requested: number,
  sequentialAttempts: number,
): number[] {
  const candidates: number[] = [];
  for (let i = 0; i <= sequentialAttempts; i++) {
    const port = requested + i;
    if (port > 65535) break;
    candidates.push(port);
  }
  return candidates;
}

const LOOPBACK_NAMES: ReadonlySet<string> = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return LOOPBACK_NAMES.has(name) || name.startsWith('127.');
}

/** Addresses to bind for a configured host. */
export function resolveBindAddresses(host: string): string[] {
  return host.toLowerCase() === 'localhost' ? ['127.0.0.1', '::1'] : [host];
}

/**
 * Splits a `Host` header into a lower-case host name and an optional port.
 * Handles bracketed IPv6 literals (`[::1]:8629`).
 */
export function parseHostHeader(header: string | undefined): {
  hostname: string;
  port?: number;
} {
  const raw = (header ?? '').trim().toLowerCase();
  if (!raw) return { hostname: '' };
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return { hostname: raw };
    const hostname = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : undefined;
    return Number.isInteger(port) ? { hostname, port } : { hostname };
  }
  const colon = raw.lastIndexOf(':');
  if (colon === -1) return { hostname: raw };
  const port = Number(raw.slice(colon + 1));
  return Number.isInteger(port)
    ? { hostname: raw.slice(0, colon), port }
    : { hostname: raw };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** Bind failures of a secondary address that just mean "not available here". */
const SKIPPABLE_SECONDARY_ERRORS: ReadonlySet<string> = new Set([
  'EADDRNOTAVAIL',
  'EAFNOSUPPORT',
  'EINVAL',
]);

/**
 * Express app + Node HTTP server(s) with virtual hosts, the port-fallback
 * policy, dual loopback binding, and a shutdown that does not hang on
 * keep-alive connections.
 *
 * Virtual hosts are dispatched by the FIRST middleware, so nothing mounted
 * for the console (health, previews, static files) is reachable on them.
 */
export class WebHttpServer implements HttpRouteRegistry {
  readonly app: Express = express();
  private servers: Server[] = [];
  private readonly virtualHosts: VirtualHost[] = [];

  constructor(private readonly logger: WebLogger) {
    this.app.disable('x-powered-by');
    this.app.use((req, res, next) => this.dispatchHost(req, res, next));
  }

  /** The bound Node servers (one per bound address). */
  get nodeServers(): readonly Server[] {
    return this.servers;
  }

  /** The first bound Node server (kept for single-server callers). */
  get nodeServer(): Server | undefined {
    return this.servers[0];
  }

  get isListening(): boolean {
    return this.servers.some((server) => server.listening);
  }

  mount(handler: RequestHandler): void;
  mount(path: string, handler: RequestHandler): void;
  mount(pathOrHandler: string | RequestHandler, handler?: RequestHandler) {
    if (typeof pathOrHandler === 'string') {
      if (!handler) {
        throw new Error(`mount("${pathOrHandler}") requires a handler`);
      }
      this.app.use(pathOrHandler, handler);
    } else {
      this.app.use(pathOrHandler);
    }
  }

  mountHost(host: VirtualHost): void {
    if (this.virtualHosts.some((v) => v.name === host.name)) {
      throw new Error(`Virtual host "${host.name}" is already mounted`);
    }
    this.virtualHosts.push(host);
  }

  hasVirtualHost(hostname: string): boolean {
    return this.virtualHosts.some((v) => v.matches(hostname));
  }

  private dispatchHost(req: Request, res: Response, next: NextFunction): void {
    const { hostname } = parseHostHeader(req.headers.host);
    const virtualHost = this.virtualHosts.find((v) => v.matches(hostname));
    if (!virtualHost) {
      // Console responses: an artifact (or any other origin) must not be
      // able to frame the console.
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      next();
      return;
    }
    virtualHost.handler(req, res, (error?: unknown) => {
      if (error) {
        next(error);
      } else if (!res.headersSent) {
        res.status(404).type('text/plain').send('Not Found');
      }
    });
  }

  /**
   * Binds the first free port from the candidate list on every address of
   * the configured host, then falls back to a random port. Only EADDRINUSE
   * advances to the next candidate; any other bind error on the primary
   * address is fatal. A secondary address that is unavailable on this
   * machine (no IPv6, or its port taken) is skipped with a debug line.
   */
  async listen(options: ListenOptions): Promise<ListenResult> {
    if (this.servers.length > 0) {
      throw new Error('HTTP server is already listening');
    }
    const addresses = resolveBindAddresses(options.host);
    const candidates = buildPortCandidates(
      options.port,
      options.sequentialAttempts,
    );

    for (const port of candidates) {
      const result = await this.tryBindAll(port, addresses);
      if (result) {
        return { ...result, usedFallback: port !== options.port };
      }
      this.logger.debug(`Port ${port} is in use, trying the next one`);
    }

    try {
      const result = await this.tryBindAll(0, addresses);
      if (result) return { ...result, usedFallback: true };
      throw new Error('random port was reported in use');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to start web server on ports ${candidates.join(', ')} (all in use) and random fallback also failed: ${reason}`,
      );
    }
  }

  async close(): Promise<void> {
    const servers = this.servers;
    if (servers.length === 0) return;
    this.servers = [];
    await Promise.all(servers.map((server) => this.closeServer(server)));
  }

  /**
   * Binds `port` on every address. Returns null when the primary address
   * (or a secondary one) reports the port in use, after releasing what was
   * bound so far.
   */
  private async tryBindAll(
    port: number,
    addresses: readonly string[],
  ): Promise<Omit<ListenResult, 'usedFallback'> | null> {
    const bound: Server[] = [];
    const boundAddresses: string[] = [];
    let actualPort = port;

    for (const [index, address] of addresses.entries()) {
      try {
        const server = await this.listenOnce(actualPort, address);
        bound.push(server);
        boundAddresses.push(address);
        const boundInfo = server.address();
        if (!boundInfo || typeof boundInfo === 'string') {
          throw new Error('Failed to read the bound address');
        }
        actualPort = boundInfo.port;
      } catch (error) {
        const code = errorCode(error);
        if (index > 0 && code && SKIPPABLE_SECONDARY_ERRORS.has(code)) {
          this.logger.debug(`Skipping bind on ${address}: ${code}`);
          continue;
        }
        await Promise.all(bound.map((server) => this.closeServer(server)));
        if (code === 'EADDRINUSE') {
          if (index > 0) {
            // The primary got the port but a secondary address holds it:
            // treat the whole port as taken so both stacks stay in step.
            this.logger.debug(`Port ${actualPort} is in use on ${address}`);
          }
          return null;
        }
        throw error;
      }
    }

    this.servers = bound;
    return { port: actualPort, addresses: boundAddresses };
  }

  private listenOnce(port: number, host: string): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const server = createServer(this.app);
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        server.on('error', (error) =>
          this.logger.error('Web HTTP server error:', error),
        );
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  private closeServer(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Keep-alive sockets would otherwise hold `close()` open until they
      // time out; a stopped interface must release its port promptly.
      server.closeAllConnections();
    });
  }
}
