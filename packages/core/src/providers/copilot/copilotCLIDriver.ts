// AUDITARIA_COPILOT_PROVIDER: ACP-based driver for GitHub Copilot CLI

import { spawn, type ChildProcess } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ProviderDriver, ProviderEvent } from '../types.js';
import { ProviderEventType } from '../types.js';
import { killProcessGroup } from '../../utils/process-utils.js';
import { trackChildProcess, untrackChildProcess } from '../../utils/child-process-tracker.js';
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

const DEBUG = false;
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[COPILOT_DRIVER]', ...args); // eslint-disable-line no-console
}

// ---------------------------------------------------------------------------
// Persistent cache for Copilot usage multipliers (~/.auditaria/copilot-usage.json)
// Loaded on first access, updated when ACP session/new returns fresh data.
// ---------------------------------------------------------------------------

const USAGE_CACHE_FILE = join(homedir(), '.auditaria', 'copilot-usage.json');
const copilotUsageCache = new Map<string, string>();
let usageCacheLoaded = false;

/** Load cached usage data from disk (once). */
function loadUsageCacheFromDisk(): void {
  if (usageCacheLoaded) return;
  usageCacheLoaded = true;
  try {
    if (existsSync(USAGE_CACHE_FILE)) {
      const data = JSON.parse(readFileSync(USAGE_CACHE_FILE, 'utf-8')) as Record<string, string>;
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') copilotUsageCache.set(k, v);
      }
      dbg('loaded usage cache from disk', copilotUsageCache.size, 'entries');
    }
  } catch {
    // Corrupt or missing file — start fresh
  }
}

/** Save current cache to disk (only if changed). */
function saveUsageCacheToDisk(): void {
  try {
    const dir = join(homedir(), '.auditaria');
    mkdirSync(dir, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of copilotUsageCache) obj[k] = v;
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(obj, null, 2));
    dbg('saved usage cache to disk', copilotUsageCache.size, 'entries');
  } catch {
    // Best-effort persist
  }
}

