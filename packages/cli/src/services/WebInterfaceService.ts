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

// WEB_INTERFACE_START: Message resilience system
interface SequencedMessage {
  sequence: number;
  message: string;
  timestamp: number;
  ephemeral?: boolean;
}

class CircularMessageBuffer {
  private buffer: (SequencedMessage | null)[];
  private head: number = 0;
  private tail: number = 0;
  private size: number = 0;
  private capacity: number;

  constructor(capacity: number = 100) {
    this.capacity = capacity;
    this.buffer = new Array(capacity).fill(null);
  }

  add(message: SequencedMessage): void {
    this.buffer[this.tail] = message;
    this.tail = (this.tail + 1) % this.capacity;
    
    if (this.size < this.capacity) {
      this.size++;
    } else {
      // Buffer is full, advance head
      this.head = (this.head + 1) % this.capacity;
    }
  }

  getMessagesFrom(sequence: number, persistentOnly: boolean = false): SequencedMessage[] {
    const messages: SequencedMessage[] = [];
    let current = this.head;
    
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg && msg.sequence > sequence) {
        // If persistentOnly is true, skip ephemeral messages
        if (!persistentOnly || !msg.ephemeral) {
          messages.push(msg);
        }
      }
      current = (current + 1) % this.capacity;
    }
    
    return messages.sort((a, b) => a.sequence - b.sequence);
  }

  hasSequence(sequence: number): boolean {
    let current = this.head;
    
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg && msg.sequence === sequence) {
        return true;
      }
      current = (current + 1) % this.capacity;
    }
    
    return false;
  }

  getOldestSequence(): number | null {
    if (this.size === 0) return null;
    const msg = this.buffer[this.head];
    return msg ? msg.sequence : null;
  }
}

