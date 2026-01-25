/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type React from 'react';
import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import type {
  ToolCallConfirmationDetails,
  SerializableConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '@google/gemini-cli-core';

export interface PendingToolConfirmation {
  callId: string;
  toolName: string;
  confirmationDetails:
    | ToolCallConfirmationDetails
    | SerializableConfirmationDetails;
  timestamp: number;
  // Flags for web interface to determine which buttons to show
  isTrustedFolder?: boolean;
  allowPermanentApproval?: boolean;
}

interface ToolConfirmationContextValue {
  pendingConfirmations: PendingToolConfirmation[];
  addPendingConfirmation: (confirmation: PendingToolConfirmation) => void;
  removePendingConfirmation: (callId: string) => void;
  handleConfirmationResponse: (
    callId: string,
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => void;
}

const ToolConfirmationContext =
  createContext<ToolConfirmationContextValue | null>(null);

interface ToolConfirmationProviderProps {
  children: React.ReactNode;
}

export function ToolConfirmationProvider({
  children,
}: ToolConfirmationProviderProps) {
  const [pendingConfirmations, setPendingConfirmations] = useState<
    PendingToolConfirmation[]
  >([]);
  const pendingConfirmationsRef = useRef(pendingConfirmations);
  pendingConfirmationsRef.current = pendingConfirmations;

  const addPendingConfirmation = useCallback(
    (confirmation: PendingToolConfirmation) => {
      setPendingConfirmations((prev) => {
        // Remove any existing confirmation with the same callId to avoid duplicates
        const filtered = prev.filter((c) => c.callId !== confirmation.callId);
        return [...filtered, confirmation];
      });
    },
    [],
  );

  const removePendingConfirmation = useCallback((callId: string) => {
    setPendingConfirmations((prev) => prev.filter((c) => c.callId !== callId));
  }, []);

  const handleConfirmationResponse = useCallback(
    (
      callId: string,
      outcome: ToolConfirmationOutcome,
      payload?: ToolConfirmationPayload,
    ) => {
      const confirmationToHandle = pendingConfirmationsRef.current.find(
        (c) => c.callId === callId,
      );

      if (confirmationToHandle) {
        // Perform side effect outside of the state updater
        // onConfirm only exists on ToolCallConfirmationDetails, not SerializableConfirmationDetails
        const details = confirmationToHandle.confirmationDetails;
        if ('onConfirm' in details && typeof details.onConfirm === 'function') {
          void details.onConfirm(outcome, payload);
        }

        // Update state
        setPendingConfirmations((prev) =>
          prev.filter((c) => c.callId !== callId),
        );
      }
    },
    [],
  );

  // NOTE: Web interface broadcasting moved to App.tsx to avoid circular dependencies

  const contextValue: ToolConfirmationContextValue = useMemo(
    () => ({
      pendingConfirmations,
      addPendingConfirmation,
      removePendingConfirmation,
      handleConfirmationResponse,
    }),
    [
      pendingConfirmations,
      addPendingConfirmation,
      removePendingConfirmation,
      handleConfirmationResponse,
    ],
  );

  return (
    <ToolConfirmationContext.Provider value={contextValue}>
      {children}
    </ToolConfirmationContext.Provider>
  );
}

export function useToolConfirmation(): ToolConfirmationContextValue | null {
  return useContext(ToolConfirmationContext);
}
