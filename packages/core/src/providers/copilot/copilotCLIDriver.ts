/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import {
  trackChildProcess,
  untrackChildProcess,
} from '../../utils/child-process-tracker.js';
import { coreEvents } from '../../utils/events.js'; // AUDITARIA_COPILOT_PROVIDER: signal UI refresh on usage update
import type {
  JsonRpcResponse,
  JsonRpcNotification,
  AcpInitializeResult,
  AcpNewSessionResult,
  AcpSessionUpdate,
  AcpSessionUpdateParams,
  CopilotDriverConfig,
  CopilotModelInfo,
  AcpAvailableModel,
} from './types.js';
import { injectAgentsMd, buildMcpConfigArg } from './shared.js'; // AUDITARIA_COPILOT_PROVIDER: shared with the PTY driver

const DEBUG = false;
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[COPILOT_DRIVER]', ...args); // eslint-disable-line no-console
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Persistent cache for Copilot models (~/.auditaria/copilot-models.json)
// Stores full model info (name, description, usage) from ACP session/new.
// Loaded on first access so the UI can show models without spawning Copilot.
// ---------------------------------------------------------------------------

const MODELS_CACHE_FILE = join(homedir(), '.auditaria', 'copilot-models.json');
let cachedModels: CopilotModelInfo[] | null = null; // null = not loaded yet

/** Load cached model data from disk (once). */
function loadModelsCacheFromDisk(): CopilotModelInfo[] {
  if (cachedModels !== null) return cachedModels;
  cachedModels = [];
  try {
    if (existsSync(MODELS_CACHE_FILE)) {
      const data: unknown = JSON.parse(
        readFileSync(MODELS_CACHE_FILE, 'utf-8'),
      );
      if (Array.isArray(data)) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- own cache file, written by saveModelsCacheToDisk with this exact shape
        cachedModels = data as CopilotModelInfo[];
        dbg('loaded models cache from disk', cachedModels.length, 'entries');
      }
    }
  } catch {
    // Corrupt or missing file — start fresh
  }
  return cachedModels;
}

/** Save current models cache to disk. */
function saveModelsCacheToDisk(models: CopilotModelInfo[]): void {
  try {
    const dir = join(homedir(), '.auditaria');
    mkdirSync(dir, { recursive: true });
    writeFileSync(MODELS_CACHE_FILE, JSON.stringify(models, null, 2));
    dbg('saved models cache to disk', models.length, 'entries');
  } catch {
    // Best-effort persist
  }
}

/** Get the usage multiplier for a Copilot model (e.g., '1x', '3x', '0.33x'). */
export function getCopilotModelUsage(modelId: string): string | undefined {
  const models = loadModelsCacheFromDisk();
  return models.find((m) => m.value === modelId)?.copilotUsage ?? undefined;
}

/** Get cached Copilot models (from last ACP session/new). Returns [] if no cache. */
export function getCachedCopilotModels(): CopilotModelInfo[] {
  return loadModelsCacheFromDisk();
}

function getShellOption(): boolean | string {
  return process.platform === 'win32' ? 'powershell.exe' : true;
}

