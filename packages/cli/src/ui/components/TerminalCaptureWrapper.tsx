/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type React from 'react';
import { useCallback } from 'react';
import {
  TerminalCaptureProvider,
  type TerminalCaptureData,
} from '../contexts/TerminalCaptureContext.js';
import { useWebInterface } from '../contexts/WebInterfaceContext.js';

interface TerminalCaptureWrapperProps {
  children: React.ReactNode;
}

export function TerminalCaptureWrapper({
  children,
}: TerminalCaptureWrapperProps) {
  const webInterface = useWebInterface();

  const handleTerminalUpdate = useCallback(
    (data: TerminalCaptureData) => {
      // Broadcast terminal capture to web interface
      // Note: We call broadcastTerminalCapture even when !isRunning because:
      // 1. The service stores currentTerminalCapture for later
      // 2. When clients connect, sendInitialState sends the stored capture
      // This fixes the folder trust dialog not showing on startup
      if (webInterface?.service) {
        webInterface.service.broadcastTerminalCapture(data);
      }
    },
    [webInterface?.service],
  );

  return (
    <TerminalCaptureProvider onTerminalUpdate={handleTerminalUpdate}>
      {children}
    </TerminalCaptureProvider>
  );
}
