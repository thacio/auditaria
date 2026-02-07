// AUDITARIA_CLAUDE_PROVIDER: Factory/orchestrator for external LLM providers

import type { Content, Part, PartListUnion } from '@google/genai';
import {
  GeminiEventType,
  type ServerGeminiStreamEvent,
  Turn,
} from '../core/turn.js';
import type { GeminiChat } from '../core/geminiChat.js';
import { partToString } from '../utils/partUtils.js';
import type { ProviderConfig, ProviderDriver, ExternalMCPServerConfig } from './types.js';
import { ProviderEventType } from './types.js';
import { adaptProviderEvent } from './eventAdapter.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { ToolExecutorServer } from './mcp-bridge/toolExecutorServer.js';

const DEBUG = true; // TODO: remove after integration is stable
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[PROVIDER_MGR]', ...args);
}

export class ProviderManager {
  private driver: ProviderDriver | null = null;
  private callCount = 0;
  private mcpServers?: Record<string, ExternalMCPServerConfig>; // AUDITARIA_CLAUDE_PROVIDER: MCP passthrough
  private toolRegistry?: ToolRegistry; // AUDITARIA_CLAUDE_PROVIDER: For tool bridging
  private toolExecutorServer?: ToolExecutorServer; // AUDITARIA_CLAUDE_PROVIDER: HTTP API for MCP bridge
  private bridgeScriptPath?: string; // AUDITARIA_CLAUDE_PROVIDER: Path to bundled mcp-bridge.js
  private contextModified = false; // AUDITARIA_CLAUDE_PROVIDER: Set by context_forget, triggers session reset on next call

  constructor(
    private config: ProviderConfig,
    private readonly cwd: string,
    mcpServers?: Record<string, ExternalMCPServerConfig>, // AUDITARIA_CLAUDE_PROVIDER
  ) {
    this.mcpServers = mcpServers;
    dbg('constructor', { type: config.type, model: config.model, cwd, mcpServerCount: mcpServers ? Object.keys(mcpServers).length : 0 });
  }

  // AUDITARIA_CLAUDE_PROVIDER: Set tool registry after async initialization
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  isExternalProviderActive(): boolean {
    return this.config.type !== 'gemini';
  }

