/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { useWebInterface } from './WebInterfaceContext.js';

export interface FooterData {
  targetDir: string;
  branchName?: string;
  model: string;
  contextPercentage: number;
  sandboxStatus: string;
  errorCount: number;
  debugMode: boolean;
  debugMessage?: string;
  corgiMode: boolean;
  showMemoryUsage: boolean;
  nightly: boolean;
  showErrorDetails: boolean;
}

interface FooterContextValue {
  footerData: FooterData | null;
  updateFooterData: (data: FooterData) => void;
}

const FooterContext = createContext<FooterContextValue | null>(null);

interface FooterProviderProps {
  children: React.ReactNode;
}

export function FooterProvider({ children }: FooterProviderProps) {
  const [footerData, setFooterData] = useState<FooterData | null>(null);
  const webInterface = useWebInterface();

  const updateFooterData = useCallback((data: FooterData) => {
    setFooterData(data);
  }, []);

  // Broadcast footer data to web interface when it changes
  useEffect(() => {
    if (footerData && webInterface?.service && webInterface.isRunning) {
      // Send footer data via WebSocket using the service method
      webInterface.service.broadcastFooterData(footerData);
    }
  }, [footerData, webInterface?.service, webInterface?.isRunning]);

  const contextValue: FooterContextValue = {
    footerData,
    updateFooterData,
  };

  return (
    <FooterContext.Provider value={contextValue}>
      {children}
    </FooterContext.Provider>
  );
}

export function useFooter(): FooterContextValue | null {
  return useContext(FooterContext);
}