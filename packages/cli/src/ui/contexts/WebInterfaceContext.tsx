/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { WebInterfaceService, WebInterfaceConfig } from '../../services/WebInterfaceService.js';
import { HistoryItem } from '../types.js';

interface WebInterfaceContextValue {
  service: WebInterfaceService | null;
  isRunning: boolean;
  port: number | null;
  clientCount: number;
  start: (config?: WebInterfaceConfig) => Promise<number>;
  stop: () => Promise<void>;
  broadcastMessage: (historyItem: HistoryItem) => void;
}

const WebInterfaceContext = createContext<WebInterfaceContextValue | null>(null);

interface WebInterfaceProviderProps {
  children: React.ReactNode;
  enabled?: boolean;
}

export function WebInterfaceProvider({ children, enabled = false }: WebInterfaceProviderProps) {
  const [service] = useState(() => new WebInterfaceService());
  const [isRunning, setIsRunning] = useState(false);
  const [port, setPort] = useState<number | null>(null);
  const [clientCount, setClientCount] = useState(0);

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

  // Auto-start if enabled
  useEffect(() => {
    if (enabled && !isRunning) {
      console.log('Starting web interface...');
      start({ port: 8429 }) // Fixed port for consistency
        .then((port) => {
          console.log(`🌐 Web interface available at http://localhost:${port}`);
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
  }, [enabled, isRunning, start, stop]);

  // Periodic client count update
  useEffect(() => {
    if (!isRunning) return;

    const interval = setInterval(() => {
      const status = service.getStatus();
      setClientCount(status.clients);
    }, 5000);

    return () => clearInterval(interval);
  }, [service, isRunning]);

  const contextValue: WebInterfaceContextValue = {
    service,
    isRunning,
    port,
    clientCount,
    start,
    stop,
    broadcastMessage,
  };

  return (
    <WebInterfaceContext.Provider value={contextValue}>
      {children}
    </WebInterfaceContext.Provider>
  );
}

export function useWebInterface(): WebInterfaceContextValue | null {
  return useContext(WebInterfaceContext);
}