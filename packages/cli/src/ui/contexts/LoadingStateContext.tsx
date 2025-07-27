/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useWebInterface } from './WebInterfaceContext.js';
import { StreamingState } from '../types.js';

export interface LoadingStateData {
  isLoading: boolean;
  streamingState: StreamingState;
  currentLoadingPhrase?: string;
  elapsedTime: number;
  thought?: string | null;
}

interface LoadingStateContextValue {
  loadingState: LoadingStateData | null;
  updateLoadingState: (data: LoadingStateData) => void;
}

const LoadingStateContext = createContext<LoadingStateContextValue | null>(null);

interface LoadingStateProviderProps {
  children: React.ReactNode;
}

export function LoadingStateProvider({ children }: LoadingStateProviderProps) {
  const [loadingState, setLoadingState] = useState<LoadingStateData | null>(null);
  const webInterface = useWebInterface();

  const updateLoadingState = useCallback((data: LoadingStateData) => {
    setLoadingState(data);
  }, []);

  // Broadcast loading state to web interface when it changes
  useEffect(() => {
    if (loadingState && webInterface?.service && webInterface.isRunning) {
      // Send loading state via WebSocket using the service method
      webInterface.service.broadcastLoadingState(loadingState);
    }
  }, [loadingState, webInterface?.service, webInterface?.isRunning]);

  const contextValue: LoadingStateContextValue = {
    loadingState,
    updateLoadingState,
  };

  return (
    <LoadingStateContext.Provider value={contextValue}>
      {children}
    </LoadingStateContext.Provider>
  );
}

export function useLoadingState(): LoadingStateContextValue | null {
  return useContext(LoadingStateContext);
}