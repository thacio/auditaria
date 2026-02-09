/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Content, Part, PartListUnion } from '@google/genai';
import {
  GeminiEventType,
  CompressionStatus,
  type ServerGeminiStreamEvent,
  Turn,
} from '../core/turn.js';
import { findCompressSplitPoint } from '../services/chatCompressionService.js';
import type { GeminiChat } from '../core/geminiChat.js';
import type {
  ProviderConfig,
  ProviderDriver,
  ExternalMCPServerConfig,
} from './types.js';
import { ProviderEventType } from './types.js';
import { adaptProviderEvent } from './eventAdapter.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutorServer } from './mcp-bridge/toolExecutorServer.js';
import { estimateTokenCountSync } from '../utils/tokenCalculation.js';
import { getEnvironmentContext } from '../utils/environmentContext.js';
import type { Config } from '../config/config.js';

const DEBUG = false; // AUDITARIA_CLAUDE_PROVIDER: Debug logging disabled
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[PROVIDER_MGR]', ...args); // eslint-disable-line no-console
}

// Heuristic underestimation correction factor (15%).
// estimateTokenCountSync uses character-based heuristics that consistently undercount
// due to tokenizer overhead, special tokens, and formatting not captured by char ratios.
export const ESTIMATION_CORRECTION_FACTOR = 1.15;

// When true, Claude's token estimation includes base overhead (system prompt + CLAUDE.md)
// in the used context calculation. This makes the context percentage reflect total usage
// including fixed costs. When false, only conversation content is counted.
export const CLAUDE_INCLUDE_OVERHEAD = true;

// Filter out the initial environment context from history parts for token estimation.
// The env context (from getEnvironmentContext()) is already injected separately to external
// providers, so we skip it to avoid double-counting tokens.
// envContextPrefix: first 30 chars of the env context text, used to identify the message.
export function getHistoryPartsForEstimation(history: Content[], envContextPrefix?: string): Part[] {
  if (!envContextPrefix) {
    // No prefix to match — return all parts (Gemini path, or prefix not yet computed)
    return history.flatMap(c => c.parts || []);
  }
  const parts: Part[] = [];
  let skippedEnvContext = false;
  for (const content of history) {
    if (!skippedEnvContext && content.role === 'user' && content.parts?.length) {
      const firstPart = content.parts[0];
      if (firstPart && 'text' in firstPart && typeof firstPart.text === 'string'
          && firstPart.text.startsWith(envContextPrefix)) {
        skippedEnvContext = true;
        // Skip only the env context part, keep any other parts in this message
        const remaining = content.parts.slice(1);
        if (remaining.length > 0) parts.push(...remaining);
        continue;
      }
    }
    if (content.parts) parts.push(...content.parts);
  }
  return parts;
}

// Estimate Claude's base overhead: system prompt (~6K) + system tools (~17K) + CLAUDE.md (variable)
// This accounts for tokens that Claude uses before any conversation history
export function estimateClaudeBaseOverhead(cwd: string): number {
  const SYSTEM_PROMPT_AND_TOOLS = 23000; // system prompt ~6K + system tools ~17K
  let claudeMdTokens = 0;

  // Read CLAUDE.md from working directory if it exists
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  try {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      claudeMdTokens = estimateTokenCountSync([{ text: content }]);
      dbg(`[OVERHEAD] CLAUDE.md found: ${content.length} chars → ${claudeMdTokens} tokens`);
    }
  } catch {
    dbg('[OVERHEAD] Failed to read CLAUDE.md, using 0 for its tokens');
  }

  const total = SYSTEM_PROMPT_AND_TOOLS + claudeMdTokens;
  dbg(`[OVERHEAD] system: ${SYSTEM_PROMPT_AND_TOOLS}T + CLAUDE.md: ${claudeMdTokens}T = ${total}T`);
  return total;
}

