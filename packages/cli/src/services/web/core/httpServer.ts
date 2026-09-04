/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import express, { type Express, type RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { HttpRouteRegistry, WebLogger } from './types.js';

export interface ListenOptions {
  readonly port: number;
  readonly host: string;
  /** Ports tried after `port` before falling back to a random one. */
  readonly sequentialAttempts: number;
}

export interface ListenResult {
  /** The port actually bound. */
  readonly port: number;
  /** True when `port` differs from the requested one. */
  readonly usedFallback: boolean;
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

function isAddressInUse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EADDRINUSE'
  );
}

/**
 * Express app + Node HTTP server with the port-fallback policy and a
 * shutdown that does not hang on keep-alive connections.
 */
export class WebHttpServer implements HttpRouteRegistry {
  readonly app: Express = express();
  private server: Server | undefined;

  constructor(private readonly logger: WebLogger) {
    this.app.disable('x-powered-by');
  }

  /** The underlying Node server (needed to attach the WebSocket server). */
  get nodeServer(): Server | undefined {
    return this.server;
  }

  get isListening(): boolean {
    return this.server?.listening === true;
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

  /**
   * Binds the first free port from the candidate list, then falls back to a
   * random port. Only EADDRINUSE advances to the next candidate; any other
   * bind error (EACCES, bad host, …) is fatal and surfaces immediately.
   */
  async listen(options: ListenOptions): Promise<ListenResult> {
    if (this.server) {
      throw new Error('HTTP server is already listening');
    }
    const candidates = buildPortCandidates(
      options.port,
      options.sequentialAttempts,
    );

    for (const port of candidates) {
      try {
        this.server = await this.listenOnce(port, options.host);
        return { port: this.boundPort(), usedFallback: port !== options.port };
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
        this.logger.debug(`Port ${port} is in use, trying the next one`);
      }
    }

    try {
      this.server = await this.listenOnce(0, options.host);
      return { port: this.boundPort(), usedFallback: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to start web server on ports ${candidates.join(', ')} (all in use) and random fallback also failed: ${reason}`,
      );
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      // Keep-alive sockets would otherwise hold `close()` open until they
      // time out; a stopped interface must release its port promptly.
      server.closeAllConnections();
    });
  }

  private listenOnce(port: number, host: string): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const server = this.app.listen(port, host);
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
    });
  }

  private boundPort(): number {
    const address = this.server?.address();
    if (!address || typeof address === 'string') {
      throw new Error(
        `Failed to get server address. Address type: ${typeof address}, value: ${String(address)}`,
      );
    }
    return address.port;
  }
}
