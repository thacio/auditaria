/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
// WEB_INTERFACE_START: Import for multimodal support
import { type PartListUnion } from '@google/genai';
// WEB_INTERFACE_END

interface SubmitQueryContextValue {
  // WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
  submitQuery: ((query: PartListUnion) => void) | null;
  registerSubmitQuery: (fn: (query: PartListUnion) => void) => void;
  // WEB_INTERFACE_END
}

const SubmitQueryContext = createContext<SubmitQueryContextValue | null>(null);

interface SubmitQueryProviderProps {
  children: React.ReactNode;
}

export function SubmitQueryProvider({ children }: SubmitQueryProviderProps) {
  // WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
  const [submitQuery, setSubmitQuery] = useState<((query: PartListUnion) => void) | null>(null);

  const registerSubmitQuery = useCallback((fn: (query: PartListUnion) => void) => {
    setSubmitQuery(() => fn);
  }, []);
  // WEB_INTERFACE_END

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

// WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
export function useSubmitQuery(): ((query: PartListUnion) => void) | null {
  const context = useContext(SubmitQueryContext);
  return context?.submitQuery || null;
}

export function useSubmitQueryRegistration(): (fn: (query: PartListUnion) => void) => void {
  const context = useContext(SubmitQueryContext);
  if (!context) {
    throw new Error('useSubmitQueryRegistration must be used within SubmitQueryProvider');
  }
  return context.registerSubmitQuery;
}
// WEB_INTERFACE_END