export class ProviderManager {
  private driver: ProviderDriver | null = null;
  private callCount = 0;
  private mcpServers?: Record<string, ExternalMCPServerConfig>; // AUDITARIA_CLAUDE_PROVIDER: MCP passthrough
  private toolRegistry?: ToolRegistry; // AUDITARIA_CLAUDE_PROVIDER: For tool bridging
  private toolExecutorServer?: ToolExecutorServer; // AUDITARIA_CLAUDE_PROVIDER: HTTP API for MCP bridge
  private bridgeScriptPath?: string; // AUDITARIA_CLAUDE_PROVIDER: Path to bundled mcp-bridge.js
  private contextModified = false; // AUDITARIA_CLAUDE_PROVIDER: Set by context_forget, triggers session reset on next call
  private appConfig?: Config; // AUDITARIA_CLAUDE_PROVIDER: For computing env context prefix
  private envContextPrefix?: string; // Cached first 30 chars of getEnvironmentContext() output
  // AUDITARIA: Callback for routing live tool output to CLI layer (browser agent steps, etc.)
  private toolOutputHandler?: (callId: string, toolName: string, output: string) => void;
  // AUDITARIA: Track toolName → callId for live output routing during MCP bridge execution
  private pendingToolCalls = new Map<string, string>();

  constructor(
    private config: ProviderConfig,
    private readonly cwd: string,
    mcpServers?: Record<string, ExternalMCPServerConfig>, // AUDITARIA_CLAUDE_PROVIDER
  ) {
    this.mcpServers = mcpServers;
    dbg('constructor', {
      type: config.type,
      model: config.model,
      cwd,
      mcpServerCount: mcpServers ? Object.keys(mcpServers).length : 0,
    });
  }

  // AUDITARIA_CLAUDE_PROVIDER: Set tool registry after async initialization
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  // AUDITARIA_CLAUDE_PROVIDER: Set app config for computing env context prefix
  setAppConfig(config: Config): void {
    this.appConfig = config;
  }

  // AUDITARIA: Register callback for live tool output (browser agent steps, etc.)
  setToolOutputHandler(handler: ((callId: string, toolName: string, output: string) => void) | undefined): void {
    this.toolOutputHandler = handler;
    this.wireToolOutputHandler();
  }

  // AUDITARIA: Wire the toolOutputHandler to the toolExecutorServer
  private wireToolOutputHandler(): void {
    if (!this.toolExecutorServer) return;
    if (!this.toolOutputHandler) {
      this.toolExecutorServer.setToolOutputHandler(undefined);
      return;
    }
    const handler = this.toolOutputHandler;
    this.toolExecutorServer.setToolOutputHandler((toolName: string, output: string) => {
      // AUDITARIA: toolExecutorServer uses original names (e.g. "browser_agent"),
      // but pendingToolCalls uses MCP-prefixed names (e.g. "mcp__auditaria-tools__browser_agent").
      // Match by checking if the key ends with __toolName.
      let callId: string | undefined;
      for (const [name, id] of this.pendingToolCalls) {
        if (name === toolName || name.endsWith('__' + toolName)) {
          callId = id;
          break;
        }
      }
      if (callId) {
        handler(callId, toolName, output);
      }
    });
  }

  isExternalProviderActive(): boolean {
    return this.config.type !== 'gemini';
  }

  // Lazily compute and cache the env context prefix from getEnvironmentContext().
  // Used to identify and skip the initial env context message in history token estimation.
  private async ensureEnvContextPrefix(): Promise<string | undefined> {
    if (this.envContextPrefix) return this.envContextPrefix;
    if (!this.appConfig) return undefined;
    try {
      const parts = await getEnvironmentContext(this.appConfig);
      const text = parts[0]?.text || '';
      this.envContextPrefix = text.substring(0, 30);
      dbg(`[ENV_PREFIX] computed: "${this.envContextPrefix}"`);
      return this.envContextPrefix;
    } catch {
      dbg('[ENV_PREFIX] failed to compute, skipping env context stripping');
      return undefined;
    }
  }

  // AUDITARIA_CLAUDE_PROVIDER: Called by context_forget when history is modified,
  // or when switching from Gemini to Claude with existing conversation history.
  // Schedules a session reset on the next sendMessage() call so Claude gets
  // a fresh session with the modified/existing conversation history.
  onHistoryModified(): void {
    this.contextModified = true;
    dbg(
      'onHistoryModified: contextModified flag set, will reset session on next call',
    );
  }

