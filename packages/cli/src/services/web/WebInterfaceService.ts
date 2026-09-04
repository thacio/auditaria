/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { PartListUnion } from '@google/genai';
import {
  debugLogger,
  type DiscoveredMCPTool,
  type MCPServerConfig,
  type ToolConfirmationOutcome,
  type ToolConfirmationPayload,
} from '@google/gemini-cli-core';
import type {
  ConsoleMessageItem,
  HistoryItem,
  ResponseBlock,
} from '../../ui/types.js';
import type { FooterData } from '../../ui/contexts/FooterContext.js';
import type { LoadingStateData } from '../../ui/contexts/LoadingStateContext.js';
import type { PendingToolConfirmation } from '../../ui/contexts/ToolConfirmationContext.js';
import type { SlashCommand } from '../../ui/commands/types.js';
import type { TerminalCaptureData } from '../../ui/contexts/TerminalCaptureContext.js';
import {
  MESSAGE_BUFFER_SIZE,
  SEQUENTIAL_PORT_ATTEMPTS,
  resolveListenTarget,
  type WebInterfaceConfig,
} from './config.js';
import { Broadcaster } from './core/broadcaster.js';
import { ClientRegistry } from './core/clientRegistry.js';
import { WebHttpServer } from './core/httpServer.js';
import { InboundRouter } from './core/inboundRouter.js';
import type { WebFeature } from './core/webFeature.js';
import { WebSocketHub } from './core/webSocketHub.js';
import type { WebFeatureContext, WebLogger } from './core/types.js';
import {
  createHealthRouter,
  createStaticAssetsHandler,
  resolveWebClientRoot,
} from './http/appRoutes.js';
import { createPreviewFileRouter } from './http/previewFile.js';
import { BrowserAgentFeature } from './features/BrowserAgentFeature.js';
import {
  ChatFeature,
  type ChatBridge,
  type ModelChangeRequest,
  type WebModelMenuData,
  type WebTerminalKeyInput,
} from './features/ChatFeature.js';
import { CollaborativeWritingFeature } from './features/CollaborativeWritingFeature.js';
import { DocxParserFeature } from './features/DocxParserFeature.js';
import { FileBrowserFeature } from './features/FileBrowserFeature.js';
import { KnowledgeBaseFeature } from './features/KnowledgeBaseFeature.js';
import { ProviderTerminalFeature } from './features/ProviderTerminalFeature.js';

export interface WebInterfaceStatus {
  isRunning: boolean;
  port?: number;
  clients: number;
}

/** Events the service emits (it is a typed Node `EventEmitter`). */
export interface WebInterfaceEventMap {
  /** The server is listening. */
  started: [info: { port: number }];
  /** The server has stopped. */
  stopped: [];
  /** The number of connected chat clients changed. */
  clients: [count: number];
  /** A web client typed into a CLI-captured dialog. */
  terminal_input: [key: WebTerminalKeyInput];
  /** The web footer's model picker changed. */
  model_change_request: [request: ModelChangeRequest];
}

/** Everything that exists only while the server is up. */
interface Runtime {
  readonly clients: ClientRegistry;
  readonly broadcaster: Broadcaster;
  readonly http: WebHttpServer;
  readonly hub: WebSocketHub;
  /** Features attached so far, in order (detached in reverse on stop). */
  readonly attached: WebFeature[];
  readonly releaseListeners: () => void;
  port: number;
}

/**
 * The web interface: an HTTP server for the browser client and a WebSocket
 * hub that mirrors the CLI session to it. This class is the facade the CLI
 * talks to — it owns the transport lifecycle and delegates every capability
 * to a `WebFeature` (chat, file browser, knowledge base, provider terminal,
 * DOCX parser, collaborative writing, browser agent).
 *
 * All `broadcast*` methods are safe to call while stopped: state is
 * recorded for late joiners and nothing is sent. See
 * {@link WebInterfaceEventMap} for the events it emits.
 */
export class WebInterfaceService extends EventEmitter<WebInterfaceEventMap> {
  private readonly logger: WebLogger = debugLogger;
  private runtime: Runtime | null = null;
  private running = false;

  private readonly bridge: ChatBridge;
  private readonly chat: ChatFeature;
  private readonly docx = new DocxParserFeature();
  private readonly features: readonly WebFeature[];

