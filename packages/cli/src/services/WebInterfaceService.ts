/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import express, { Express } from 'express';
import { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HistoryItem, ConsoleMessageItem } from '../ui/types.js';
import { t, ToolConfirmationOutcome, MCPServerConfig, DiscoveredMCPTool } from '@thacio/auditaria-cli-core';
import type { FooterData } from '../ui/contexts/FooterContext.js';
import type { LoadingStateData } from '../ui/contexts/LoadingStateContext.js';
import type { PendingToolConfirmation } from '../ui/contexts/ToolConfirmationContext.js';
import type { SlashCommand } from '../ui/commands/types.js';
import type { TerminalCaptureData } from '../ui/contexts/TerminalCaptureContext.js';
import { EventEmitter } from 'events';
// WEB_INTERFACE_START: Import for multimodal support
import { type PartListUnion, createPartFromBase64 } from '@google/genai';

// WeakMap to store attachment metadata without polluting the Part objects
export const attachmentMetadataMap = new WeakMap<any, any>();
// WEB_INTERFACE_END

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebInterfaceConfig {
  port?: number;
  host?: string;
}

export class WebInterfaceService extends EventEmitter {
  private app?: Express;
  private server?: Server;
  private wss?: WebSocketServer;
  private clients: Set<WebSocket> = new Set();
  private isRunning = false;
  private port?: number;
  // WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
  private submitQueryHandler?: (query: PartListUnion) => void;
  // WEB_INTERFACE_END
  private abortHandler?: () => void;
  private confirmationResponseHandler?: (callId: string, outcome: ToolConfirmationOutcome, payload?: any) => void;
  private currentHistory: HistoryItem[] = [];
  private currentSlashCommands: readonly SlashCommand[] = [];
  private currentMCPServers: { servers: any[]; blockedServers: any[] } = { servers: [], blockedServers: [] };
  private currentConsoleMessages: ConsoleMessageItem[] = [];
  private currentCliActionState: { active: boolean; reason: string; title: string; message: string } | null = null;
  private currentTerminalCapture: TerminalCaptureData | null = null;

  /**
   * Start HTTP server on specified port
   */
  private async startServerOnPort(port: number, host: string = 'localhost'): Promise<Server> {
    return new Promise<Server>((resolve, reject) => {
      const server = this.app!.listen(port, host, () => {
        // Small delay to ensure server is fully ready
        setTimeout(() => resolve(server), 10);
      });
      server.on('error', reject);
    });
  }

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
      const possiblePaths: string[] = [
        // 1. Package-relative resolution (best for global npm installations)
        (() => {
          try {
            const packageDir = path.dirname(require.resolve('@thacio/auditaria-cli/package.json'));
            return path.join(packageDir, 'web-client');
          } catch {
            return null;
          }
        })(),
        // 2. For published package: web-client is in the same dist folder
        path.resolve(__dirname, 'web-client'),
        // 3. For development: try bundle location first
        path.resolve(__dirname, '../../../bundle/web-client'), 
        // 4. Development fallback: source files
        path.resolve(__dirname, '../../../packages/web-client/src'),
        // 5. Legacy development paths
        path.resolve(process.cwd(), 'packages/web-client/src'),
      ].filter((path): path is string => path !== null); // Type-safe filter to remove null values
      
      let webClientPath = '';
      const debugMode = process.env.DEBUG || process.env.NODE_ENV === 'development';
      
      if (debugMode) {
        // console.log('Web client path resolution attempts:');
        possiblePaths.forEach((testPath, index) => {
          console.log(`  ${index + 1}. ${testPath}`);
        });
      }
      
      for (const testPath of possiblePaths) {
        try {
          const fs = await import('fs');
          const indexPath = path.join(testPath, 'index.html');
          if (fs.existsSync(indexPath)) {
            webClientPath = testPath;
            if (debugMode) {
              // console.log(`✓ Found web client files at: ${webClientPath}`);
            }
            break;
          } else if (debugMode) {
            // console.log(`✗ Not found: ${indexPath}`);
          }
        } catch (error) {
          if (debugMode) {
            // console.log(`✗ Error checking ${testPath}:`, error);
          }
          // Continue to next path
        }
      }
      
