/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { ToolCallConfirmationDetails, ToolConfirmationOutcome } from '@thacio/auditaria-cli-core';

export interface PendingToolConfirmation {
  callId: string;
  toolName: string;
  confirmationDetails: ToolCallConfirmationDetails;
  timestamp: number;
}

interface ToolConfirmationContextValue {
  pendingConfirmations: PendingToolConfirmation[];
  addPendingConfirmation: (confirmation: PendingToolConfirmation) => void;
  removePendingConfirmation: (callId: string) => void;
  handleConfirmationResponse: (callId: string, outcome: ToolConfirmationOutcome, payload?: any) => void;
}

const ToolConfirmationContext = createContext<ToolConfirmationContextValue | null>(null);

interface ToolConfirmationProviderProps {
  children: React.ReactNode;
}

export function ToolConfirmationProvider({ children }: ToolConfirmationProviderProps) {
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingToolConfirmation[]>([]);

  const addPendingConfirmation = useCallback((confirmation: PendingToolConfirmation) => {
    setPendingConfirmations(prev => {
      // Remove any existing confirmation with the same callId to avoid duplicates
      const filtered = prev.filter(c => c.callId !== confirmation.callId);
      return [...filtered, confirmation];
    });
  }, []);

  const removePendingConfirmation = useCallback((callId: string) => {
    setPendingConfirmations(prev => prev.filter(c => c.callId !== callId));
  }, []);

  const handleConfirmationResponse = useCallback((callId: string, outcome: ToolConfirmationOutcome, payload?: any) => {
    setPendingConfirmations(prev => {
      const confirmation = prev.find(c => c.callId === callId);
      if (confirmation) {
        // Call the original confirmation handler
        confirmation.confirmationDetails.onConfirm(outcome, payload);
        // Remove the confirmation from pending list
        return prev.filter(c => c.callId !== callId);
      }
      return prev;
    });
  }, []);

  // NOTE: Web interface broadcasting moved to App.tsx to avoid circular dependencies

  const contextValue: ToolConfirmationContextValue = useMemo(() => ({
    pendingConfirmations,
    addPendingConfirmation,
    removePendingConfirmation,
    handleConfirmationResponse,
  }), [pendingConfirmations, addPendingConfirmation, removePendingConfirmation, handleConfirmationResponse]);

  return (
    <ToolConfirmationContext.Provider value={contextValue}>
      {children}
    </ToolConfirmationContext.Provider>
  );
}

export function useToolConfirmation(): ToolConfirmationContextValue | null {
  return useContext(ToolConfirmationContext);
}