  constructor() {
    super();
    this.bridge = {
      onTerminalInput: (key) => {
        this.emit('terminal_input', key);
      },
      onModelChangeRequest: (request) => {
        this.emit('model_change_request', request);
      },
    };
    this.chat = new ChatFeature(this.bridge);
    this.features = [
      this.chat,
      new ProviderTerminalFeature(),
      new FileBrowserFeature(),
      this.docx,
      new KnowledgeBaseFeature(),
      new CollaborativeWritingFeature(),
      new BrowserAgentFeature(),
    ];
  }

  // ---------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------

  /** Starts the server and returns the port actually bound. */
  async start(config: WebInterfaceConfig = {}): Promise<number> {
    if (this.runtime) {
      throw new Error('Web interface is already running');
    }

    const logger = this.logger;
    const target = resolveListenTarget(config, process.env, logger);
    const webClientRoot = resolveWebClientRoot();
    const workspaceRoot = process.cwd();

    const clients = new ClientRegistry(MESSAGE_BUFFER_SIZE);
    const broadcaster = new Broadcaster(clients, logger);
    const inbound = new InboundRouter(logger);
    const http = new WebHttpServer(logger);
    const hub = new WebSocketHub({
      clients,
      broadcaster,
      inbound,
      logger,
      sendInitialState: (ws) => this.sendInitialState(ws),
    });
    const unsubscribeConnected = clients.onConnected(() => {
      this.emit('clients', clients.size);
    });
    const unsubscribeDisconnected = clients.onDisconnected((ws) => {
      for (const feature of this.runtime?.attached ?? []) {
        feature.onClientDisconnected?.(ws);
      }
      this.emit('clients', clients.size);
    });

    const runtime: Runtime = {
      clients,
      broadcaster,
      http,
      hub,
      attached: [],
      releaseListeners: () => {
        unsubscribeConnected();
        unsubscribeDisconnected();
      },
      port: 0,
    };
    // Registered before anything is acquired so a failed start tears down
    // exactly what was set up.
    this.runtime = runtime;

    try {
      http.mount(createHealthRouter(() => clients.size));
      http.mount(createPreviewFileRouter(logger));

      const ctx: WebFeatureContext = {
        workspaceRoot,
        logger,
        clients,
        broadcaster,
        inbound,
        http,
        ws: hub,
      };
      for (const feature of this.features) {
        await feature.attach(ctx);
        runtime.attached.push(feature);
        this.assertStillStarting(runtime);
      }

      // Static files last so feature routes take precedence.
      http.mount(createStaticAssetsHandler(webClientRoot));

      const { port, usedFallback } = await http.listen({
        ...target,
        sequentialAttempts: SEQUENTIAL_PORT_ATTEMPTS,
      });
      this.assertStillStarting(runtime);
      if (usedFallback) {
        logger.debug(
          `Port ${target.port} is in use, using port ${port} instead`,
        );
      }
      const server = http.nodeServer;
      if (!server) {
        throw new Error('HTTP server did not start');
      }
      hub.attach(server);

      runtime.port = port;
      this.running = true;
      this.emit('started', { port });
      return port;
    } catch (error) {
      if (this.runtime === runtime) {
        await this.stop();
      } else {
        // stop() ran while we were starting: release whatever this attempt
        // acquired after that (a bound port, a late feature).
        await this.teardown(runtime);
      }
      throw error;
    }
  }