      if (!webClientPath) {
        const errorMsg = 'Could not find web client files in any of the attempted paths';
        if (debugMode) {
          console.error('❌', errorMsg);
          console.error('Attempted paths:', possiblePaths);
        }
        throw new Error(errorMsg);
      }
      
      console.log('Web client serving from:', webClientPath);
      this.app.use(express.static(webClientPath));
      
      // API endpoint for current history
      this.app.get('/api/health', (req, res) => {
        res.json({ status: 'ok', clients: this.clients.size });
      });

      // Start HTTP server with port fallback
      const requestedPort = config.port || 8629; // Default to 8629
      const host = config.host || 'localhost';
      
      let usedFallback = false;
      try {
        // Try requested port first
        this.server = await this.startServerOnPort(requestedPort, host);
      } catch (error: any) {
        if (error.code === 'EADDRINUSE') {
          try {
            // Retry with random port (0 = random)
            this.server = await this.startServerOnPort(0, host);
            usedFallback = true;
          } catch (fallbackError: any) {
            // If fallback also fails, throw the original error with more context
            throw new Error(`Failed to start web server on port ${requestedPort} (in use) and fallback to random port also failed: ${fallbackError.message}`);
          }
        } else {
          throw error; // Re-throw non-port-conflict errors
        }
      }
      
      const address = this.server.address();
      if (!address || typeof address === 'string') {
        throw new Error(`Failed to get server address. Address type: ${typeof address}, value: ${address}`);
      }
      this.port = address.port;

      // Log fallback message after we have the actual assigned port
      if (usedFallback) {
        console.log(t('web.port_fallback', 'Port {requestedPort} is in use, using port {assignedPort} instead', { requestedPort, assignedPort: this.port }));
      }

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
   * Broadcast tool confirmation removal to all connected web clients
   */
  broadcastToolConfirmationRemoval(callId: string): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'tool_confirmation_removal',
      data: { callId },
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
  // WEB_INTERFACE_START: Updated to accept PartListUnion for multimodal support
  setSubmitQueryHandler(handler: (query: PartListUnion) => void): void {
    this.submitQueryHandler = handler;
  }
  // WEB_INTERFACE_END

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
   * Broadcast clear command to all connected web clients
   */
  broadcastClear(): void {
    // Clear internal history first
    this.currentHistory = [];
    
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'clear',
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
   * Broadcast slash commands data to all connected web clients
   */
  broadcastSlashCommands(commands: readonly SlashCommand[]): void {
    // Store current commands for new clients
    this.currentSlashCommands = commands;
    
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'slash_commands',
      data: { commands },
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
   * Broadcast MCP servers data to all connected web clients
   */
  broadcastMCPServers(
    mcpServers: Record<string, MCPServerConfig>, 
    blockedMcpServers: Array<{ name: string; extensionName: string }>,
    serverTools: Map<string, DiscoveredMCPTool[]>,
    serverStatuses: Map<string, string>
  ): void {
    // Transform the data for web client consumption
    const serversData = Object.entries(mcpServers).map(([name, config]) => {
      const tools = serverTools.get(name) || [];
      const status = serverStatuses.get(name) || 'disconnected';
      
      return {
        name,
        extensionName: config.extensionName,
        description: config.description,
        status,
        oauth: config.oauth,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          schema: tool.schema
        }))
      };
    });

