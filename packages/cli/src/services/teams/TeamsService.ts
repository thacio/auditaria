/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_TEAMS_FEATURE: This entire file is part of the Teams integration

import type {
  Config,
  ToolCallRequestInfo,
  ProviderDriver,
} from '@google/gemini-cli-core'; // AUDITARIA_SESSION_MANAGEMENT: added ProviderDriver
import {
  GeminiEventType,
  Scheduler,
  debugLogger,
  ToolErrorType,
  recordToolCallInteractions,
  ProviderEventType, // AUDITARIA_SESSION_MANAGEMENT
} from '@google/gemini-cli-core';
import type { Part } from '@google/genai';
import type * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { TeamsWebhookServer } from './TeamsWebhookServer.js';
import {
  formatResponse,
  formatError,
  formatLabeledResponse,
} from './TeamsFormatter.js';
import {
  TEAMS_DEFAULTS,
  SYNC_TIMEOUT_MS,
  HYBRID_TIMEOUT_MS,
  INCOMING_WEBHOOK_RATE_LIMIT,
  type TeamsConfig,
  type TeamsIncomingMessage,
} from './types.js';
import {
  pushToCliDisplay,
  setTeamsProcessing,
  injectCliInput,
} from './TeamsBridge.js';
import { TeamsSessionManager } from './TeamsSessions.js';
import type { HistoryItem } from '../../ui/types.js';

/**
 * Stored result for pull mode — keyed by conversationId.
 */
interface PullResult {
  text: string;
  userName: string;
  originalMessage: string;
  timestamp: number;
}

/**
 * Main Teams service that bridges the webhook server with Auditaria's agent loop.
 *
 * Uses the CLI's shared GeminiClient (same conversation, same history).
 * A mutex ensures only one message is processed at a time.
 *
 * Response modes:
 * - sync: Return AI response in HTTP response (in-thread, 5s timeout)
 * - async: Return ack, POST results via incoming webhook (new post)
 * - labeled-async: Like async but with thread context label
 * - pull: Store results, return on next @mention (in-thread)
 * - hybrid: Try sync first, fall back to async if >4s
 */
export class TeamsService {
  private server: TeamsWebhookServer;
  private stopped = false;
  private processing = false;

  /** Per-thread locks — serializes messages within the same thread, but different threads run in parallel */
  private threadLocks: Map<string, Promise<void>> = new Map();

  /** Threads currently being processed — keyed by threadId */
  private processingThreads: Set<string> = new Set();

  /** Per-thread session manager — each thread gets its own GeminiClient */
  private sessionManager: TeamsSessionManager;

  // AUDITARIA_SESSION_MANAGEMENT: Per-thread external provider drivers (Claude/Codex/Copilot)
  private externalDrivers: Map<
    string,
    { driver: ProviderDriver; provider: string }
  > = new Map();

  /** Stored results for pull mode */
  private pullResults: Map<string, PullResult> = new Map();

  /** Rate limiter for incoming webhook */
  private lastWebhookPost = 0;

  /** ngrok tunnel child process */
  private tunnelProcess: ChildProcess | null = null;

  /** Public tunnel URL (set after ngrok starts) */
  tunnelUrl: string | undefined;

  constructor(
    private readonly config: Config,
    private readonly teamsConfig: TeamsConfig,
  ) {
    this.server = new TeamsWebhookServer(teamsConfig);
    this.server.onMessage((msg, res) => this.handleMessage(msg, res));
    this.server.onStatus(() => ({
      ok: true,
      busy: this.processing,
      activeThreads: this.processingThreads.size,
    }));
    this.sessionManager = new TeamsSessionManager(config);
  }

