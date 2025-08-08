/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { useCallback } from 'react';
import { useWebInterface } from '../contexts/WebInterfaceContext.js';
import { t } from '@thacio/auditaria-cli-core';

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
        content: t('commands.web.error.not_available', 'Web interface is not available in this configuration'),
      };
    }

    try {
      if (webInterface.isRunning) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('commands.web.already_running', 'Web interface is already running on port {{port}}', { 
            port: webInterface.port?.toString() || 'unknown' 
          }),
          port: webInterface.port || undefined,
        };
      }

      const port = portStr ? parseInt(portStr, 10) : undefined;
      const assignedPort = await webInterface.start({ port });
      
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.web.started', 'Web interface started on http://localhost:{{port}}', { 
          port: assignedPort.toString() 
        }),
        port: assignedPort,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.web.start_error', 'Failed to start web interface: {{error}}', { 
          error: error instanceof Error ? error.message : String(error) 
        }),
      };
    }
  }, [webInterface]);

  const handleWebStop = useCallback(async (): Promise<WebCommandResult> => {
    if (!webInterface) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.web.error.not_available', 'Web interface is not available in this configuration'),
      };
    }

    try {
      if (!webInterface.isRunning) {
        return {
          type: 'message',
          messageType: 'info',
          content: t('commands.web.not_running', 'Web interface is not currently running'),
        };
      }

      await webInterface.stop();
      
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.web.stopped', 'Web interface stopped'),
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.web.stop_error', 'Failed to stop web interface: {{error}}', { 
          error: error instanceof Error ? error.message : String(error) 
        }),
      };
    }
  }, [webInterface]);

  const handleWebStatus = useCallback((): WebCommandResult => {
    if (!webInterface) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('commands.web.error.not_available', 'Web interface is not available in this configuration'),
      };
    }

    if (webInterface.isRunning) {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.web.status.running', 'Web interface is running on port {{port}} with {{clients}} connected client(s)', {
          port: webInterface.port?.toString() || 'unknown',
          clients: webInterface.clientCount.toString(),
        }),
      };
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: t('commands.web.status.stopped', 'Web interface is not running'),
      };
    }
  }, [webInterface]);

  return {
    handleWebStart,
    handleWebStop,
    handleWebStatus,
  };
}