  /** Stops the server, releasing every feature and closing all sockets. */
  async stop(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime) return;
    this.runtime = null;
    this.running = false;
    await this.teardown(runtime);
    this.emit('stopped');
  }

  getStatus(): WebInterfaceStatus {
    return {
      isRunning: this.running,
      port: this.running ? this.runtime?.port : undefined,
      clients: this.runtime?.clients.size ?? 0,
    };
  }

  /** Guards the awaits in `start()` against a concurrent `stop()`. */
  private assertStillStarting(runtime: Runtime): void {
    if (this.runtime !== runtime) {
      throw new Error('Web interface was stopped while starting');
    }
  }

  private async teardown(runtime: Runtime): Promise<void> {
    runtime.hub.close();
    for (const feature of [...runtime.attached].reverse()) {
      try {
        await feature.detach();
      } catch (error) {
        this.logger.error(
          `Failed to stop web feature "${feature.name}":`,
          error,
        );
      }
    }
    runtime.releaseListeners();
    try {
      await runtime.http.close();
    } catch (error) {
      this.logger.error('Failed to close web HTTP server:', error);
    }
  }

  /** Full snapshot for a new client (or one that fell too far behind). */
  private sendInitialState(ws: WebSocket): void {
    const runtime = this.runtime;
    if (!runtime) return;
    const { broadcaster } = runtime;
    const sequence = broadcaster.nextSequence();
    broadcaster.sendSequenced(ws, sequence, 'connection', {
      message: 'Connected to Auditaria',
      startingSequence: sequence,
    });
    for (const feature of runtime.attached) {
      feature.sendInitialState?.(ws);
    }
  }

  // ---------------------------------------------------------------------
  // Web → CLI handlers
  // ---------------------------------------------------------------------

  setSubmitQueryHandler(handler: (query: PartListUnion) => void): void {
    this.bridge.submitQuery = handler;
  }

  setAbortHandler(handler: () => void): void {
    this.bridge.abort = handler;
  }

  setConfirmationResponseHandler(
    handler: (
      callId: string,
      outcome: ToolConfirmationOutcome,
      payload?: ToolConfirmationPayload,
    ) => void,
  ): void {
    this.bridge.respondToConfirmation = handler;
  }

  // ---------------------------------------------------------------------
  // CLI → web broadcasts (chat session)
  // ---------------------------------------------------------------------

  setCurrentHistory(history: readonly HistoryItem[]): void {
    this.chat.setCurrentHistory(history);
  }

  broadcastMessage(historyItem: HistoryItem): void {
    this.chat.broadcastHistoryItem(historyItem);
  }

  broadcastResponseState(blocks: ResponseBlock[] | null): void {
    this.chat.broadcastResponseState(blocks);
  }

  broadcastLoadingState(loadingState: LoadingStateData): void {
    this.chat.broadcastLoadingState(loadingState);
  }

  broadcastFooterData(footerData: FooterData): void {
    this.chat.broadcastFooterData(footerData);
  }

  broadcastInputHistory(history: readonly string[]): void {
    this.chat.broadcastInputHistory(history);
  }

  broadcastSlashCommands(commands: readonly SlashCommand[]): void {
    this.chat.broadcastSlashCommands(commands);
  }

  broadcastModelMenuData(modelMenuData: WebModelMenuData): void {
    this.chat.broadcastModelMenuData(modelMenuData);
  }

  broadcastMCPServers(
    mcpServers: Record<string, MCPServerConfig>,
    blockedMcpServers: Array<{ name: string; extensionName: string }>,
    serverTools: Map<string, DiscoveredMCPTool[]>,
    serverStatuses: Map<string, string>,
  ): void {
    this.chat.broadcastMCPServers(
      mcpServers,
      blockedMcpServers,
      serverTools,
      serverStatuses,
    );
  }

  broadcastConsoleMessages(messages: readonly ConsoleMessageItem[]): void {
    this.chat.broadcastConsoleMessages(messages);
  }

  broadcastCliActionRequired(
    active: boolean,
    reason = 'authentication',
    title = 'CLI Action Required',
    message = 'Please complete the action in the CLI terminal.',
  ): void {
    this.chat.broadcastCliActionRequired({ active, reason, title, message });
  }

  broadcastTerminalCapture(data: TerminalCaptureData): void {
    this.chat.broadcastTerminalCapture(data);
  }

  broadcastToolConfirmation(confirmation: PendingToolConfirmation): void {
    this.chat.broadcastToolConfirmation(confirmation);
  }

  broadcastToolConfirmationRemoval(callId: string): void {
    this.chat.broadcastToolConfirmationRemoval(callId);
  }

  broadcastToolResult(callId: string, isOk: boolean, result: unknown): void {
    this.chat.broadcastToolResult(callId, isOk, result);
  }

  broadcastClear(): void {
    this.chat.broadcastClear();
  }

  /** Call ids of tool confirmations the web clients were told about. */
  getActiveToolConfirmationIds(): string[] {
    return this.chat.getActiveToolConfirmationIds();
  }

  // ---------------------------------------------------------------------
  // DOCX parser
  // ---------------------------------------------------------------------

  broadcastParserStatus(): void {
    this.docx.broadcastParserStatus();
  }

  /** Re-detects the parser binary (after `/setup-skill`) and notifies clients. */
  refreshParserStatus(): void {
    this.docx.refreshParserStatus();
  }
}