  async *handleSendMessage(
    request: PartListUnion,
    signal: AbortSignal,
    promptId: string,
    chat: GeminiChat,
    systemContext?: string,
  ): AsyncGenerator<ServerGeminiStreamEvent, Turn> {
    this.callCount++;
    const callNum = this.callCount;
    const prompt = buildExternalProviderPrompt(request);
    const sessionId = this.driver?.getSessionId?.();
    dbg(`=== CALL #${callNum} ===`, {
      hasDriver: !!this.driver,
      sessionId: sessionId || '(none)',
      promptLen: prompt.length,
      prompt: prompt.slice(0, 200),
    });

    // AUDITARIA_CLAUDE_PROVIDER: If context was modified (e.g. by context_forget),
    // or when switching from Gemini to Claude with existing conversation history,
    // inject the conversation summary as the first user message (not in system context).
    // System context (audit/memory/skills) stays separate as persistent instructions.
    let effectiveContext = systemContext;
    let effectivePrompt = prompt;
    if (this.contextModified) {
      const history = chat.getHistory();
      if (history.length > 0) {
        const envPrefix = await this.ensureEnvContextPrefix();
        const summary = buildConversationSummary(history, envPrefix);
        effectivePrompt = summary + '\n\n' + prompt;
      }
      this.driver?.resetSession?.();
      this.contextModified = false;
      dbg(
        `call #${callNum}: context modified — session reset, injecting conversation summary as user message`,
      );
    }

    let driver: ProviderDriver;
    try {
      driver = await this.getOrCreateDriver();
      dbg(
        `call #${callNum}: driver ready, sessionId=${driver.getSessionId?.() || '(none)'}`,
      );
    } catch (e) {
      dbg('driver creation FAILED', e);
      throw e;
    }

    // AUDITARIA_CLAUDE_PROVIDER: Mirror only the original prompt to GeminiChat.history
    // (not the conversation summary prefix — that's context injection, not conversation).
    chat.addHistory({ role: 'user', parts: [{ text: prompt }] });
    const modelParts: Part[] = [];
    const toolIdToName = new Map<string, string>();
    let accumulatedText = '';

    // AUDITARIA_CLAUDE_PROVIDER: Two-phase compaction tracking
    let compactionPreTokens = 0;
    let awaitingCompactionSummary = false;

    let eventCount = 0;
    try {
      for await (const event of driver.sendMessage(
        effectivePrompt,
        signal,
        effectiveContext,
      )) {
        eventCount++;
        if (signal.aborted) {
          // Flush any accumulated model parts before returning
          flushModelParts(chat, modelParts, accumulatedText);
          dbg('signal aborted, returning');
          return new Turn(chat, promptId);
        }

        // Emit tool events as native ToolCallRequest/Response so the UI
        // renders them with proper tool call display (status icons, collapsible results)
        if (event.type === ProviderEventType.ToolUse) {
          dbg(`event #${eventCount} tool_use: ${event.toolName}`);
          // AUDITARIA: Track callId for live output routing from toolExecutorServer
          this.pendingToolCalls.set(event.toolName, event.toolId);
          // Mirror: store tool name mapping and add functionCall to model buffer
          toolIdToName.set(event.toolId, event.toolName);
          if (accumulatedText) {
            modelParts.push({ text: accumulatedText });
            accumulatedText = '';
          }
          modelParts.push({
            functionCall: { name: event.toolName, args: event.input },
          });

          yield {
            type: GeminiEventType.ToolCallRequest,
            value: {
              callId: event.toolId,
              name: event.toolName,
              args: event.input,
              isClientInitiated: false,
              prompt_id: promptId,
            },
          };
          continue;
        }

        if (event.type === ProviderEventType.ToolResult) {
          dbg(`event #${eventCount} tool_result: ${event.toolId}`);
          // Mirror: flush model buffer, then add functionResponse as user Content
          flushModelParts(chat, modelParts, accumulatedText);
          accumulatedText = '';

          const toolName = toolIdToName.get(event.toolId) || 'unknown';
          chat.addHistory({
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: event.toolId,
                  name: toolName,
                  response: { output: event.output },
                },
              },
            ],
          });

          // AUDITARIA: Use stored returnDisplay from bridgeable tool execution (e.g., browser step JSON)
          // toolExecutorServer stores under original names, but toolName here is MCP-prefixed
          const originalToolName = toolName.includes('__') ? toolName.split('__').pop()! : toolName;
          const storedDisplay = this.toolExecutorServer?.consumeReturnDisplay(originalToolName);
          this.pendingToolCalls.delete(toolName);

          yield {
            type: GeminiEventType.ToolCallResponse,
            value: {
              callId: event.toolId,
              responseParts: [],
              resultDisplay: storedDisplay || event.output,
              error: event.isError ? new Error(event.output) : undefined,
              errorType: undefined,
            },
          };
          continue;
        }