    // Store current MCP servers data for new clients
    this.currentMCPServers = {
      servers: serversData,
      blockedServers: blockedMcpServers
    };

    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'mcp_servers',
      data: this.currentMCPServers,
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
   * Broadcast console messages to all connected web clients
   */
  broadcastConsoleMessages(messages: ConsoleMessageItem[]): void {
    // Store current console messages for new clients
    this.currentConsoleMessages = messages;

    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'console_messages',
      data: messages,
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
   * Broadcast CLI action required state to all connected web clients
   */
  broadcastCliActionRequired(active: boolean, reason: string = 'authentication', title: string = 'CLI Action Required', message: string = 'Please complete the action in the CLI terminal.'): void {
    // Store the current state for new clients
    if (active) {
      this.currentCliActionState = { active, reason, title, message };
    } else {
      this.currentCliActionState = null;
    }
    
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const payload = JSON.stringify({
      type: 'cli_action_required',
      data: {
        active,
        reason,
        title,
        message
      },
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
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
   * Broadcast terminal capture to all connected web clients
   */
  broadcastTerminalCapture(data: TerminalCaptureData): void {
    // Store current terminal capture for new clients
    if (data.content) {
      this.currentTerminalCapture = data;
    } else {
      this.currentTerminalCapture = null;
    }
    
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }

    const message = JSON.stringify({
      type: 'terminal_capture',
      data,
      timestamp: Date.now(),
    });

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
        } catch (_error) {
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    });
  }

  /**
   * Handle incoming messages from web clients
   */
  // WEB_INTERFACE_START: Enhanced to handle attachments for multimodal support
  private handleIncomingMessage(message: { type: string; content?: string; attachments?: any[]; callId?: string; outcome?: string; payload?: any; key?: any }): void {
    if (message.type === 'user_message' && this.submitQueryHandler) {
      const text = message.content?.trim() || '';
      
      // Convert attachments to multimodal Parts
      if (message.attachments && message.attachments.length > 0) {
        const parts: any[] = [];
        
        // Add text part if present
        if (text) {
          parts.push({ text });
        }
        
        // Add attachment parts and store metadata in WeakMap
        for (const attachment of message.attachments) {
          if (attachment.data && attachment.mimeType) {
            try {
              // Create inline data part for images and files
              const part = createPartFromBase64(attachment.data, attachment.mimeType);
              
              // Store metadata in WeakMap for later retrieval
              attachmentMetadataMap.set(part, {
                type: attachment.type,
                mimeType: attachment.mimeType,
                name: attachment.name,
                size: attachment.size,
                thumbnail: attachment.thumbnail,
                icon: attachment.icon,
                displaySize: attachment.displaySize
              });
              
              parts.push(part);
            } catch (error) {
              console.error('Failed to create part from attachment:', error);
            }
          }
        }
        
        // Send multimodal message 
        if (parts.length > 0) {
          this.submitQueryHandler(parts as PartListUnion);
        }
      } else if (text) {
        // Send text-only message
        this.submitQueryHandler(text);
      }
    } else if (message.type === 'interrupt_request' && this.abortHandler) {
    // WEB_INTERFACE_END
      this.abortHandler();
    } else if (message.type === 'tool_confirmation_response' && this.confirmationResponseHandler) {
      if (message.callId && message.outcome) {
        const outcome = message.outcome as ToolConfirmationOutcome;
        this.confirmationResponseHandler(message.callId, outcome, message.payload);
      }
    } else if (message.type === 'terminal_input' && message.key) {
      // Emit keyboard event for terminal input
      this.emit('terminal_input', message.key);
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

      // Send current slash commands to new client
      if (this.currentSlashCommands.length > 0) {
        ws.send(JSON.stringify({
          type: 'slash_commands',
          data: { commands: this.currentSlashCommands },
          timestamp: Date.now(),
        }));
      }

      // Send current MCP servers to new client (always send, even if empty)
      ws.send(JSON.stringify({
        type: 'mcp_servers',
        data: this.currentMCPServers,
        timestamp: Date.now(),
      }));

      // Send current console messages to new client (always send, even if empty)
      ws.send(JSON.stringify({
        type: 'console_messages',
        data: this.currentConsoleMessages,
        timestamp: Date.now(),
      }));

      // Send current CLI action state to new client if active
      if (this.currentCliActionState && this.currentCliActionState.active) {
        ws.send(JSON.stringify({
          type: 'cli_action_required',
          data: this.currentCliActionState,
          timestamp: Date.now(),
        }));
      }
      
      // Send current terminal capture to new client if available
      if (this.currentTerminalCapture && this.currentTerminalCapture.content) {
        ws.send(JSON.stringify({
          type: 'terminal_capture',
          data: this.currentTerminalCapture,
          timestamp: Date.now(),
        }));
      }
    });

    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });
  }
}