// ---------------------------------------------------------------------------
// Pending request tracker for JSON-RPC request/response matching
// ---------------------------------------------------------------------------

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export class CopilotCLIDriver implements ProviderDriver {
  private proc: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private sessionId: string | undefined;
  private availableModels: CopilotModelInfo[] = [];
  private initialized = false;
  private currentPromptFilePath: string | null = null;

  // Notification handler set during sendMessage to yield events
  private notificationHandler:
    | ((method: string, params: unknown) => void)
    | null = null;

  // Stderr collection for error reporting
  private stderrChunks: string[] = [];

  constructor(private readonly config: CopilotDriverConfig) {
    dbg('constructor', { model: config.model, cwd: config.cwd });
  }

  // ---------------------------------------------------------------------------
  // ProviderDriver interface
  // ---------------------------------------------------------------------------

  async *sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
    attachmentFiles?: Array<import('../types.js').AttachmentFile>, // AUDITARIA_ATTACHMENTS: ACP image support
  ): AsyncGenerator<ProviderEvent> {
    // Ensure subprocess is running and initialized
    if (!this.initialized) {
      await this.ensureInitialized();
    }

    // Inject system context into AGENTS.md (Copilot's custom instructions file)
    if (systemContext) {
      injectAgentsMd(this.config.cwd, systemContext);
    }

    dbg('sendMessage', {
      promptLen: prompt.length,
      hasSystemContext: !!systemContext,
      sessionId: this.sessionId,
    });

    // Build prompt content array (ACP format: {type:'text', text:...}, {type:'image', data:..., mimeType:...})
    const promptContent: Array<Record<string, unknown>> = [];
    promptContent.push({ type: 'text', text: prompt });

    // AUDITARIA_ATTACHMENTS: Add image content blocks for ACP protocol
    if (attachmentFiles?.length) {
      for (const f of attachmentFiles) {
        if (f.data) {
          promptContent.push({
            type: 'image',
            data: f.data,
            mimeType: f.mimeType,
          });
        }
      }
      dbg(`added ${attachmentFiles.length} image content blocks to prompt`);
    }

    // Set up event collection channel
    const eventQueue: Array<ProviderEvent | null> = []; // null = done
    let eventResolve: (() => void) | null = null;

    const pushEvent = (event: ProviderEvent | null) => {
      eventQueue.push(event);
      if (eventResolve) {
        const r = eventResolve;
        eventResolve = null;
        r();
      }
    };

    // AUDITARIA_COPILOT_PROVIDER: Detect /compact so we can synthesize a
    // Compacted event on success (see resolve handler below).
    const isCompactCommand = prompt
      .trimStart()
      .toLowerCase()
      .startsWith('/compact');
    let lastAgentText = '';

    // Install notification handler for this turn
    this.notificationHandler = (method: string, params: unknown) => {
      const events = this.handleNotification(method, params);
      for (const event of events) {
        if (isCompactCommand && event.type === ProviderEventType.Content) {
          // Accumulate so we can ship the model-generated summary as
          // CompactionSummary if Copilot writes one.
          lastAgentText += event.text;
        }
        pushEvent(event);
      }
    };

    // Handle abort
    const abortHandler = () => {
      dbg('abort triggered');
      this.sendCancel().catch(() => {});
      pushEvent({
        type: ProviderEventType.Error,
        message: 'Request cancelled',
      });
      pushEvent(null);
    };
    signal.addEventListener('abort', abortHandler, { once: true });

    try {
      // Send the prompt request (async — response arrives when turn completes)
      const promptRequestId = this.sendRequest('session/prompt', {
        sessionId: this.sessionId,
        prompt: promptContent,
      });

      // Wait for the prompt response in the background
      this.pendingRequests.get(promptRequestId)!.resolve = (
        result: unknown,
      ) => {
        dbg('prompt completed', result);
        // AUDITARIA_COPILOT_PROVIDER: synthesize Compacted (+CompactionSummary if
        // any agent text was streamed) before Finished so compactNative can
        // detect success.
        if (isCompactCommand) {
          pushEvent({
            type: ProviderEventType.Compacted,
            preTokens: 0,
            trigger: 'manual',
          });
          if (lastAgentText.trim().length > 0) {
            pushEvent({
              type: ProviderEventType.CompactionSummary,
              summary: lastAgentText,
            });
          }
        }
        // Yield finished event
        pushEvent({ type: ProviderEventType.Finished });
        pushEvent(null);
      };
      // Override reject to push error
      const origPending = this.pendingRequests.get(promptRequestId)!;
      origPending.reject = (error: Error) => {
        dbg('prompt error', error);
        pushEvent({
          type: ProviderEventType.Error,
          message: error.message,
        });
        pushEvent(null);
      };

      // Yield events as they arrive
      while (true) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          if (event === null) break;
          yield event;
        } else {
          await new Promise<void>((resolve) => {
            eventResolve = resolve;
            // Also check if events arrived before we set the resolver
            if (eventQueue.length > 0) {
              eventResolve = null;
              resolve();
            }
          });
        }
      }
    } finally {
      signal.removeEventListener('abort', abortHandler);
      this.notificationHandler = null;
      dbg('sendMessage FINALLY');
    }
  }

  async interrupt(): Promise<void> {
    await this.sendCancel();
  }

  getSessionId(): string | undefined {
    // AUDITARIA_COPILOT_PROVIDER: Report either the active session or the
    // queued resume target. Without this, callers (e.g. compactNative)
    // can't tell that we're about to operate on a real session between
    // setSessionId() and the actual session/load. Matches Claude/Codex
    // semantics where setSessionId immediately influences getSessionId.
    return this.sessionId ?? this.resumeSessionId;
  }

  // AUDITARIA_SESSION_MANAGEMENT_START: Session resume via ACP session/load
  private resumeSessionId?: string;

  setSessionId(id: string): void {
    this.resumeSessionId = id;
  }
  readonly canResume = true;
  // AUDITARIA_SESSION_MANAGEMENT_END

  resetSession(): void {
    this.disposeSubprocess();
    // this._removeAgentsMdSection(); // Not worth the extra write — inject handles stale content
    this.sessionId = undefined;
    this.resumeSessionId = undefined; // AUDITARIA_SESSION_MANAGEMENT
    this.availableModels = [];
    this.initialized = false;
  }

  dispose(): void {
    this.disposeSubprocess();
    // this._removeAgentsMdSection(); // Not worth the extra write — inject handles stale content
    if (this.currentPromptFilePath) {
      try {
        unlinkSync(this.currentPromptFilePath);
      } catch {
        /* ignore */
      }
      this.currentPromptFilePath = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public: Model discovery
  // ---------------------------------------------------------------------------

  getAvailableModels(): CopilotModelInfo[] {
    return this.availableModels;
  }

  // ---------------------------------------------------------------------------
  // Subprocess lifecycle
  // ---------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.proc) return;

    // Build spawn args: copilot --acp --stdio --allow-all [--additional-mcp-config @filepath]
    // --allow-all bypasses permission prompts (like Claude's --dangerously-skip-permissions)
    const args = ['--acp', '--stdio', '--allow-all'];
    const mcpArg = buildMcpConfigArg(this.config);
    if (mcpArg) {
      args.push('--additional-mcp-config', mcpArg);
    }

    // Spawn copilot subprocess
    const proc = spawn('copilot', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.cwd,
      shell: getShellOption(),
    });
    this.proc = proc;
    if (proc.pid) trackChildProcess(proc.pid);
    dbg('spawned', { pid: proc.pid });

    // Collect stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrChunks.push(text);
      dbg('stderr:', text.trim());
    });

    // Set up NDJSON readline on stdout
    this.readline = createInterface({ input: proc.stdout });
    this.readline.on('line', (line: string) => {
      this.handleLine(line);
    });

    // Handle subprocess exit
    proc.on('exit', (code) => {
      dbg('subprocess exited', { code });
      // Reject all pending requests
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`Copilot CLI exited with code ${code}`));
        this.pendingRequests.delete(id);
      }
      this.proc = null;
      this.readline = null;
      this.initialized = false;
    });

    proc.on('error', (err) => {
      dbg('subprocess error', err);
    });

    // 1. Send initialize (requires protocolVersion)
    const initResult = await this.sendRequestAsync<AcpInitializeResult>(
      'initialize',
      {
        protocolVersion: 1,
        clientInfo: {
          name: 'auditaria-cli',
          version: '1.0.0',
        },
      },
    );
    dbg('initialize result', initResult);

    // AUDITARIA_SESSION_MANAGEMENT_START: Resume existing session or create new
    if (this.resumeSessionId) {
      // Resume via session/load — replays history as notifications (consumed silently by handleLine)
      await this.sendRequestAsync('session/load', {
        sessionId: this.resumeSessionId,
        cwd: this.config.cwd,
        mcpServers: [],
      });
      this.sessionId = this.resumeSessionId;
      this.resumeSessionId = undefined;
      dbg('session/load result', { sessionId: this.sessionId });
    } else {
      // 2. Send session/new (requires cwd + mcpServers)
      const newSessionResult = await this.sendRequestAsync<AcpNewSessionResult>(
        'session/new',
        {
          cwd: this.config.cwd,
          mcpServers: [],
        },
      );
      this.sessionId = newSessionResult.sessionId;
      dbg('session/new result', { sessionId: this.sessionId });

      // 3. Parse available models from models.availableModels
      if (newSessionResult.models?.availableModels) {
        this.parseModelsFromResult(
          newSessionResult.models.availableModels,
          newSessionResult.models.currentModelId,
        );
      }
    }
    // AUDITARIA_SESSION_MANAGEMENT_END

    // 4. Set the requested model if specified
    if (this.config.model) {
      await this.setModel(this.config.model);
    }

    this.initialized = true;
    dbg('initialized', {
      sessionId: this.sessionId,
      modelCount: this.availableModels.length,
    });
  }

  private disposeSubprocess(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.proc?.pid) {
      void killProcessGroup({ pid: this.proc.pid, escalate: true });
      untrackChildProcess(this.proc.pid);
    }
    this.proc = null;
    this.initialized = false;
    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('Driver disposed'));
    }
    this.pendingRequests.clear();
    this.stderrChunks = [];
  }

  // ---------------------------------------------------------------------------
  // JSON-RPC communication
  // ---------------------------------------------------------------------------

  private sendRequest(method: string, params: unknown): number {
    const id = this.nextRequestId++;
    const msg = { jsonrpc: '2.0' as const, id, method, params };
    const line = JSON.stringify(msg);
    dbg('>>> send', method, id);
    this.proc?.stdin?.write(line + '\n');

    // Create pending entry with placeholder callbacks
    this.pendingRequests.set(id, {
      resolve: () => {},
      reject: () => {},
    });

    return id;
  }

  private sendRequestAsync<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextRequestId++;
    const msg = { jsonrpc: '2.0' as const, id, method, params };
    const line = JSON.stringify(msg);
    dbg('>>> sendAsync', method, id);
    this.proc?.stdin?.write(line + '\n');

    return new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(id, {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSON-RPC result shape is guaranteed by the method contract each caller requests
        resolve: (result) => resolve(result as T),
        reject,
      });

      // Timeout after 30 seconds for initialization calls
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Timeout waiting for ${method} response`));
        }
      }, 30_000);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) {
        dbg('non-object JSON line:', line.slice(0, 200));
        return;
      }
      msg = parsed;
    } catch {
      dbg('invalid JSON line:', line.slice(0, 200));
      return;
    }

    // Check if it's a response (has `id` and no `method`)
    if ('id' in msg && typeof msg.id === 'number' && !('method' in msg)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape guarded by the id/method checks above; fields accessed defensively
      const response = msg as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(
            new Error(
              `RPC error: ${response.error.message} (code: ${response.error.code})`,
            ),
          );
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Check if it's a notification (has `method`, no `id`)
    if ('method' in msg && typeof msg.method === 'string' && !('id' in msg)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape guarded by the method/id checks above
      const notification = msg as unknown as JsonRpcNotification;
      dbg('<<< notification', notification.method);

      // Route to the notification handler if one is installed
      if (this.notificationHandler) {
        this.notificationHandler(notification.method, notification.params);
      }
      return;
    }

    // It's a request from the agent (e.g., fs/read_text_file, session/request_permission)
    if ('id' in msg && 'method' in msg) {
      this.handleAgentRequest(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape guarded by the id/method checks above; params handled per-method
        msg as unknown as { id: number; method: string; params: unknown },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Notification → ProviderEvent mapping
  //
  // Real notification structure:
  // params.sessionId: string
  // params.update.sessionUpdate: AcpUpdateKind
  // params.update.content?: { type: 'text', text: string }
  // params.update.toolCallId?: string
  // params.update.title?: string
  // params.update.kind?: string
  // params.update.status?: string
  // params.update.rawOutput?: { content?: string }
  // ---------------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): ProviderEvent[] {
    if (method !== 'session/update') return [];

    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- ACP session/update contract; all fields are accessed defensively below
    const typedParams = params as AcpSessionUpdateParams;
    const update: AcpSessionUpdate = typedParams?.update;
    if (!update) return [];

    const events: ProviderEvent[] = [];

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.text) {
          events.push({
            type: ProviderEventType.Content,
            text: update.content.text,
          });
        }
        break;

      case 'agent_thought_chunk':
        if (update.content?.text) {
          events.push({
            type: ProviderEventType.Thinking,
            text: update.content.text,
          });
        }
        break;

      case 'tool_call':
        if (update.toolCallId && update.title) {
          events.push({
            type: ProviderEventType.ToolUse,
            toolName: update.title,
            toolId: update.toolCallId,
            input: update.rawInput || {},
          });
        }
        break;

      case 'tool_call_update':
        if (update.toolCallId && update.status === 'completed') {
          events.push({
            type: ProviderEventType.ToolResult,
            toolId: update.toolCallId,
            output: update.rawOutput?.content || '',
            isError: false,
          });
        } else if (update.toolCallId && update.status === 'failed') {
          events.push({
            type: ProviderEventType.ToolResult,
            toolId: update.toolCallId,
            output: update.rawOutput?.content || 'Tool execution failed',
            isError: true,
          });
        }
        break;

      case 'plan':
        if (update.content?.text) {
          events.push({
            type: ProviderEventType.Thinking,
            text: update.content.text,
          });
        }
        break;

      // mode_update, available_commands_update — ignore for now
      default:
        dbg('unhandled update kind:', update.sessionUpdate);
        break;
    }

    return events;
  }

  // ---------------------------------------------------------------------------
  // Agent-initiated requests (fs/read, fs/write, permission)
  // ---------------------------------------------------------------------------

  private handleAgentRequest(request: {
    id: number;
    method: string;
    params: unknown;
  }): void {
    dbg('agent request', request.method, request.id);

    switch (request.method) {
      case 'session/request_permission': {
        // Auto-approve all permissions (bypassPermissions mode)
        this.sendResponse(request.id, 'allow_once');
        break;
      }
      case 'fs/read_text_file': {
        // Read file and respond
        const params = isRecord(request.params) ? request.params : undefined;
        const path =
          typeof params?.['path'] === 'string' ? params['path'] : undefined;
        if (path) {
          try {
            const content = readFileSync(path, 'utf-8');
            this.sendResponse(request.id, { content });
          } catch (e) {
            this.sendErrorResponse(
              request.id,
              -1,
              `Failed to read file: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          this.sendErrorResponse(request.id, -1, 'Missing path parameter');
        }
        break;
      }
      case 'fs/write_text_file': {
        const params = isRecord(request.params) ? request.params : undefined;
        const path =
          typeof params?.['path'] === 'string' ? params['path'] : undefined;
        const content =
          typeof params?.['content'] === 'string'
            ? params['content']
            : undefined;
        if (path && content !== undefined) {
          try {
            writeFileSync(path, content);
            this.sendResponse(request.id, {});
          } catch (e) {
            this.sendErrorResponse(
              request.id,
              -1,
              `Failed to write file: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          this.sendErrorResponse(
            request.id,
            -1,
            'Missing path or content parameter',
          );
        }
        break;
      }
      default:
        // Unknown method — respond with "not supported" error
        this.sendErrorResponse(
          request.id,
          -32601,
          `Method not found: ${request.method}`,
        );
        break;
    }
  }

  private sendResponse(id: number, result: unknown): void {
    const msg = { jsonrpc: '2.0' as const, id, result };
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private sendErrorResponse(id: number, code: number, message: string): void {
    const msg = { jsonrpc: '2.0' as const, id, error: { code, message } };
    this.proc?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  // ---------------------------------------------------------------------------
  // Model discovery & switching
  // ---------------------------------------------------------------------------

  private parseModelsFromResult(
    models: AcpAvailableModel[],
    currentModelId?: string,
  ): void {
    const parsed: CopilotModelInfo[] = [];

    // Auto option first
    const defaultUsage = currentModelId
      ? models.find((m) => m.modelId === currentModelId)?._meta?.copilotUsage
      : undefined;
    parsed.push({
      value: 'auto',
      name: 'Auto',
      description: currentModelId
        ? `Uses Copilot's default model (${currentModelId})`
        : "Uses Copilot's default model",
      copilotUsage: defaultUsage,
    });

    for (const m of models) {
      parsed.push({
        value: m.modelId,
        name: m.name,
        description: m.description,
        copilotUsage: m._meta?.copilotUsage,
      });
    }

    // Check if anything changed vs cached data
    const oldCache = loadModelsCacheFromDisk();
    const changed = JSON.stringify(parsed) !== JSON.stringify(oldCache);

    // Update in-memory cache
    cachedModels = parsed;

    // Persist to disk and signal UI refresh if data changed
    if (changed) {
      saveModelsCacheToDisk(parsed);
      coreEvents.emitModelChanged(this.config.model || 'auto');
    }

    this.availableModels = parsed;
    dbg(
      'parsed models',
      this.availableModels.map(
        (m) => `${m.value}${m.copilotUsage ? ` (${m.copilotUsage})` : ''}`,
      ),
    );
  }

  private async setModel(modelValue: string): Promise<void> {
    if (modelValue === 'auto') return; // Auto means use the default

    try {
      // ACP uses session/set_model (not session/set_config_option)
      await this.sendRequestAsync<Record<string, unknown>>(
        'session/set_model',
        {
          sessionId: this.sessionId,
          modelId: modelValue,
        },
      );
      dbg('model set to', modelValue);
    } catch (e) {
      dbg('failed to set model', e);
      // Non-fatal — Copilot will use its default
    }
  }

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------

  private async sendCancel(): Promise<void> {
    if (!this.sessionId || !this.proc) return;
    try {
      await this.sendRequestAsync('session/cancel', {
        sessionId: this.sessionId,
      });
    } catch {
      // Best-effort cancel
    }
  }

  // AUDITARIA_COPILOT_PROVIDER: AGENTS.md injection and the MCP bridge
  // config file moved to shared.ts (shared with copilotPtyDriver).
}