        // AUDITARIA_CLAUDE_PROVIDER_START: Two-phase context compaction handling
        // Phase 1: compact_boundary detected — flush and record, wait for summary
        if (event.type === ProviderEventType.Compacted) {
          dbg(`event #${eventCount} compacted: trigger=${event.trigger}, preTokens=${event.preTokens}`);
          flushModelParts(chat, modelParts, accumulatedText);
          accumulatedText = '';
          compactionPreTokens = event.preTokens;
          awaitingCompactionSummary = true;
          continue;
        }

        // Phase 2: summary captured from post-compact user message
        if (event.type === ProviderEventType.CompactionSummary && awaitingCompactionSummary) {
          dbg(`event #${eventCount} compaction summary captured (${event.summary.length} chars)`);
          compactMirroredHistory(chat, event.summary);
          const newTokens = estimateTokenCountSync(
            chat.getHistory().flatMap(c => c.parts || [])
          );
          yield {
            type: GeminiEventType.ChatCompressed,
            value: {
              originalTokenCount: compactionPreTokens,
              newTokenCount: newTokens,
              compressionStatus: CompressionStatus.COMPRESSED,
            },
          };
          awaitingCompactionSummary = false;
          continue;
        }
        // AUDITARIA_CLAUDE_PROVIDER_END

        // Mirror: accumulate text content
        if (event.type === ProviderEventType.Content) {
          accumulatedText += event.text;
        }

