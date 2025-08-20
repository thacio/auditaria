/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import React, { useCallback } from 'react';
import { TerminalCaptureProvider, type TerminalCaptureData } from '../contexts/TerminalCaptureContext.js';
import { useWebInterface } from '../contexts/WebInterfaceContext.js';

interface TerminalCaptureWrapperProps {
  children: React.ReactNode;
}

export function TerminalCaptureWrapper({ children }: TerminalCaptureWrapperProps) {
  const webInterface = useWebInterface();
  
  const handleTerminalUpdate = useCallback((data: TerminalCaptureData) => {
    // Broadcast terminal capture to web interface
    if (webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastTerminalCapture(data);
    }
  }, [webInterface]);
  
  return (
    <TerminalCaptureProvider onTerminalUpdate={handleTerminalUpdate}>
      {children}
    </TerminalCaptureProvider>
  );
}