  // AUDITARIA_CLAUDE_PROVIDER: Called by context_forget when history is modified,
  // or when switching from Gemini to Claude with existing conversation history.
  // Schedules a session reset on the next sendMessage() call so Claude gets
  // a fresh session with the modified/existing conversation history.
  onHistoryModified(): void {
    this.contextModified = true;
    dbg('onHistoryModified: contextModified flag set, will reset session on next call');
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
    const prompt = partToString(request, { verbose: true });
    const sessionId = this.driver?.getSessionId?.();
    dbg(`=== CALL #${callNum} ===`, {
      hasDriver: !!this.driver,
      sessionId: sessionId || '(none)',
      promptLen: prompt.length,
      prompt: prompt.slice(0, 200),
    });

    // AUDITARIA_CLAUDE_PROVIDER: If context was modified (e.g. by context_forget),
    // or when switching from Gemini to Claude with existing conversation history,
    // inject the conversation history as context. Reset session if driver exists.
    let effectiveContext = systemContext;
    if (this.contextModified) {
      const history = chat.getHistory();
      if (history.length > 0) {
        const summary = buildConversationSummary(history);
        effectiveContext = (systemContext || '') + '\n\n' + summary;
      }
      this.driver?.resetSession?.();
      this.contextModified = false;
      dbg(`call #${callNum}: context modified — session reset, injecting conversation summary`);
    }

    let driver: ProviderDriver;
    try {
      driver = await this.getOrCreateDriver();
      dbg(`call #${callNum}: driver ready, sessionId=${driver.getSessionId?.() || '(none)'}`);
    } catch (e) {
      dbg('driver creation FAILED', e);
      throw e;
    }

    // AUDITARIA_CLAUDE_PROVIDER: Mirror events to GeminiChat.history
    // so context management tools can inspect/forget/restore content.
    chat.addHistory({ role: 'user', parts: [{ text: prompt }] });
    const modelParts: Part[] = [];
    const toolIdToName = new Map<string, string>();
    let accumulatedText = '';

    let eventCount = 0;
    try {
      for await (const event of driver.sendMessage(prompt, signal, effectiveContext)) {
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
          // Mirror: store tool name mapping and add functionCall to model buffer
          toolIdToName.set(event.toolId, event.toolName);
          if (accumulatedText) {
            modelParts.push({ text: accumulatedText });
            accumulatedText = '';
          }
          modelParts.push({ functionCall: { name: event.toolName, args: event.input } });

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
            parts: [{
              functionResponse: {
                id: event.toolId,
                name: toolName,
                response: { output: event.output },
              },
            }],
          });

          yield {
            type: GeminiEventType.ToolCallResponse,
            value: {
              callId: event.toolId,
              responseParts: [],
              resultDisplay: event.output,
              error: event.isError ? new Error(event.output) : undefined,
              errorType: undefined,
            },
          };
          continue;
        }

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
      dbg(`handleSendMessage DONE, total events: ${eventCount}, history length: ${chat.getHistory().length}`);
    } catch (e) {
      // Flush on error too, so partial history is preserved
      flushModelParts(chat, modelParts, accumulatedText);
      dbg('handleSendMessage ERROR during iteration', e);
      throw e;
    }

    return new Turn(chat, promptId);
  }

  setConfig(config: ProviderConfig): void {
    if (this.driver && (config.type !== this.config.type || config.model !== this.config.model)) {
      this.driver.dispose();
      this.driver = null;
    }
    this.config = config;
  }

  // AUDITARIA_CLAUDE_PROVIDER: Allow updating MCP servers at runtime
  setMcpServers(mcpServers: Record<string, ExternalMCPServerConfig> | undefined): void {
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
        const { ClaudeSDKDriver } = await import(
          './claude/claudeSDKDriver.js'
        );
        this.driver = new ClaudeSDKDriver(driverConfig);
        break;
      }
      case 'claude-cli': {
        const { ClaudeCLIDriver } = await import(
          './claude/claudeCLIDriver.js'
        );
        this.driver = new ClaudeCLIDriver(driverConfig);
        break;
      }
      default:
        throw new Error(
          `Unknown provider type: ${this.config.type}`,
        );
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
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
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
      dbg('tool executor server started', { port, tools: server.getBridgeableTools().map(t => t.name) });
    } catch (e) {
      dbg('failed to start tool executor server', e);
      // Non-fatal: Claude will just not have Auditaria's custom tools
    }
  }
}

// AUDITARIA_CLAUDE_PROVIDER: Flush accumulated model parts into GeminiChat history.
// Called when a ToolResult arrives (model parts before the result) and at end of stream.
function flushModelParts(chat: GeminiChat, modelParts: Part[], accumulatedText: string): void {
  if (accumulatedText) {
    modelParts.push({ text: accumulatedText });
  }
  if (modelParts.length > 0) {
    chat.addHistory({ role: 'model', parts: [...modelParts] });
    modelParts.length = 0; // Clear in-place
  }
}