        const adapted = adaptProviderEvent(event);
        if (adapted) {
          dbg(`event #${eventCount} ${adapted.type}`);
          yield adapted;
        }
      }

      // Flush any remaining model parts at end of stream
      flushModelParts(chat, modelParts, accumulatedText);

      // AUDITARIA_CLAUDE_PROVIDER: Fallback — compact_boundary received but no summary followed
      if (awaitingCompactionSummary) {
        compactMirroredHistory(chat); // No summary — uses fallback marker
        const newTokens = estimateTokenCountSync(
          chat.getHistory().flatMap(c => c.parts || [])
        );
        yield {
          type: GeminiEventType.ChatCompressed,
          value: {
            originalTokenCount: compactionPreTokens,
            newTokenCount: newTokens,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        };
        awaitingCompactionSummary = false;
      }

      // AUDITARIA_CLAUDE_PROVIDER: Estimate token count for external providers.
      // Strips the initial env context message (already injected separately to Claude).
      // When CLAUDE_INCLUDE_OVERHEAD is true, includes base overhead (system prompt + CLAUDE.md).
      const envPrefix = await this.ensureEnvContextPrefix();
      const historyParts = getHistoryPartsForEstimation(chat.getHistory(), envPrefix);
      const historyTokens = estimateTokenCountSync(historyParts);
      const contextLength = systemContext?.length || 0;
      const contextTokens = Math.ceil(contextLength / 4);
      const overhead = CLAUDE_INCLUDE_OVERHEAD ? estimateClaudeBaseOverhead(this.cwd) : 0;
      const estimated = Math.ceil((historyTokens + contextTokens + overhead) * ESTIMATION_CORRECTION_FACTOR);

      dbg(`[TOKEN_ESTIMATION] history: ${historyTokens}T, context: ${contextTokens}T, overhead: ${overhead}T`);
      dbg(`[TOKEN_ESTIMATION] × ${ESTIMATION_CORRECTION_FACTOR} = ${estimated}T (includeOverhead=${CLAUDE_INCLUDE_OVERHEAD})`);

      chat.setLastPromptTokenCount(estimated);

      dbg(
        `handleSendMessage DONE, total events: ${eventCount}, history length: ${chat.getHistory().length}, estimated tokens: ${estimated}`,
      );
    } catch (e) {
      // Flush on error too, so partial history is preserved
      flushModelParts(chat, modelParts, accumulatedText);

      // AUDITARIA_CLAUDE_PROVIDER: If the error happened mid-tool-call, the last model entry
      // may have a functionCall without a matching functionResponse. This breaks Gemini's
      // /compress (requires matched functionCall/functionResponse pairs). Add a placeholder.
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1];
      if (lastEntry?.role === 'model' && lastEntry.parts?.some(p => 'functionCall' in p && p.functionCall)) {
        const danglingCalls = lastEntry.parts.filter(p => 'functionCall' in p && p.functionCall);
        for (const part of danglingCalls) {
          const fc = (part as { functionCall: { name: string } }).functionCall;
          chat.addHistory({
            role: 'user',
            parts: [{
              functionResponse: {
                id: `error-${fc.name}`,
                name: fc.name,
                response: { output: `[Error: provider stream terminated before tool result was returned]` },
              },
            }],
          });
        }
        dbg(`added ${danglingCalls.length} placeholder functionResponse(s) for dangling tool calls`);
      }

      dbg('handleSendMessage ERROR during iteration', e);
      throw e;
    }

    return new Turn(chat, promptId);
  }

  setConfig(config: ProviderConfig): void {
    if (
      this.driver &&
      (config.type !== this.config.type || config.model !== this.config.model)
    ) {
      this.driver.dispose();
      this.driver = null;
    }
    this.config = config;
  }

  // AUDITARIA_CLAUDE_PROVIDER: Allow updating MCP servers at runtime
  setMcpServers(
    mcpServers: Record<string, ExternalMCPServerConfig> | undefined,
  ): void {
    this.mcpServers = mcpServers;
    // Force driver recreation on next call so it picks up new MCP config
    if (this.driver) {
      this.driver.dispose();
      this.driver = null;
    }
  }

  async interrupt(): Promise<void> {
    await this.driver?.interrupt();
  }

  dispose(): void {
    this.driver?.dispose();
    this.driver = null;
    // AUDITARIA_CLAUDE_PROVIDER: Stop tool executor server
    this.toolExecutorServer?.stop();
    this.toolExecutorServer = undefined;
  }

  // Expose model for token limit calculation and footer display
  // Returns prefixed model name (e.g., 'claude-code:haiku') so tokenLimit() and getDisplayString() work
  getModel(): string {
    const model = this.config.model || 'unknown';
    if (this.config.type === 'claude-cli' || this.config.type === 'claude-sdk') {
      return `claude-code:${model}`;
    }
    return model;
  }

  private async getOrCreateDriver(): Promise<ProviderDriver> {
    if (this.driver) {
      dbg('reusing existing driver');
      return this.driver;
    }

    // AUDITARIA_CLAUDE_PROVIDER: Start tool executor server for MCP bridging
    await this.ensureToolExecutorServer();

    const driverConfig = {
      model: this.config.model || 'sonnet',
      cwd: this.cwd,
      permissionMode: 'bypassPermissions',
      mcpServers: this.mcpServers, // AUDITARIA_CLAUDE_PROVIDER: MCP passthrough
      toolBridgePort: this.toolExecutorServer?.getPort() ?? undefined, // AUDITARIA_CLAUDE_PROVIDER
      toolBridgeScript: this.bridgeScriptPath, // AUDITARIA_CLAUDE_PROVIDER
    };
    dbg('creating new driver', { type: this.config.type, driverConfig });

    switch (this.config.type) {
      case 'claude-sdk': {
        const { ClaudeSDKDriver } = await import('./claude/claudeSDKDriver.js');
        this.driver = new ClaudeSDKDriver(driverConfig);
        break;
      }
      case 'claude-cli': {
        const { ClaudeCLIDriver } = await import('./claude/claudeCLIDriver.js');
        this.driver = new ClaudeCLIDriver(driverConfig);
        break;
      }
      default:
        throw new Error(`Unknown provider type: ${this.config.type}`);
    }

    return this.driver;
  }

  // AUDITARIA_CLAUDE_PROVIDER: Lazily start tool executor HTTP server for MCP bridging
  private async ensureToolExecutorServer(): Promise<void> {
    if (this.toolExecutorServer) return; // Already running
    if (!this.toolRegistry) {
      dbg('no tool registry set, skipping tool bridge');
      return;
    }

    // Resolve bridge script path relative to the running bundle
    if (!this.bridgeScriptPath) {
      try {
        const { fileURLToPath } = await import('node:url');
        const { dirname, join } = await import('node:path');
        const bundleDir = dirname(fileURLToPath(import.meta.url));
        this.bridgeScriptPath = join(bundleDir, 'mcp-bridge.js');
      } catch {
        dbg('could not resolve bridge script path');
        return;
      }
    }

    const server = new ToolExecutorServer(this.toolRegistry);
    try {
      const port = await server.start();
      this.toolExecutorServer = server;
      // AUDITARIA: Wire output handler if already registered
      this.wireToolOutputHandler();
      dbg('tool executor server started', {
        port,
        tools: server.getBridgeableTools().map((t) => t.name),
      });
    } catch (e) {
      dbg('failed to start tool executor server', e);
      // Non-fatal: Claude will just not have Auditaria's custom tools
    }
  }
}