  async start(): Promise<void> {
    await this.server.start();

    // Start ngrok tunnel if enabled
    if (this.teamsConfig.tunnel !== false) {
      await this.startTunnel();
    }

    debugLogger.log(
      `Teams: Service started (response mode: ${this.teamsConfig.responseMode})`,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.sessionManager.dispose();
    // AUDITARIA_SESSION_MANAGEMENT_START: Dispose external provider drivers
    for (const entry of this.externalDrivers.values()) {
      entry.driver.dispose();
    }
    this.externalDrivers.clear();
    // AUDITARIA_SESSION_MANAGEMENT_END
    this.stopTunnel();
    await this.server.stop();
    debugLogger.log('Teams: Service stopped');
  }

  // --- ngrok tunnel management ---

  /**
   * Starts an ngrok tunnel pointing to the webhook server port.
   * Queries ngrok's local API to extract the public HTTPS URL.
   */
  private async startTunnel(): Promise<void> {
    const port = this.teamsConfig.port;
    debugLogger.log(`Teams: Starting ngrok tunnel to port ${port}...`);

    try {
      // Check if ngrok is already running (port 4040)
      try {
        const existing = await fetch('http://127.0.0.1:4040/api/tunnels');
        if (existing.ok) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const data = (await existing.json()) as {
            tunnels: Array<{ public_url: string; proto: string }>;
          };
          const httpsTunnel = data.tunnels.find((t) => t.proto === 'https');
          if (httpsTunnel) {
            this.tunnelUrl = httpsTunnel.public_url;
            debugLogger.log(
              `Teams: ngrok already running — reusing tunnel: ${this.tunnelUrl}`,
            );
            return;
          }
        }
      } catch {
        // ngrok not running — we'll start it
      }

      // Spawn ngrok — use ngrok directly (must be installed globally: npm i -g ngrok)
      this.tunnelProcess = spawn('ngrok', ['http', String(port)], {
        shell: true,
        stdio: 'pipe',
        detached: false,
      });

      // Capture stderr for error reporting
      let stderrOutput = '';
      this.tunnelProcess.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        stderrOutput += text + '\n';
        debugLogger.error(`Teams: ngrok: ${text}`);
      });