// AUDITARIA_CLAUDE_PROVIDER: Serialize Content[] history to a readable transcript
// for injecting into a fresh Claude session after context_forget.
export function buildConversationSummary(history: Content[]): string {
  const lines: string[] = [];
  lines.push('<auditaria_conversation_history>');
  lines.push('The following is the conversation history from the current session.');
  lines.push('Some content may have been removed by the user (marked as FORGOTTEN).');
  lines.push('Continue the conversation naturally.\n');

  for (const content of history) {
    const role = content.role === 'user' ? 'User' : 'Assistant';
    if (!content.parts || content.parts.length === 0) continue;

    for (const part of content.parts) {
      if (!part || typeof part !== 'object') continue;

      if ('text' in part && part.text) {
        lines.push(`[${role}]: ${part.text}`);
      } else if ('functionCall' in part && part.functionCall) {
        const args = part.functionCall.args
          ? JSON.stringify(part.functionCall.args)
          : '{}';
        // Truncate large args for readability
        const truncatedArgs = args.length > 500 ? args.slice(0, 500) + '...' : args;
        lines.push(`[Tool Call]: ${part.functionCall.name}(${truncatedArgs})`);
      } else if ('functionResponse' in part && part.functionResponse) {
        const name = part.functionResponse.name || 'unknown';
        const output = part.functionResponse.response?.output || '';
        const outputText = typeof output === 'string' ? output : JSON.stringify(output);
        // Keep forgotten placeholders in full, truncate large outputs
        const isForgotten = outputText.includes('[CONTENT FORGOTTEN');
        const truncatedOutput = isForgotten
          ? outputText
          : (outputText.length > 2000 ? outputText.slice(0, 2000) + '\n... (truncated)' : outputText);
        lines.push(`[Tool Result (${name})]: ${truncatedOutput}`);
      }
      // Describe attachments as text (Claude can't see binary data)
      if ('inlineData' in part && part.inlineData) {
        const mime = part.inlineData.mimeType || 'unknown';
        const sizeKB = part.inlineData.data
          ? Math.round((part.inlineData.data.length * 3) / 4 / 1024)
          : 0;
        lines.push(`[${role}]: [Attachment: ${mime}, ~${sizeKB}KB]`);
      } else if ('fileData' in part && part.fileData) {
        const uri = part.fileData.fileUri || 'unknown';
        const mime = part.fileData.mimeType || '';
        lines.push(`[${role}]: [File: ${uri}${mime ? ` (${mime})` : ''}]`);
      }
      // Skip thinking parts — not relevant for context
    }
  }

  lines.push('</auditaria_conversation_history>');
  return lines.join('\n');
}

// AUDITARIA_CLAUDE_PROVIDER: Convert all non-text parts in history to text descriptions.
// Used when switching providers to avoid incompatible functionCall/functionResponse/attachment
// parts that the new provider wouldn't understand.
export function sanitizeHistoryForProviderSwitch(history: Content[]): Content[] {
  return history.map(content => {
    if (!content.parts || content.parts.length === 0) return content;

    const newParts: Part[] = [];
    for (const part of content.parts) {
      if (!part || typeof part !== 'object') continue;

      // Keep text parts as-is
      if ('text' in part && part.text) {
        newParts.push(part);
        continue;
      }

      // Convert functionCall to text description
      if ('functionCall' in part && part.functionCall) {
        const args = part.functionCall.args
          ? JSON.stringify(part.functionCall.args)
          : '{}';
        const truncatedArgs = args.length > 300 ? args.slice(0, 300) + '...' : args;
        newParts.push({ text: `[Tool Call: ${part.functionCall.name}(${truncatedArgs})]` });
        continue;
      }

      // Convert functionResponse to text description
      if ('functionResponse' in part && part.functionResponse) {
        const name = part.functionResponse.name || 'unknown';
        const output = part.functionResponse.response?.output || '';
        const outputText = typeof output === 'string' ? output : JSON.stringify(output);
        // Keep forgotten placeholders in full, truncate large outputs
        const isForgotten = outputText.includes('[CONTENT FORGOTTEN');
        const truncatedOutput = isForgotten
          ? outputText
          : (outputText.length > 2000 ? outputText.slice(0, 2000) + '\n... (truncated)' : outputText);
        newParts.push({ text: `[Tool Result (${name})]: ${truncatedOutput}` });
        continue;
      }

      // Convert inlineData (base64 attachments) to text description
      if ('inlineData' in part && part.inlineData) {
        const mime = part.inlineData.mimeType || 'unknown';
        const sizeKB = part.inlineData.data
          ? Math.round((part.inlineData.data.length * 3) / 4 / 1024)
          : 0;
        newParts.push({ text: `[Attachment: ${mime}, ~${sizeKB}KB]` });
        continue;
      }

      // Convert fileData to text description
      if ('fileData' in part && part.fileData) {
        const uri = part.fileData.fileUri || 'unknown';
        const mime = part.fileData.mimeType || '';
        newParts.push({ text: `[File: ${uri}${mime ? ` (${mime})` : ''}]` });
        continue;
      }

      // Skip thinking/thoughtSignature parts — not useful as history text
    }

    // Only return content if it has parts
    if (newParts.length === 0) return null;
    return { ...content, parts: newParts };
  }).filter((c): c is Content => c !== null);
}