/** Get the usage multiplier for a Copilot model (e.g., '1x', '3x', '0.33x'). */
export function getCopilotModelUsage(modelId: string): string | undefined {
  loadUsageCacheFromDisk();
  return copilotUsageCache.get(modelId);
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
  private lastAgentsMdContent: string | null = null; // Track injected content for cleanup

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
  ): AsyncGenerator<ProviderEvent> {
    // Ensure subprocess is running and initialized
    if (!this.initialized) {
      await this.ensureInitialized();
    }

    // Inject system context into AGENTS.md (Copilot's custom instructions file)
    if (systemContext) {
      this.injectAgentsMd(systemContext);
    }

    dbg('sendMessage', { promptLen: prompt.length, hasSystemContext: !!systemContext, sessionId: this.sessionId });

    // Build prompt content array (ACP format: {type:'text', text:...})
    const promptContent: Array<Record<string, unknown>> = [];
    promptContent.push({ type: 'text', text: prompt });

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

    // Install notification handler for this turn
    this.notificationHandler = (method: string, params: unknown) => {
      const events = this.handleNotification(method, params);
      for (const event of events) {
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
      this.pendingRequests.get(promptRequestId)!.resolve = (result: unknown) => {
        dbg('prompt completed', result);
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
    return this.sessionId;
  }

  resetSession(): void {
    this.disposeSubprocess();
    this.removeAgentsMdSection();
    this.sessionId = undefined;
    this.availableModels = [];
    this.initialized = false;
  }

  dispose(): void {
    this.disposeSubprocess();
    this.removeAgentsMdSection();
    if (this.currentPromptFilePath) {
      try { unlinkSync(this.currentPromptFilePath); } catch { /* ignore */ }
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
    const mcpArg = this.buildMcpConfigArg();
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
    this.readline = createInterface({ input: proc.stdout! });
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
    const initResult = await this.sendRequestAsync<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'auditaria-cli',
        version: '1.0.0',
      },
    });
    dbg('initialize result', initResult);

    // 2. Send session/new (requires cwd + mcpServers)
    const newSessionResult = await this.sendRequestAsync<AcpNewSessionResult>('session/new', {
      cwd: this.config.cwd,
      mcpServers: [],
    });
    this.sessionId = newSessionResult.sessionId;
    dbg('session/new result', { sessionId: this.sessionId });

    // 3. Parse available models from models.availableModels
    if (newSessionResult.models?.availableModels) {
      this.parseModelsFromResult(newSessionResult.models.availableModels,
        newSessionResult.models.currentModelId);
    }

    // 4. Set the requested model if specified
    if (this.config.model) {
      await this.setModel(this.config.model);
    }

    this.initialized = true;
    dbg('initialized', { sessionId: this.sessionId, modelCount: this.availableModels.length });
  }

  private disposeSubprocess(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    if (this.proc?.pid) {
      killProcessGroup({ pid: this.proc.pid, escalate: true });
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
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      dbg('invalid JSON line:', line.slice(0, 200));
      return;
    }

    // Check if it's a response (has `id` and no `method`)
    if ('id' in msg && typeof msg.id === 'number' && !('method' in msg)) {
      const response = msg as unknown as JsonRpcResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        if (response.error) {
          pending.reject(new Error(`RPC error: ${response.error.message} (code: ${response.error.code})`));
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Check if it's a notification (has `method`, no `id`)
    if ('method' in msg && typeof msg.method === 'string' && !('id' in msg)) {
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
      this.handleAgentRequest(msg as unknown as { id: number; method: string; params: unknown });
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

  private handleAgentRequest(request: { id: number; method: string; params: unknown }): void {
    dbg('agent request', request.method, request.id);

    switch (request.method) {
      case 'session/request_permission': {
        // Auto-approve all permissions (bypassPermissions mode)
        this.sendResponse(request.id, 'allow_once');
        break;
      }
      case 'fs/read_text_file': {
        // Read file and respond
        const params = request.params as { path?: string } | undefined;
        if (params?.path) {
          try {
            const content = readFileSync(params.path, 'utf-8');
            this.sendResponse(request.id, { content });
          } catch (e) {
            this.sendErrorResponse(request.id, -1, `Failed to read file: ${(e as Error).message}`);
          }
        } else {
          this.sendErrorResponse(request.id, -1, 'Missing path parameter');
        }
        break;
      }
      case 'fs/write_text_file': {
        const params = request.params as { path?: string; content?: string } | undefined;
        if (params?.path && params.content !== undefined) {
          try {
            writeFileSync(params.path, params.content);
            this.sendResponse(request.id, {});
          } catch (e) {
            this.sendErrorResponse(request.id, -1, `Failed to write file: ${(e as Error).message}`);
          }
        } else {
          this.sendErrorResponse(request.id, -1, 'Missing path or content parameter');
        }
        break;
      }
      default:
        // Unknown method — respond with "not supported" error
        this.sendErrorResponse(request.id, -32601, `Method not found: ${request.method}`);
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

  private parseModelsFromResult(models: AcpAvailableModel[], currentModelId?: string): void {
    const parsed: CopilotModelInfo[] = [];

    // Load existing cache from disk first (so we can detect changes)
    loadUsageCacheFromDisk();

    // Build fresh usage map from ACP response
    const freshUsage = new Map<string, string>();
    for (const m of models) {
      if (m._meta?.copilotUsage) {
        freshUsage.set(m.modelId, m._meta.copilotUsage);
      }
    }

    // Check if anything changed
    let changed = freshUsage.size !== copilotUsageCache.size;
    if (!changed) {
      for (const [k, v] of freshUsage) {
        if (copilotUsageCache.get(k) !== v) { changed = true; break; }
      }
    }

    // Update in-memory cache
    copilotUsageCache.clear();
    for (const [k, v] of freshUsage) copilotUsageCache.set(k, v);

    // Persist to disk and signal UI refresh if data changed
    if (changed) {
      saveUsageCacheToDisk();
      // Emit model changed to trigger web model menu rebuild with fresh usage data
      coreEvents.emitModelChanged(this.config.model || 'auto');
    }

    // Auto option first
    const defaultUsage = currentModelId ? copilotUsageCache.get(currentModelId) : undefined;
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

    this.availableModels = parsed;
    dbg('parsed models', this.availableModels.map((m) => `${m.value}${m.copilotUsage ? ` (${m.copilotUsage})` : ''}`));
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

  // ---------------------------------------------------------------------------
  // System context injection via AGENTS.md
  // Copilot reads AGENTS.md as custom instructions. We inject/update a marked
  // section with our system context (audit context, memory, skills).
  // ---------------------------------------------------------------------------

  private static readonly AGENTS_MD_START = '##### AUDITARIA SYSTEM PROMPT CONTEXT';
  private static readonly AGENTS_MD_END = '##### END OF AUDITARIA SYSTEM PROMPT CONTEXT';

  private getAgentsMdPath(): string {
    return join(this.config.cwd, 'AGENTS.md');
  }

  /**
   * Inject or update our marked section in AGENTS.md.
   * - If file doesn't exist → create with just our section
   * - If markers exist → replace content between them (only if changed)
   * - If no markers → append section at end
   */
  private injectAgentsMd(systemContext: string): void {
    const filePath = this.getAgentsMdPath();
    const section = `${CopilotCLIDriver.AGENTS_MD_START}\n${systemContext}\n${CopilotCLIDriver.AGENTS_MD_END}`;

    // Skip write if content unchanged
    if (this.lastAgentsMdContent === systemContext) return;

    try {
      let existing = '';
      try {
        existing = readFileSync(filePath, 'utf-8');
      } catch {
        // File doesn't exist — will create
      }

      const startIdx = existing.indexOf(CopilotCLIDriver.AGENTS_MD_START);
      const endIdx = existing.indexOf(CopilotCLIDriver.AGENTS_MD_END);

      let newContent: string;
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        // Replace existing section
        const before = existing.slice(0, startIdx);
        const after = existing.slice(endIdx + CopilotCLIDriver.AGENTS_MD_END.length);
        newContent = before + section + after;
      } else if (existing.trim()) {
        // Append to existing file
        newContent = existing.trimEnd() + '\n\n' + section + '\n';
      } else {
        // New file
        newContent = section + '\n';
      }

      // Only write if the file content actually changed
      if (newContent !== existing) {
        writeFileSync(filePath, newContent, 'utf-8');
        dbg('AGENTS.md updated');
      }
      this.lastAgentsMdContent = systemContext;
    } catch (e) {
      dbg('AGENTS.md injection failed', e);
    }
  }

  /** Remove our marked section from AGENTS.md on dispose. */
  private removeAgentsMdSection(): void {
    if (this.lastAgentsMdContent === null) return; // Never injected
    this.lastAgentsMdContent = null;

    try {
      const filePath = this.getAgentsMdPath();
      const existing = readFileSync(filePath, 'utf-8');

      const startIdx = existing.indexOf(CopilotCLIDriver.AGENTS_MD_START);
      const endIdx = existing.indexOf(CopilotCLIDriver.AGENTS_MD_END);
      if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return;

      const before = existing.slice(0, startIdx);
      const after = existing.slice(endIdx + CopilotCLIDriver.AGENTS_MD_END.length);
      const cleaned = (before + after).replace(/\n{3,}/g, '\n\n').trim();

      if (cleaned) {
        writeFileSync(filePath, cleaned + '\n', 'utf-8');
      } else {
        // File was only our section — delete it
        unlinkSync(filePath);
      }
      dbg('AGENTS.md cleaned up');
    } catch {
      // Best-effort cleanup
    }
  }

  // ---------------------------------------------------------------------------
  // MCP config via --additional-mcp-config @filepath
  // Writes JSON to ~/.auditaria/copilot-mcp-{port}.json, passes @path to CLI.
  // Port in filename prevents conflicts between parallel Auditaria instances.
  // (PowerShell mangles raw JSON in args, so @filepath is required on Windows.)
  // ---------------------------------------------------------------------------

  private buildMcpConfigArg(): string | undefined {
    const hasBridge = this.config.toolBridgePort && this.config.toolBridgeScript;
    if (!hasBridge) return undefined;

    const nodePath = process.execPath;
    const scriptPath = this.config.toolBridgeScript!;
    const port = this.config.toolBridgePort!;

    const bridgeArgs = [scriptPath, '--port', String(port)];
    if (this.config.toolBridgeExclude?.length) {
      for (const name of this.config.toolBridgeExclude) {
        bridgeArgs.push('--exclude', name);
      }
    }

    const mcpConfig = {
      mcpServers: {
        auditaria_tools: {
          command: nodePath,
          args: bridgeArgs,
        },
      },
    };

      // Write to file only if content changed, return @filepath reference
    // Include port in filename so parallel Auditaria instances don't conflict
    const dir = join(homedir(), '.auditaria');
    const filePath = join(dir, `copilot-mcp-${port}.json`);
    const newContent = JSON.stringify(mcpConfig, null, 2);

    let needsWrite = true;
    try {
      if (existsSync(filePath) && readFileSync(filePath, 'utf-8') === newContent) {
        needsWrite = false;
      }
    } catch { /* missing or unreadable — write */ }

    if (needsWrite) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, newContent);
      dbg('MCP config written', { filePath });
    }
    return `@${filePath}`;
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private tryParseJson(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
