/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { WebInterfaceConfig } from '../../services/WebInterfaceService.js';
import { WebInterfaceService } from '../../services/WebInterfaceService.js';
import type { HistoryItem } from '../types.js';
import { useSubmitQuery } from './SubmitQueryContext.js';
import { openBrowserWithDelay } from '../../utils/browserUtils.js';

interface WebInterfaceContextValue {
  service: WebInterfaceService | null;
  isRunning: boolean;
  port: number | null;
  clientCount: number;
  defaultPort: number;
  start: (config?: WebInterfaceConfig) => Promise<number>;
  stop: () => Promise<void>;
  broadcastMessage: (historyItem: HistoryItem) => void;
  broadcastPendingItem: (pendingItem: HistoryItem | null) => void;
  setCurrentHistory: (history: HistoryItem[]) => void;
}

const WebInterfaceContext = createContext<WebInterfaceContextValue | null>(null);

interface WebInterfaceProviderProps {
  children: React.ReactNode;
  enabled?: boolean;
  openBrowser?: boolean;
  port?: number;
}

export function WebInterfaceProvider({ children, enabled = false, openBrowser = true, port: configuredPort }: WebInterfaceProviderProps) {
  const [service] = useState(() => new WebInterfaceService());
  const [isRunning, setIsRunning] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [clientCount, setClientCount] = useState(0);
  const submitQuery = useSubmitQuery();
  const submitQueryRegistered = useRef(false);
  const defaultPort = configuredPort !== undefined ? configuredPort : 8629;

  const start = useCallback(async (config?: WebInterfaceConfig): Promise<number> => {
    try {
      const assignedPort = await service.start(config);
      setIsRunning(true);
      setPort(assignedPort);
      return assignedPort;
    } catch (error) {
      setIsRunning(false);
      setPort(null);
      throw error;
    }
  }, [service]);

  const stop = useCallback(async (): Promise<void> => {
    await service.stop();
    setIsRunning(false);
    setPort(null);
    setClientCount(0);
  }, [service]);

  const broadcastMessage = useCallback((historyItem: HistoryItem): void => {
    if (isRunning) {
      service.broadcastMessage(historyItem);
      // Update client count after broadcast (in case of disconnected clients)
      const status = service.getStatus();
      setClientCount(status.clients);
    }
  }, [service, isRunning]);

  const broadcastPendingItem = useCallback((pendingItem: HistoryItem | null): void => {
    if (isRunning) {
      service.broadcastPendingItem(pendingItem);
    }
  }, [service, isRunning]);

  const setCurrentHistory = useCallback((history: HistoryItem[]): void => {
    if (service) {
      service.setCurrentHistory(history);
    }
  }, [service]);

  // Auto-start if enabled
  useEffect(() => {
    if (enabled && !isRunning) {
      start({ port: defaultPort }) // Use configured port or default
        .then(async (port) => {
          // Open browser automatically when starting with --web flag (unless no-browser is specified)
          if (openBrowser) {
            try {
              await openBrowserWithDelay(`http://localhost:${port}`, 2000);
            } catch (error) {
              // Browser opening failed, but web interface is still running
              // Error will be handled in CLI message display
            }
          }
        })
        .catch((error) => {
          console.error('Failed to start web interface:', error);
        });
    }
    return () => {
      if (isRunning) {
        stop().catch(console.error);
      }
    };
  }, [enabled, isRunning, start, stop, openBrowser, defaultPort]);

  // Periodic client count update
  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      const status = service.getStatus();
      setClientCount(status.clients);
    }, 5000);

    return () => clearInterval(interval);
  }, [service, isRunning]);

  // NOTE: submitQuery registration moved to App.tsx to avoid infinite loop

  const contextValue: WebInterfaceContextValue = useMemo(() => ({
    service,
    isRunning,
    port,
    clientCount,
    defaultPort,
    start,
    stop,
    broadcastMessage,
    broadcastPendingItem,
    setCurrentHistory,
  }), [service, isRunning, port, clientCount, defaultPort, start, stop, broadcastMessage, broadcastPendingItem, setCurrentHistory]);

  return (
    <WebInterfaceContext.Provider value={contextValue}>
      {children}
    </WebInterfaceContext.Provider>
  );
}

export function useWebInterface(): WebInterfaceContextValue | null {
  return useContext(WebInterfaceContext);
}