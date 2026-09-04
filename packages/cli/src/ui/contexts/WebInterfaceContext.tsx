/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { debugLogger } from '@google/gemini-cli-core';
import {
  DEFAULT_WEB_PORT,
  WebInterfaceService,
  type WebInterfaceConfig,
} from '../../services/web/index.js';
import type { HistoryItem, ResponseBlock } from '../types.js';
import { openBrowserWithDelay } from '../../utils/browserUtils.js';

/** Grace period before opening the browser so the first paint finds a server. */
const OPEN_BROWSER_DELAY_MS = 2000;

export interface WebInterfaceContextValue {
  /** The session's server instance. Always present; check `isRunning`. */
  readonly service: WebInterfaceService;
  readonly isRunning: boolean;
  /** Bound port while running, otherwise null. */
  readonly port: number | null;
  readonly clientCount: number;
  /** Port `start()` tries first when none is given (`--port`, else 8629). */
  readonly defaultPort: number;
  /** Starts the server; resolves with the port actually bound. */
  start: (config?: WebInterfaceConfig) => Promise<number>;
  stop: () => Promise<void>;
  broadcastMessage: (historyItem: HistoryItem) => void;
  broadcastResponseState: (blocks: ResponseBlock[] | null) => void;
  setCurrentHistory: (history: HistoryItem[]) => void;
}

const WebInterfaceContext = createContext<WebInterfaceContextValue | null>(
  null,
);

interface WebInterfaceProviderProps {
  children: ReactNode;
  /** Start the server as soon as the provider mounts (`--web`). */
  enabled?: boolean;
  /** After an automatic start, open the UI in the default browser. */
  openBrowser?: boolean;
  /** Overrides the default port (`--port`). */
  port?: number;
}

/**
 * Owns the session's single `WebInterfaceService` and mirrors its lifecycle
 * into React state. The service is the source of truth: the provider
 * subscribes to its `started` / `stopped` / `clients` events, so the state
 * is right no matter which code path started or stopped the server, and the
 * client count follows connects and disconnects instead of a timer.
 */
export function WebInterfaceProvider({
  children,
  enabled = false,
  openBrowser = true,
  port: configuredPort,
}: WebInterfaceProviderProps) {
  const [service] = useState(() => new WebInterfaceService());
  const [status, setStatus] = useState(() => service.getStatus());
  const defaultPort = configuredPort ?? DEFAULT_WEB_PORT;

  useEffect(() => {
    const sync = () => setStatus(service.getStatus());
    service.on('started', sync);
    service.on('stopped', sync);
    service.on('clients', sync);
    sync();
    return () => {
      service.off('started', sync);
      service.off('stopped', sync);
      service.off('clients', sync);
    };
  }, [service]);

  const start = useCallback(
    (config?: WebInterfaceConfig) =>
      service.start({ ...config, port: config?.port ?? defaultPort }),
    [service, defaultPort],
  );

  const stop = useCallback(() => service.stop(), [service]);

  // Automatic start (`--web`): once per mount; the server stops on unmount.
  useEffect(() => {
    if (!enabled) return;
    let unmounted = false;
    service
      .start({ port: defaultPort })
      .then((port) => {
        if (unmounted || !openBrowser) return undefined;
        // A failure to open the browser is reported by the CLI message that
        // prints the URL, so it is not an error here.
        return openBrowserWithDelay(
          `http://localhost:${port}`,
          OPEN_BROWSER_DELAY_MS,
        ).catch(() => undefined);
      })
      .catch((error: unknown) => {
        debugLogger.error('Failed to start web interface:', error);
      });
    return () => {
      unmounted = true;
      service.stop().catch((error: unknown) => {
        debugLogger.error('Failed to stop web interface:', error);
      });
    };
  }, [enabled, openBrowser, defaultPort, service]);

  // All three are safe while stopped: the service records the state for
  // the clients that connect later.
  const broadcastMessage = useCallback(
    (historyItem: HistoryItem) => {
      service.broadcastMessage(historyItem);
    },
    [service],
  );

  const broadcastResponseState = useCallback(
    (blocks: ResponseBlock[] | null) => {
      service.broadcastResponseState(blocks);
    },
    [service],
  );

  const setCurrentHistory = useCallback(
    (history: HistoryItem[]) => {
      service.setCurrentHistory(history);
    },
    [service],
  );

  const value = useMemo<WebInterfaceContextValue>(
    () => ({
      service,
      isRunning: status.isRunning,
      port: status.port ?? null,
      clientCount: status.clients,
      defaultPort,
      start,
      stop,
      broadcastMessage,
      broadcastResponseState,
      setCurrentHistory,
    }),
    [
      service,
      status,
      defaultPort,
      start,
      stop,
      broadcastMessage,
      broadcastResponseState,
      setCurrentHistory,
    ],
  );

  return (
    <WebInterfaceContext.Provider value={value}>
      {children}
    </WebInterfaceContext.Provider>
  );
}

/** Null outside a provider (headless and non-interactive runs). */
export function useWebInterface(): WebInterfaceContextValue | null {
  return useContext(WebInterfaceContext);
}
