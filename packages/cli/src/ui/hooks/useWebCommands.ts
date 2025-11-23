/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { useCallback } from 'react';
import { useWebInterface } from '../contexts/WebInterfaceContext.js';

export interface WebCommandResult {
  type: 'message';
  messageType: 'info' | 'error';
  content: string;
  port?: number;
}

export function useWebCommands() {
  const webInterface = useWebInterface();

  const handleWebStart = useCallback(async (portStr?: string): Promise<WebCommandResult> => {
    if (!webInterface) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Web interface is not available in this configuration',
      };
    }

    try {
      if (webInterface.isRunning) {
        return {
          type: 'message',
          messageType: 'info',
          content: `Web interface is already running on port ${webInterface.port?.toString() || 'unknown'}`,
          port: webInterface.port || undefined,
        };
      }

      const port = portStr ? parseInt(portStr, 10) : webInterface.defaultPort;
      const assignedPort = await webInterface.start({ port });

      return {
        type: 'message',
        messageType: 'info',
        content: `Web interface started on http://localhost:${assignedPort.toString()}`,
        port: assignedPort,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to start web interface: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }, [webInterface]);

  const handleWebStop = useCallback(async (): Promise<WebCommandResult> => {
    if (!webInterface) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Web interface is not available in this configuration',
      };
    }

    try {
      if (!webInterface.isRunning) {
        return {
          type: 'message',
          messageType: 'info',
          content: 'Web interface is not currently running',
        };
      }

      await webInterface.stop();

      return {
        type: 'message',
        messageType: 'info',
        content: 'Web interface stopped',
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to stop web interface: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }, [webInterface]);

  const handleWebStatus = useCallback((): WebCommandResult => {
    if (!webInterface) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Web interface is not available in this configuration',
      };
    }

    if (webInterface.isRunning) {
      return {
        type: 'message',
        messageType: 'info',
        content: `Web interface is running on port ${webInterface.port?.toString() || 'unknown'} with ${webInterface.clientCount.toString()} connected client(s)`,
      };
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Web interface is not running',
      };
    }
  }, [webInterface]);

  return {
    handleWebStart,
    handleWebStop,
    handleWebStatus,
  };
}