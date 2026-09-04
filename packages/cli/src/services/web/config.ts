/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { WebLogger } from './core/types.js';

/** Fixed default port so bookmarks and platform deployments stay predictable. */
export const DEFAULT_WEB_PORT = 8629;

/**
 * Ports tried after the requested one before falling back to a random port.
 * Order: requested → requested+1 … requested+N → random. Keeps ports
 * predictable for platform deployments (Docker publishes a range).
 */
export const SEQUENTIAL_PORT_ATTEMPTS = 4;

export const DEFAULT_WEB_HOST = 'localhost';

/** Environment override for the bind host (container deployments). */
export const WEB_HOST_ENV_VAR = 'AUDITARIA_WEB_HOST';

/** Sequenced messages kept per client for gap recovery. */
export const MESSAGE_BUFFER_SIZE = 200;

/**
 * Per-message deflate tuned for many small JSON messages: cheap compression
 * level, small windows, and no context takeover so memory stays bounded per
 * connection.
 */
export const WS_PER_MESSAGE_DEFLATE = {
  zlibDeflateOptions: {
    chunkSize: 1024,
    memLevel: 7,
    level: 3,
  },
  zlibInflateOptions: {
    chunkSize: 10 * 1024,
  },
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
  serverMaxWindowBits: 10,
  concurrencyLimit: 10,
  /** Messages below this size (bytes) are sent uncompressed. */
  threshold: 1024,
} as const;

export interface WebInterfaceConfig {
  port?: number;
  host?: string;
}

export interface ListenTarget {
  readonly port: number;
  readonly host: string;
}

export function isValidPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= 0 &&
    port <= 65535
  );
}

/**
 * Resolves the requested listen target: caller config wins, then the host
 * environment override, then the defaults. An invalid port is reported and
 * replaced by the default rather than failing the start.
 */
export function resolveListenTarget(
  config: WebInterfaceConfig,
  env: NodeJS.ProcessEnv = process.env,
  logger?: WebLogger,
): ListenTarget {
  let port = DEFAULT_WEB_PORT;
  // Port 0 / undefined / null all mean "use the default" — a random port is
  // only ever the last-resort fallback, never something a caller asks for.
  if (config.port) {
    if (isValidPort(config.port)) {
      port = config.port;
    } else {
      logger?.warn(
        `Invalid port number: ${String(config.port)}. Port must be between 0-65535. Using ${DEFAULT_WEB_PORT}.`,
      );
    }
  }
  const host = config.host || env[WEB_HOST_ENV_VAR] || DEFAULT_WEB_HOST;
  return { port, host };
}