// AUDITARIA_CLAUDE_PROVIDER: Flush accumulated model parts into GeminiChat history.
// Called when a ToolResult arrives (model parts before the result) and at end of stream.
function flushModelParts(
  chat: GeminiChat,
  modelParts: Part[],
  accumulatedText: string,
): void {
  if (accumulatedText) {
    modelParts.push({ text: accumulatedText });
  }
  if (modelParts.length > 0) {
    chat.addHistory({ role: 'model', parts: [...modelParts] });
    modelParts.length = 0; // Clear in-place
  }
}

// AUDITARIA_CLAUDE_PROVIDER: Build prompt string from PartListUnion for external providers.
// Unlike partToString(), gives honest descriptions for binary data that the provider can't see.
function buildExternalProviderPrompt(request: PartListUnion): string {
  if (!request) return '';
  if (typeof request === 'string') return request;

  const parts: PartListUnion[] = Array.isArray(request) ? request : [request];
  const segments: string[] = [];

  for (const part of parts) {
    if (!part || typeof part === 'string') {
      segments.push(part || '');
      continue;
    }
    const p = part as Part;
    if (p.text) {
      segments.push(p.text);
    } else if (p.inlineData) {
      const mime = p.inlineData.mimeType || 'unknown';
      const sizeKB = p.inlineData.data
        ? Math.round((p.inlineData.data.length * 3) / 4 / 1024)
        : 0;
      segments.push(
        `[Attached file: ${mime}, ~${sizeKB}KB — this binary content was provided inline to the host application and is not available in this conversation. ` +
          `You cannot see the literal content of this attachment. Do not pretend to know what it contains.]`,
      );
    } else if (p.fileData) {
      const uri = p.fileData.fileUri || 'unknown';
      const mime = p.fileData.mimeType || '';
      segments.push(
        `[File reference: ${uri}${mime ? ` (${mime})` : ''} — this file reference was provided to the host application and is not available in this conversation. ` +
          `You cannot see the literal content of this reference. Do not pretend to know what it contains.]`,
      );
    } else if (p.functionCall) {
      segments.push(`[Tool Call: ${p.functionCall.name}]`);
    } else if (p.functionResponse) {
      segments.push(`[Tool Response: ${p.functionResponse.name}]`);
    }
  }

  return segments.join('');
}

