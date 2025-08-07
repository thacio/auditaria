/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

interface SubmitQueryContextValue {
  submitQuery: ((query: string) => void) | null;
  registerSubmitQuery: (fn: (query: string) => void) => void;
}

const SubmitQueryContext = createContext<SubmitQueryContextValue | null>(null);

interface SubmitQueryProviderProps {
  children: React.ReactNode;
}

export function SubmitQueryProvider({ children }: SubmitQueryProviderProps) {
  const [submitQuery, setSubmitQuery] = useState<((query: string) => void) | null>(null);

  const registerSubmitQuery = useCallback((fn: (query: string) => void) => {
    setSubmitQuery(() => fn);
  }, []);

  const contextValue: SubmitQueryContextValue = useMemo(() => ({
    submitQuery,
    registerSubmitQuery,
  }), [submitQuery, registerSubmitQuery]);

  return (
    <SubmitQueryContext.Provider value={contextValue}>
      {children}
    </SubmitQueryContext.Provider>
  );
}

export function useSubmitQuery(): ((query: string) => void) | null {
  const context = useContext(SubmitQueryContext);
  return context?.submitQuery || null;
}

export function useSubmitQueryRegistration(): (fn: (query: string) => void) => void {
  const context = useContext(SubmitQueryContext);
  if (!context) {
    throw new Error('useSubmitQueryRegistration must be used within SubmitQueryProvider');
  }
  return context.registerSubmitQuery;
}