/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

export interface FooterData {
  targetDir: string;
  workingDirectory: string;
  branchName?: string;
  model: string;
  modelDisplayName: string;
  contextPercentage: number;
  contextUsedTokens: number;
  contextMaxTokens: number;
  contextLeftTokens: number;
  sandboxStatus: string;
  isSandboxed: boolean;
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

  const updateFooterData = useCallback((data: FooterData) => {
    setFooterData(data);
  }, []);

  // NOTE: Web interface broadcasting moved to App.tsx to avoid circular dependencies

  const contextValue: FooterContextValue = useMemo(() => ({
    footerData,
    updateFooterData,
  }), [footerData, updateFooterData]);

  return (
    <FooterContext.Provider value={contextValue}>
      {children}
    </FooterContext.Provider>
  );
}

export function useFooter(): FooterContextValue | null {
  return useContext(FooterContext);
}