      // Also capture stdout (ngrok prints errors there too)
      let stdoutOutput = '';
      this.tunnelProcess.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        stdoutOutput += text + '\n';
        if (text.includes('ERROR') || text.includes('ERR_NGROK')) {
          debugLogger.error(`Teams: ngrok: ${text}`);
        } else {
          debugLogger.debug(`Teams: ngrok: ${text}`);
        }
      });

      this.tunnelProcess.on('error', (err) => {
        debugLogger.error(`Teams: ngrok process error: ${err.message}`);
      });

      this.tunnelProcess.on('exit', (code) => {
        if (!this.stopped) {
          const errorInfo = stderrOutput || stdoutOutput;
          if (code !== 0 && errorInfo) {
            debugLogger.error(
              `Teams: ngrok exited with code ${code}:\n${errorInfo.trim()}`,
            );
          } else {
            debugLogger.log(`Teams: ngrok process exited with code ${code}`);
          }
        }
        this.tunnelProcess = null;
        this.tunnelUrl = undefined;
      });

      // Wait for ngrok to start, then query its API for the public URL
      this.tunnelUrl = await this.pollNgrokApi();

      if (this.tunnelUrl) {
        debugLogger.log(`Teams: ngrok tunnel ready: ${this.tunnelUrl}`);
      } else {
        const errorInfo = (stderrOutput + stdoutOutput).trim();
        const hint = errorInfo.includes('authtoken')
          ? 'Run: ngrok config add-authtoken <your-token>'
          : 'Is ngrok installed and authenticated? Run: ngrok http 3978';
        debugLogger.error(
          `Teams: Could not start ngrok tunnel.${errorInfo ? '\n' + errorInfo : ''}\n${hint}`,
        );
      }
    } catch (err) {
      debugLogger.error('Teams: Failed to start ngrok tunnel:', err);
    }
  }

  /**
   * Polls ngrok's local API until a tunnel URL is available.
   */
  private async pollNgrokApi(
    maxAttempts = 20,
    intervalMs = 500,
  ): Promise<string | undefined> {
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      try {
        const res = await fetch('http://127.0.0.1:4040/api/tunnels');
        if (res.ok) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          const data = (await res.json()) as {
            tunnels: Array<{ public_url: string; proto: string }>;
          };
          const httpsTunnel = data.tunnels.find((t) => t.proto === 'https');
          if (httpsTunnel) {
            return httpsTunnel.public_url;
          }
        }
      } catch {
        // ngrok not ready yet
      }
    }
    return undefined;
  }

  /**
   * Kills the ngrok tunnel process.
   */
  private stopTunnel(): void {
    if (this.tunnelProcess) {
      debugLogger.log('Teams: Stopping ngrok tunnel...');
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
      this.tunnelUrl = undefined;
    }
  }

  /**
   * Updates the allow list at runtime.
   */
  updateAllowList(allowFrom: string[]): void {
    this.teamsConfig.allowFrom = allowFrom;
    debugLogger.log(
      `Teams: Allow list updated: ${allowFrom.length > 0 ? allowFrom.join(', ') : 'EMPTY'}`,
    );
  }

  /**
   * Updates response mode at runtime.
   */
  updateResponseMode(mode: TeamsConfig['responseMode']): void {
    this.teamsConfig.responseMode = mode;
    debugLogger.log(`Teams: Response mode changed to: ${mode}`);
  }

  /**
   * Updates the incoming webhook URL at runtime.
   */
  updateWebhookUrl(url: string): void {
    this.teamsConfig.webhookUrl = url;
    debugLogger.log(`Teams: Webhook URL updated`);
  }

  /**
   * Forwards a CLI history item to Teams via incoming webhook.
   * Only forwards user messages and AI responses.
   */
  forwardCliItem(item: HistoryItem): void {
    if (this.stopped || !this.teamsConfig.webhookUrl) return;

    if (item.type === 'user') {
      const text = `[CLI] ${item.text}`;
      void this.postToIncomingWebhook(text).catch(() => {});
    } else if (item.type === 'gemini_content' || item.type === 'gemini') {
      const chunks = formatResponse(item.text);
      for (const chunk of chunks) {
        void this.postToIncomingWebhook(chunk).catch(() => {});
      }
    }
  }

  // --- Per-thread mutex ---
  // Different threads run in parallel; same thread is serialized (prevents double-processing).

  private acquireThreadLock(threadId: string): Promise<() => void> {
    let release: () => void;
    const prev = this.threadLocks.get(threadId) ?? Promise.resolve();
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.threadLocks.set(threadId, next);
    return prev.then(() => {
      const releaseAndCleanup = () => {
        // Clean up the map entry if this is the last waiter
        if (this.threadLocks.get(threadId) === next) {
          this.threadLocks.delete(threadId);
        }
        release!();
      };
      return releaseAndCleanup;
    });
  }

  // --- Message handling with response strategy ---

  private handleMessage(
    msg: TeamsIncomingMessage,
    res: http.ServerResponse,
  ): void {
    debugLogger.log(
      `Teams: handleMessage — mode=${this.teamsConfig.responseMode} from=${msg.userName}`,
    );

    // Detect Auditaria slash commands
    if (msg.text.startsWith('/')) {
      const injected = injectCliInput(msg.text);
      if (injected) {
        debugLogger.log(`Teams: Injected CLI command: ${msg.text}`);
        pushToCliDisplay({
          type: 'user',
          text: `[Teams ${msg.userName}] ${msg.text}`,
        });
        this.server.sendJsonResponse(res, 200, {
          type: 'message',
          text: `Command forwarded to CLI: ${msg.text}`,
        });
        return;
      }
    }

    // Check for pull mode result retrieval
    if (this.teamsConfig.responseMode === 'pull') {
      const stored = this.pullResults.get(msg.threadId);
      if (stored) {
        debugLogger.log(
          `Teams: Returning stored pull result for conversation ${msg.threadId}`,
        );
        this.pullResults.delete(msg.threadId);
        this.server.sendJsonResponse(res, 200, {
          type: 'message',
          text: stored.text,
        });
        return;
      }
    }

    // Reject if this thread is already being processed
    if (this.processingThreads.has(msg.threadId)) {
      debugLogger.log(
        `Teams: Busy on thread ${msg.threadId} — rejecting message`,
      );
      this.server.sendJsonResponse(res, 200, {
        type: 'message',
        text: 'Auditaria está ocupado processando outro pedido nesta conversa. Tente novamente em alguns minutos.',
      });
      return;
    }

    // Route to response strategy
    switch (this.teamsConfig.responseMode) {
      case 'sync':
        void this.handleSync(msg, res);
        break;
      case 'async':
        void this.handleAsync(msg, res, false);
        break;
      case 'labeled-async':
        void this.handleAsync(msg, res, true);
        break;
      case 'pull':
        void this.handlePull(msg, res);
        break;
      case 'hybrid':
        void this.handleHybrid(msg, res);
        break;
      default:
        void this.handleSync(msg, res);
    }
  }

  // --- Sync mode ---

  private async handleSync(
    msg: TeamsIncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    debugLogger.log('Teams: [sync] Processing message...');

    const result = await this.runAgentLoop(msg, SYNC_TIMEOUT_MS);

    if (result) {
      const chunks = formatResponse(result);
      // Sync can only return one response — send the first chunk
      this.server.sendJsonResponse(res, 200, {
        type: 'message',
        text: chunks[0] || 'No response generated.',
      });
      if (chunks.length > 1) {
        debugLogger.log(
          `Teams: [sync] Response was ${chunks.length} chunks — only first chunk sent (sync limit)`,
        );
      }
    } else {
      this.server.sendJsonResponse(res, 200, {
        type: 'message',
        text: 'Processing timed out or no response generated. Try async mode for longer operations.',
      });
    }
  }

  // --- Async mode ---

  private async handleAsync(
    msg: TeamsIncomingMessage,
    res: http.ServerResponse,
    labeled: boolean,
  ): Promise<void> {
    const modeLabel = labeled ? 'labeled-async' : 'async';
    debugLogger.log(
      `Teams: [${modeLabel}] Sending ack, processing in background...`,
    );

    // Immediate ack (appears in-thread)
    this.server.sendJsonResponse(res, 200, {
      type: 'message',
      text: 'Processing your request...',
    });

    const result = await this.runAgentLoop(msg);

    if (result) {
      let text = result;
      if (labeled) {
        text = formatLabeledResponse(result, msg.userName, msg.text);
      }
      const chunks = formatResponse(text);
      for (const chunk of chunks) {
        await this.postToIncomingWebhook(chunk);
      }
      debugLogger.log(
        `Teams: [${modeLabel}] Response posted via incoming webhook (${chunks.length} chunks)`,
      );
    } else {
      await this.postToIncomingWebhook(
        `No response generated for: "${msg.text.slice(0, 100)}"`,
      );
    }
  }

  // --- Pull mode ---

  private async handlePull(
    msg: TeamsIncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    debugLogger.log('Teams: [pull] Sending ack, processing...');

    // Immediate ack
    this.server.sendJsonResponse(res, 200, {
      type: 'message',
      text: 'Working on it. @mention me again to get results.',
    });

    const result = await this.runAgentLoop(msg);

    if (result) {
      this.pullResults.set(msg.threadId, {
        text: result,
        userName: msg.userName,
        originalMessage: msg.text,
        timestamp: Date.now(),
      });
      debugLogger.log(
        `Teams: [pull] Result stored for conversation ${msg.threadId} (${result.length} chars)`,
      );
    } else {
      this.pullResults.set(msg.threadId, {
        text: 'No response generated. Try rephrasing your message.',
        userName: msg.userName,
        originalMessage: msg.text,
        timestamp: Date.now(),
      });
    }
  }

  // --- Hybrid mode ---

  private async handleHybrid(
    msg: TeamsIncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    debugLogger.log('Teams: [hybrid] Trying sync first...');

    const result = await this.runAgentLoop(msg, HYBRID_TIMEOUT_MS);

    if (result) {
      // Completed within timeout — return sync
      debugLogger.log(
        'Teams: [hybrid] Completed within timeout — sync response',
      );
      const chunks = formatResponse(result);
      this.server.sendJsonResponse(res, 200, {
        type: 'message',
        text: chunks[0] || 'No response generated.',
      });
      if (chunks.length > 1) {
        // Post remaining chunks via webhook
        for (let i = 1; i < chunks.length; i++) {
          await this.postToIncomingWebhook(chunks[i]);
        }
      }
    } else {
      // Timed out — send ack and continue async
      debugLogger.log('Teams: [hybrid] Timed out — falling back to async');
      this.server.sendJsonResponse(res, 200, {
        type: 'message',
        text: 'Processing... (taking longer than expected, results will be posted separately)',
      });

      // Re-run without timeout for async delivery
      const asyncResult = await this.runAgentLoop(msg);
      if (asyncResult) {
        const chunks = formatResponse(asyncResult);
        for (const chunk of chunks) {
          await this.postToIncomingWebhook(chunk);
        }
      }
    }
  }

  // --- Core agent loop ---

  /**
   * Runs the agent loop for a message. Returns the accumulated response text,
   * or null if timed out or no response.
   *
   * @param msg The incoming Teams message
   * @param timeoutMs Optional timeout — if provided, returns null when exceeded
   */
  private async runAgentLoop(
    msg: TeamsIncomingMessage,
    timeoutMs?: number,
  ): Promise<string | null> {
    const release = await this.acquireThreadLock(msg.threadId);
    this.processingThreads.add(msg.threadId);
    this.processing = this.processingThreads.size > 0;
    setTeamsProcessing(this.processing);

    // Get or create per-thread session
    let session;
    try {
      session = await this.sessionManager.getOrCreateSession(msg.threadId);
    } catch (err) {
      debugLogger.error('Teams: Failed to create session:', err);
      this.processingThreads.delete(msg.threadId);
      this.processing = this.processingThreads.size > 0;
      setTeamsProcessing(this.processing);
      release();
      return 'Failed to initialize AI session. Please try again.';
    }
    const geminiClient = session.client;

    // Show user message in CLI display
    pushToCliDisplay({
      type: 'user',
      text: `[Teams ${msg.userName}] ${msg.text}`,
    });

    // AUDITARIA_SESSION_MANAGEMENT_START: External provider path (Claude/Codex/Copilot)
    // When an external provider is active, bypass Gemini's scheduler loop entirely —
    // the external CLI handles tools internally via MCP bridge.
    if (this.config.isExternalProviderActive()) {
      try {
        const result = await this.runExternalProviderLoop(msg, timeoutMs);
        return result;
      } finally {
        this.processingThreads.delete(msg.threadId);
        this.processing = this.processingThreads.size > 0;
        setTeamsProcessing(this.processing);
        release();
      }
    }
    // AUDITARIA_SESSION_MANAGEMENT_END

    const abortController = new AbortController();
    const promptId = `teams-${msg.threadId}-${Date.now()}`;
    let accumulatedText = '';
    let timedOut = false;

    // Timeout handler
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutHandle = setTimeout(() => {
        debugLogger.log(
          `Teams: Timeout reached (${timeoutMs}ms) — aborting agent loop`,
        );
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
    }

    try {
      const scheduler = new Scheduler({
        config: this.config,
        messageBus: this.config.getMessageBus(),
        getPreferredEditor: () => undefined,
        schedulerId: `teams-${msg.threadId}`,
      });

      let currentParts: Part[] = [{ text: msg.text }];
      let turnCount = 0;

      // Agent loop — same pattern as TelegramService/DiscordService
      while (true) {
        if (this.stopped || timedOut) break;

        turnCount++;
        if (turnCount > 50) {
          accumulatedText += '\n\n_Maximum turns reached._';
          break;
        }

        debugLogger.debug(`Teams: Agent turn ${turnCount}`);

        const toolCallRequests: ToolCallRequestInfo[] = [];

        const responseStream = geminiClient.sendMessageStream(
          currentParts,
          abortController.signal,
          promptId,
          undefined,
          false,
          turnCount === 1 ? msg.text : undefined,
        );

        for await (const event of responseStream) {
          if (this.stopped || abortController.signal.aborted) break;

          if (event.type === GeminiEventType.Content) {
            accumulatedText += event.value;
          } else if (event.type === GeminiEventType.ToolCallRequest) {
            toolCallRequests.push(event.value);
            debugLogger.log(`Teams: Tool call requested: ${event.value.name}`);
          } else if (event.type === GeminiEventType.Error) {
            throw event.value.error;
          } else if (event.type === GeminiEventType.AgentExecutionStopped) {
            break;
          }
        }

        // Handle tool calls
        if (toolCallRequests.length > 0) {
          const completedToolCalls = await scheduler.schedule(
            toolCallRequests,
            abortController.signal,
          );

          const toolResponseParts: Part[] = [];

          for (const completed of completedToolCalls) {
            if (completed.response.error) {
              debugLogger.error(
                `Teams: tool ${completed.request.name} error:`,
                completed.response.error,
              );
            }
            if (completed.response.responseParts) {
              toolResponseParts.push(...completed.response.responseParts);
            }
          }

          // Record tool calls
          try {
            const currentModel =
              geminiClient.getCurrentSequenceModel?.() ??
              this.config.getModel();
            geminiClient
              .getChat()
              .recordCompletedToolCalls(currentModel, completedToolCalls);
            await recordToolCallInteractions(this.config, completedToolCalls);
          } catch (err) {
            debugLogger.error('Teams: error recording tool calls:', err);
          }

          // Check for stop execution
          const stopTool = completedToolCalls.find(
            (tc) => tc.response.errorType === ToolErrorType.STOP_EXECUTION,
          );
          if (stopTool) break;

          // Continue with tool results
          currentParts =
            toolResponseParts.length > 0
              ? toolResponseParts
              : [{ text: 'Tool execution completed.' }];
        } else {
          // No more tool calls — done
          break;
        }
      }

      if (timeoutHandle) clearTimeout(timeoutHandle);

      if (timedOut) {
        debugLogger.log(
          `Teams: Agent loop timed out after ${timeoutMs}ms (accumulated ${accumulatedText.length} chars)`,
        );
        return null;
      }

      // Push AI response to CLI display
      if (accumulatedText.trim()) {
        pushToCliDisplay({ type: 'gemini_content', text: accumulatedText });
      }

      debugLogger.log(
        `Teams: Agent loop complete — ${accumulatedText.length} chars, ${turnCount} turns (thread: ${msg.threadId})`,
      );

      // Save session state for persistence
      this.sessionManager.saveSession(msg.threadId);

      return accumulatedText.trim() || null;
    } catch (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (timedOut) return null;

      debugLogger.error('Teams: Agent loop error:', err);
      return formatError(err);
    } finally {
      this.processingThreads.delete(msg.threadId);
      this.processing = this.processingThreads.size > 0;
      setTeamsProcessing(this.processing);
      release();
    }
  }

  // AUDITARIA_SESSION_MANAGEMENT_START: External provider agent loop
  /**
   * Runs a message through the active external provider (Claude/Codex/Copilot).
   * The external CLI handles the full agentic loop including tool calls via MCP bridge.
   * We just collect the text response and manage session resume.
   */
  private async runExternalProviderLoop(
    msg: TeamsIncomingMessage,
    timeoutMs?: number,
  ): Promise<string | null> {
    const providerManager = this.config.getProviderManager();
    if (!providerManager) return 'No external provider configured.';

    const providerConfig = this.config.getProviderConfig();
    if (!providerConfig) return 'No external provider configured.';

    const registry = this.config.getSessionRegistry();
    const record = registry.lookup('teams-thread', msg.threadId);

    // Get or create per-thread driver
    const driver = await this.getOrCreateExternalDriver(msg.threadId);

    // Resume existing session if same provider
    if (
      record &&
      record.provider === providerConfig.type &&
      driver.setSessionId
    ) {
      driver.setSessionId(record.nativeSessionId);
      debugLogger.log(
        `Teams: Resuming ${providerConfig.type} session ${record.nativeSessionId} for thread ${msg.threadId}`,
      );
    }

    const systemContext = this.config.buildExternalProviderContext();
    const abortController = new AbortController();
    let accumulatedText = '';
    let timedOut = false;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);
    }

    try {
      for await (const event of driver.sendMessage(
        msg.text,
        abortController.signal,
        systemContext,
      )) {
        if (this.stopped || timedOut) break;
        if (event.type === ProviderEventType.Content) {
          accumulatedText += event.text;
        }
      }
    } catch (err) {
      if (!timedOut) {
        debugLogger.error('Teams: External provider error:', err);
        return formatError(err);
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (timedOut) return null;

    // Capture session ID and persist to registry
    const nativeId = driver.getSessionId();
    if (nativeId) {
      registry.save({
        contextType: 'teams-thread',
        contextId: msg.threadId,
        provider: providerConfig.type,
        nativeSessionId: nativeId,
        model: providerConfig.model,
        state: 'active',
        createdAt: record?.createdAt ?? Date.now(),
        lastActiveAt: Date.now(),
      });
    }

    if (accumulatedText.trim()) {
      pushToCliDisplay({ type: 'gemini_content', text: accumulatedText });
    }

    debugLogger.log(
      `Teams: External provider loop complete — ${accumulatedText.length} chars (thread: ${msg.threadId})`,
    );

    return accumulatedText.trim() || null;
  }

  /**
   * Gets or creates a per-thread external provider driver.
   * Each thread gets its own driver so session IDs don't clash.
   */
  private async getOrCreateExternalDriver(
    threadId: string,
  ): Promise<ProviderDriver> {
    const providerConfig = this.config.getProviderConfig();
    const currentProvider = providerConfig?.type ?? '';
    const existing = this.externalDrivers.get(threadId);

    // Reuse if same provider; dispose and recreate if provider changed
    if (existing) {
      if (existing.provider === currentProvider) return existing.driver;
      existing.driver.dispose();
      this.externalDrivers.delete(threadId);
    }

    // Create a new driver via ProviderManager — shares bridge, separate instance
    const providerManager = this.config.getProviderManager()!;
    const driver = await providerManager.createDriver();
    this.externalDrivers.set(threadId, { driver, provider: currentProvider });
    return driver;
  }
  // AUDITARIA_SESSION_MANAGEMENT_END

  // --- Incoming webhook (for async/labeled-async/hybrid responses) ---

  /**
   * Posts a message to the configured incoming webhook URL.
   * Respects the rate limit (4 messages/second).
   */
  private async postToIncomingWebhook(text: string): Promise<void> {
    if (!this.teamsConfig.webhookUrl) {
      debugLogger.error(
        'Teams: Cannot post — no incoming webhook URL configured. Use /teams webhook <url>',
      );
      return;
    }

    // Rate limiting
    const now = Date.now();
    const minInterval = 1000 / INCOMING_WEBHOOK_RATE_LIMIT;
    const elapsed = now - this.lastWebhookPost;
    if (elapsed < minInterval) {
      await new Promise((resolve) =>
        setTimeout(resolve, minInterval - elapsed),
      );
    }
    this.lastWebhookPost = Date.now();

    try {
      debugLogger.debug(
        `Teams: POST to incoming webhook (${text.length} chars)`,
      );
      const response = await fetch(this.teamsConfig.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!response.ok) {
        debugLogger.error(
          `Teams: Incoming webhook POST failed: ${response.status} ${response.statusText}`,
        );
      } else {
        debugLogger.debug('Teams: Incoming webhook POST successful');
      }
    } catch (err) {
      debugLogger.error('Teams: Incoming webhook POST error:', err);
    }
  }
}

// --- Public API ---

/**
 * Creates and starts the Teams service.
 * Uses the CLI's shared GeminiClient — same conversation, same history.
 */
export async function startTeamsService(
  config: Config,
  overrides?: Partial<TeamsConfig>,
): Promise<TeamsService> {
  const hmacSecret =
    overrides?.hmacSecret || process.env['TEAMS_HMAC_SECRET'] || '';

  const allowFrom =
    overrides?.allowFrom ||
    process.env['TEAMS_ALLOW_FROM']
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean) ||
    [];

  const teamsConfig: TeamsConfig = {
    ...TEAMS_DEFAULTS,
    ...overrides,
    enabled: true,
    hmacSecret,
    allowFrom,
  };

  const service = new TeamsService(config, teamsConfig);
  await service.start();
  return service;
}
