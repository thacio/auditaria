/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { Express } from 'express';
import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryItem } from '../ui/types.js';
import { t, ToolConfirmationOutcome } from '@thacio/auditaria-cli-core';
import type { FooterData } from '../ui/contexts/FooterContext.js';
import type { LoadingStateData } from '../ui/contexts/LoadingStateContext.js';
import type { PendingToolConfirmation } from '../ui/contexts/ToolConfirmationContext.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebInterfaceConfig {
  port?: number;
  host?: string;
}

export class WebInterfaceService {
  private app?: Express;
  private server?: Server;
  private wss?: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private isRunning = false;
  private port?: number;
  private submitQueryHandler?: (query: string) => void;
  private abortHandler?: () => void;
  private confirmationResponseHandler?: (callId: string, outcome: ToolConfirmationOutcome, payload?: any) => void;
  private currentHistory: HistoryItem[] = [];

  /**
   * Start the web interface server
   */
  async start(config: WebInterfaceConfig = {}): Promise<number> {
    if (this.isRunning) {
      throw new Error(t('web.errors.already_running', 'Web interface is already running'));
    }

    try {
      this.app = express();
      
      // Serve static files from web-client directory
      // The web client files are bundled with the CLI package
      const possiblePaths = [
        // For published package: web-client is in the same dist folder
        path.resolve(__dirname, 'web-client'),
        // For development: try bundle location first
        path.resolve(__dirname, '../../../bundle/web-client'), 
        // Development fallback: source files
        path.resolve(__dirname, '../../../packages/web-client/src'),
        // Legacy development paths
        path.resolve(process.cwd(), 'packages/web-client/src'),
      ];
      
      let webClientPath = '';
      for (const testPath of possiblePaths) {
        try {
          const fs = await import('fs');
          if (fs.existsSync(path.join(testPath, 'index.html'))) {
            webClientPath = testPath;
            break;
          }
        } catch {
          // Continue to next path
        }
      }
      
      if (!webClientPath) {
        throw new Error('Could not find web client files');
      }
      
      console.log('Web client path:', webClientPath);
      this.app.use(express.static(webClientPath));
      
      // API endpoint for current history
      this.app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', clients: this.clients.size });
      });

      // Start HTTP server
      this.server = await new Promise<Server>((resolve, reject) => {
        const server = this.app!.listen(config.port || 0, config.host || 'localhost', () => {
          resolve(server);
        });
        server.on('error', reject);
      });
      
      const address = this.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to get server address');
      }
      this.port = address.port;

      // Set up WebSocket server
      this.wss = new WebSocketServer({ server: this.server });
      this.setupWebSocketHandlers();

      this.isRunning = true;
      return this.port;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the web interface server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Close all WebSocket connections
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
    });
    this.clients.clear();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = undefined;
    }

    // Close HTTP server
    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      this.server = undefined;
    }

    this.app = undefined;
    this.port = undefined;
    this.isRunning = false;
  }

  /**
   * Broadcast a message to all connected web clients
   */
  broadcastMessage(historyItem: HistoryItem): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'history_item',
      data: historyItem,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (_error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast footer data to all connected web clients
   */
  broadcastFooterData(footerData: FooterData): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'footer_data',
      data: footerData,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast loading state data to all connected web clients
   */
  broadcastLoadingState(loadingState: LoadingStateData): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'loading_state',
      data: loadingState,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast pending history item (streaming content) to all connected web clients
   */
  broadcastPendingItem(pendingItem: HistoryItem | null): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'pending_item',
      data: pendingItem,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast tool confirmation request to all connected web clients
   */
  broadcastToolConfirmation(confirmation: PendingToolConfirmation): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'tool_confirmation',
      data: confirmation,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (error) {
          // Remove failed client
          this.clients.delete(client);
        }
      } else {
        // Remove disconnected client
        this.clients.delete(client);
      }
    });
  }

  /**
   * Get current server status
   */
  getStatus(): { isRunning: boolean; port?: number; clients: number } {
    return {
      isRunning: this.isRunning,
      port: this.port,
      clients: this.clients.size,
    };
  }

  /**
   * Set the handler for submit query function
   */
  setSubmitQueryHandler(handler: (query: string) => void): void {
    this.submitQueryHandler = handler;
  }

  /**
   * Set the handler for aborting current AI processing from web interface
   */
  setAbortHandler(handler: () => void): void {
    this.abortHandler = handler;
  }

  /**
   * Set the handler for tool confirmation responses from web interface
   */
  setConfirmationResponseHandler(handler: (callId: string, outcome: ToolConfirmationOutcome, payload?: any) => void): void {
    this.confirmationResponseHandler = handler;
  }

  /**
   * Set the current history for new clients
   */
  setCurrentHistory(history: HistoryItem[]): void {
    this.currentHistory = history;
  }

  /**
   * Handle incoming messages from web clients
   */
  private handleIncomingMessage(message: { type: string; content?: string; callId?: string; outcome?: string; payload?: any }): void {
    if (message.type === 'user_message' && this.submitQueryHandler) {
      const query = message.content?.trim();
      if (query) {
        this.submitQueryHandler(query);
      }
    } else if (message.type === 'interrupt_request' && this.abortHandler) {
      this.abortHandler();
    } else if (message.type === 'tool_confirmation_response' && this.confirmationResponseHandler) {
      if (message.callId && message.outcome) {
        const outcome = message.outcome as ToolConfirmationOutcome;
        this.confirmationResponseHandler(message.callId, outcome, message.payload);
      }
    }
  }

  /**
   * Set up WebSocket connection handlers
   */
  private setupWebSocketHandlers(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws: WebSocket) => {
      this.clients.add(ws);

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });

      // Handle incoming messages from web client
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleIncomingMessage(message);
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });

      // Send welcome message
      ws.send(JSON.stringify({
        type: 'connection',
        data: { message: t('web.messages.connected', 'Connected to Auditaria CLI') },
        timestamp: Date.now(),
      }));

      // Send current history to new client
      if (this.currentHistory.length > 0) {
        ws.send(JSON.stringify({
          type: 'history_sync',
          data: { history: this.currentHistory },
          timestamp: Date.now(),
        }));
      }
    });

    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });
  }
}