// AUDITARIA_CLAUDE_PROVIDER: Serialize Content[] history to a readable transcript
// for injecting into a fresh Claude session after context_forget.
// envContextPrefix: if provided, skips the initial env context message (already injected separately).
export function buildConversationSummary(history: Content[], envContextPrefix?: string): string {
  const lines: string[] = [];
  lines.push('<auditaria_conversation_history>');
  lines.push(
    'The following is the conversation history from the current session.',
  );
  lines.push(
    'Some content may have been removed by the user (marked as FORGOTTEN).',
  );
  lines.push('Continue the conversation naturally.\n');

  let skippedEnvContext = false;
  for (const content of history) {
    const role = content.role === 'user' ? 'User' : 'Assistant';
    if (!content.parts || content.parts.length === 0) continue;

    // Skip the initial environment context message — it's already injected
    // separately to external providers via buildExternalProviderContext().
    if (!skippedEnvContext && envContextPrefix && content.role === 'user') {
      const firstPart = content.parts[0];
      if (firstPart && 'text' in firstPart && typeof firstPart.text === 'string'
          && firstPart.text.startsWith(envContextPrefix)) {
        skippedEnvContext = true;
        continue;
      }
    }

    for (const part of content.parts) {
      if (!part || typeof part !== 'object') continue;

      if ('text' in part && part.text) {
        lines.push(`[${role}]: ${part.text}`);
      } else if ('functionCall' in part && part.functionCall) {
        const args = part.functionCall.args
          ? JSON.stringify(part.functionCall.args)
          : '{}';
        // Truncate large args for readability
        const truncatedArgs =
          args.length > 500 ? args.slice(0, 500) + '...' : args;
        lines.push(`[Tool Call]: ${part.functionCall.name}(${truncatedArgs})`);
      } else if ('functionResponse' in part && part.functionResponse) {
        const name = part.functionResponse.name || 'unknown';
        const output = part.functionResponse.response?.output || '';
        const outputText =
          typeof output === 'string' ? output : JSON.stringify(output);
        // Replace Gemini's generic binary placeholder with an honest description
        if (outputText.startsWith('Binary content provided')) {
          lines.push(
            `[Tool Result (${name})]: The tool returned binary content (e.g. PDF, image) that was provided inline to a previous model. You cannot see the literal content of this tool result. Do not pretend to know what it contains.`,
          );
        } else {
          // Keep full output — no truncation. Accurate context for the provider.
          // Context management (CONTENT FORGOTTEN) is preserved as-is.
          lines.push(`[Tool Result (${name})]: ${outputText}`);
        }
      }
      // Describe attachments honestly — Claude cannot see this binary data
      if ('inlineData' in part && part.inlineData) {
        const mime = part.inlineData.mimeType || 'unknown';
        const sizeKB = part.inlineData.data
          ? Math.round((part.inlineData.data.length * 3) / 4 / 1024)
          : 0;
        lines.push(
          `[${role}]: [Binary attachment: ${mime}, ~${sizeKB}KB — this was provided inline to a previous model. You cannot see the literal content of this attachment. Do not pretend to know what it contains.]`,
        );
      } else if ('fileData' in part && part.fileData) {
        const uri = part.fileData.fileUri || 'unknown';
        const mime = part.fileData.mimeType || '';
        lines.push(
          `[${role}]: [File reference: ${uri}${mime ? ` (${mime})` : ''} — this was provided to a previous model. You cannot see the literal content of this reference. Do not pretend to know what it contains.]`,
        );
      }
      // Skip thinking parts — not relevant for context
    }
  }

  lines.push('</auditaria_conversation_history>');
  return lines.join('\n');
}

