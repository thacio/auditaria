/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
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

  const updateLoadingState = useCallback((data: LoadingStateData) => {
    setLoadingState(data);
  }, []);

  // NOTE: Web interface broadcasting moved to App.tsx to avoid circular dependencies

  const contextValue: LoadingStateContextValue = useMemo(() => ({
    loadingState,
    updateLoadingState,
  }), [loadingState, updateLoadingState]);

  return (
    <LoadingStateContext.Provider value={contextValue}>
      {children}
    </LoadingStateContext.Provider>
  );
}

export function useLoadingState(): LoadingStateContextValue | null {
  return useContext(LoadingStateContext);
}