interface ClientState {
  messageBuffer: CircularMessageBuffer;
  lastAcknowledgedSequence: number;
}
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
  // WEB_INTERFACE_START: Message resilience system
  private sequenceNumber: number = 0;
  private clientStates: WeakMap<WebSocket, ClientState> = new WeakMap();
  private readonly MESSAGE_BUFFER_SIZE = 200;
  private readonly MAX_SEQUENCE_NUMBER = Number.MAX_SAFE_INTEGER - 1000000; // Leave headroom before overflow
  // WEB_INTERFACE_END
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

    // WEB_INTERFACE_START: Add sequence number
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'history_item',
      data: historyItem,
      sequence,
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
          }
          // WEB_INTERFACE_END
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

    // WEB_INTERFACE_START: Add sequence number
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'footer_data',
      data: footerData,
      sequence,
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
          }
          // WEB_INTERFACE_END
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

    // WEB_INTERFACE_START: Add sequence number with ephemeral flag
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'loading_state',
      data: loadingState,
      sequence,
      ephemeral: true,  // Mark as ephemeral - not saved in history
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer with ephemeral flag
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now(), ephemeral: true });
          }
          // WEB_INTERFACE_END
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

    // WEB_INTERFACE_START: Add sequence number with ephemeral flag
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type: 'pending_item',
      data: pendingItem,
      sequence,
      ephemeral: true,  // Mark as ephemeral - not saved in history
      timestamp: Date.now(),
    });
    // WEB_INTERFACE_END

    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          // WEB_INTERFACE_START: Store in client's buffer with ephemeral flag
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now(), ephemeral: true });
          }
          // WEB_INTERFACE_END
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

  // WEB_INTERFACE_START: Safely increment sequence number with overflow protection
  private getNextSequence(): number {
    if (this.sequenceNumber >= this.MAX_SEQUENCE_NUMBER) {
      this.sequenceNumber = 0;
      console.log('Sequence number wrapped around to 0');
    }
    return ++this.sequenceNumber;
  }
  // WEB_INTERFACE_END

  // WEB_INTERFACE_START: Generic broadcast helper with sequence numbers
  private broadcastWithSequence(type: string, data: any): void {
    if (!this.isRunning || this.clients.size === 0) {
      return;
    }
    
    const sequence = this.getNextSequence();
    const message = JSON.stringify({
      type,
      data,
      sequence,
      timestamp: Date.now(),
    });
    
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          const state = this.clientStates.get(client);
          if (state) {
            state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
          }
        } catch (_error) {
          this.clients.delete(client);
        }
      } else {
        this.clients.delete(client);
      }
    });
  }
  // WEB_INTERFACE_END

  /**
   * Broadcast tool confirmation request to all connected web clients
   */
  broadcastToolConfirmation(confirmation: PendingToolConfirmation): void {
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('tool_confirmation', confirmation);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast tool confirmation removal to all connected web clients
   */
  broadcastToolConfirmationRemoval(callId: string): void {
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('tool_confirmation_removal', { callId });
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast tool call result to all connected web clients
   */
  broadcastToolResult(callId: string, isOk: boolean, result: any): void {
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('tool_result', { callId, isOk, result });
    // WEB_INTERFACE_END
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
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('clear', null);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast slash commands data to all connected web clients
   */
  broadcastSlashCommands(commands: readonly SlashCommand[]): void {
    // Store current commands for new clients
    this.currentSlashCommands = commands;
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('slash_commands', { commands });
    // WEB_INTERFACE_END
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

    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('mcp_servers', this.currentMCPServers);
    // WEB_INTERFACE_END
  }

  /**
   * Broadcast console messages to all connected web clients
   */
  broadcastConsoleMessages(messages: ConsoleMessageItem[]): void {
    // Store current console messages for new clients
    this.currentConsoleMessages = messages;

    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('console_messages', messages);
    // WEB_INTERFACE_END
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
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('cli_action_required', {
      active,
      reason,
      title,
      message
    });
    // WEB_INTERFACE_END
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
    
    // WEB_INTERFACE_START: Use sequence-enabled broadcast
    this.broadcastWithSequence('terminal_capture', data);
    // WEB_INTERFACE_END
  }

  /**
   * Handle incoming messages from web clients
   */
  // WEB_INTERFACE_START: Handle acknowledgment messages
  private handleAcknowledgment(ws: WebSocket, message: { lastSequence: number }): void {
    const state = this.clientStates.get(ws);
    if (state && message.lastSequence) {
      state.lastAcknowledgedSequence = message.lastSequence;
    }
  }

  // Handle resync requests
  private handleResyncRequest(ws: WebSocket, message: { from: number; persistentOnly?: boolean }): void {
    const state = this.clientStates.get(ws);
    if (!state) return;

    const fromSequence = message.from || 0;
    const persistentOnly = message.persistentOnly === true;
    
    // Check if we have the requested sequence in our buffer
    const oldestSequence = state.messageBuffer.getOldestSequence();
    if (oldestSequence !== null && fromSequence < oldestSequence) {
      // Buffer overrun - client is too far behind
      ws.send(JSON.stringify({
        type: 'force_resync',
        currentSequence: this.sequenceNumber,
        timestamp: Date.now()
      }));
      
      // Send current state as if it's a new connection
      this.sendInitialState(ws);
    } else {
      // We can fulfill the resync request - only send persistent messages if requested
      const messages = state.messageBuffer.getMessagesFrom(fromSequence, persistentOnly);
      messages.forEach(msg => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(msg.message);
          } catch (error) {
            console.error('Error sending resync message:', error);
          }
        }
      });
    }
  }
  // WEB_INTERFACE_END

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
      
      // WEB_INTERFACE_START: Initialize client state for message resilience
      this.clientStates.set(ws, {
        messageBuffer: new CircularMessageBuffer(this.MESSAGE_BUFFER_SIZE),
        lastAcknowledgedSequence: 0
      });
      // WEB_INTERFACE_END

      ws.on('close', () => {
        this.clients.delete(ws);
        // Client state will be automatically cleaned up by WeakMap
      });

      ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.clients.delete(ws);
      });

      // Handle incoming messages from web client
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          // WEB_INTERFACE_START: Handle new message types for resilience
          if (message.type === 'ack') {
            this.handleAcknowledgment(ws, message);
          } else if (message.type === 'resync_request') {
            this.handleResyncRequest(ws, message);
          } else {
            this.handleIncomingMessage(message);
          }
          // WEB_INTERFACE_END
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      });

      // Send initial state to the client
      this.sendInitialState(ws);
    });

    this.wss.on('error', (error) => {
      console.error('WebSocket server error:', error);
    });
  }
  
  
  // WEB_INTERFACE_START: Send initial state to a client
  private sendInitialState(ws: WebSocket): void {
    const state = this.clientStates.get(ws);
    if (!state) return;
    
    // Helper to send and store message
    const sendAndStore = (type: string, data: any) => {
      const sequence = this.getNextSequence();
      const message = JSON.stringify({
        type,
        data,
        sequence,
        timestamp: Date.now(),
      });
      
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
          state.messageBuffer.add({ sequence, message, timestamp: Date.now() });
        } catch (error) {
          console.error(`Error sending ${type}:`, error);
        }
      }
    };
    
    // Send welcome message with starting sequence
    sendAndStore('connection', { 
      message: t('web.messages.connected', 'Connected to Auditaria CLI'),
      startingSequence: this.sequenceNumber 
    });
    
    // Send current history to new client
    if (this.currentHistory.length > 0) {
      sendAndStore('history_sync', { history: this.currentHistory });
    }
    
    // Send current slash commands to new client
    if (this.currentSlashCommands.length > 0) {
      sendAndStore('slash_commands', { commands: this.currentSlashCommands });
    }
    
    // Send current MCP servers to new client (always send, even if empty)
    sendAndStore('mcp_servers', this.currentMCPServers);
    
    // Send current console messages to new client (always send, even if empty)
    sendAndStore('console_messages', this.currentConsoleMessages);
    
    // Send current CLI action state to new client if active
    if (this.currentCliActionState && this.currentCliActionState.active) {
      sendAndStore('cli_action_required', this.currentCliActionState);
    }
    
    // Send current terminal capture to new client if available
    if (this.currentTerminalCapture && this.currentTerminalCapture.content) {
      sendAndStore('terminal_capture', this.currentTerminalCapture);
    }
  }
  // WEB_INTERFACE_END
}