// AUDITARIA_CLAUDE_PROVIDER: Convert Claude-specific tool call parts in history to text descriptions.
// Preserves inlineData, fileData, and tool calls for known Auditaria/Gemini tools.
// Only converts functionCall/functionResponse for tools NOT in knownToolNames (Claude built-ins).
export function sanitizeHistoryForProviderSwitch(
  history: Content[],
  knownToolNames?: Set<string>,
): Content[] {
  const sanitized = history
    .map((content) => {
      if (!content.parts || content.parts.length === 0) return content;

      const newParts: Part[] = [];
      for (const part of content.parts) {
        if (!part || typeof part !== 'object') continue;

        // Keep text parts as-is
        if ('text' in part && part.text) {
          newParts.push(part);
          continue;
        }

        // Keep inlineData (images, PDFs, etc.) — Gemini created them, Gemini supports them
        if ('inlineData' in part && part.inlineData) {
          newParts.push(part);
          continue;
        }

        // Keep fileData — same reason
        if ('fileData' in part && part.fileData) {
          newParts.push(part);
          continue;
        }

        // functionCall: keep if known Auditaria tool, convert if Claude built-in
        if ('functionCall' in part && part.functionCall) {
          const toolName = part.functionCall.name || '';
          if (knownToolNames?.has(toolName)) {
            newParts.push(part);
          } else {
            const args = part.functionCall.args
              ? JSON.stringify(part.functionCall.args)
              : '{}';
            const truncatedArgs =
              args.length > 300 ? args.slice(0, 300) + '...' : args;
            newParts.push({
              text: `[Tool Call: ${toolName}(${truncatedArgs})]`,
            });
          }
          continue;
        }

        // functionResponse: keep if known Auditaria tool, convert if Claude built-in
        if ('functionResponse' in part && part.functionResponse) {
          const toolName = part.functionResponse.name || 'unknown';
          if (knownToolNames?.has(toolName)) {
            newParts.push(part);
          } else {
            const output = part.functionResponse.response?.output || '';
            const outputText =
              typeof output === 'string' ? output : JSON.stringify(output);
            // Keep full output — no truncation. The history is what goes to the SDK,
            // and accurate token estimation requires the full content.
            // Context management (CONTENT FORGOTTEN) is preserved as-is.
            newParts.push({
              text: `[Tool Result (${toolName})]: ${outputText}`,
            });
          }
          continue;
        }

        // Skip thinking/thoughtSignature parts — not useful as history text
      }

      // Only return content if it has parts
      if (newParts.length === 0) return null;
      return { ...content, parts: newParts };
    })
    .filter((c): c is Content => c !== null);

  return sanitized;
}

// AUDITARIA_CLAUDE_PROVIDER_START: Trim mirrored history after external provider compaction
// Fraction of history to keep when trimming (matches Gemini's COMPRESSION_PRESERVE_THRESHOLD).
const COMPACTION_PRESERVE_FRACTION = 0.3;

export function compactMirroredHistory(chat: GeminiChat, summary?: string): void {
  const history = chat.getHistory();
  if (history.length <= 4) return; // Too small to trim

  // Compress the first 70%, keep last 30% (by character count).
  // findCompressSplitPoint handles user message boundaries so we don't split mid-tool-sequence.
  const splitPoint = findCompressSplitPoint(history, 1 - COMPACTION_PRESERVE_FRACTION);
  if (splitPoint <= 0) return; // Nothing to compress

  const historyToKeep = history.slice(splitPoint);

  // If we have Claude's compaction summary, wrap it in <state_snapshot> tags
  // to match Gemini's compression format. This enables:
  // 1. hasPreviousSnapshot detection in chatCompressionService.ts (line 323)
  // 2. Gemini's summarizer integrating this into future compressions
  // 3. High-quality context when switching providers
  const snapshotText = summary
    ? `<state_snapshot>\n${summary}\n</state_snapshot>`
    : '<context_compacted>\n'
      + 'The external provider has compacted its context window. '
      + 'Older conversation history was summarized internally by the provider. '
      + 'Only recent messages are preserved below.\n'
      + '</context_compacted>';

  const compactedHistory: Content[] = [
    {
      role: 'user',
      parts: [{ text: snapshotText }],
    },
    {
      role: 'model',
      parts: [{ text: 'Got it. Thanks for the additional context!' }],
    },
    ...historyToKeep,
  ];

  chat.setHistory(compactedHistory);
}
// AUDITARIA_CLAUDE_PROVIDER_END
