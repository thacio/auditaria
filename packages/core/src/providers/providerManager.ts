// AUDITARIA_CLAUDE_PROVIDER: Factory/orchestrator for external LLM providers

import type { PartListUnion } from '@google/genai';
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

const DEBUG = true; // TODO: remove after integration is stable
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[PROVIDER_MGR]', ...args);
}

export class ProviderManager {
  private driver: ProviderDriver | null = null;
  private callCount = 0;
  private mcpServers?: Record<string, ExternalMCPServerConfig>; // AUDITARIA_CLAUDE_PROVIDER: MCP passthrough

  constructor(
    private config: ProviderConfig,
    private readonly cwd: string,
    mcpServers?: Record<string, ExternalMCPServerConfig>, // AUDITARIA_CLAUDE_PROVIDER
  ) {
    this.mcpServers = mcpServers;
    dbg('constructor', { type: config.type, model: config.model, cwd, mcpServerCount: mcpServers ? Object.keys(mcpServers).length : 0 });
  }

  isExternalProviderActive(): boolean {
    return this.config.type !== 'gemini';
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

    let driver: ProviderDriver;
    try {
      driver = await this.getOrCreateDriver();
      dbg(`call #${callNum}: driver ready, sessionId=${driver.getSessionId?.() || '(none)'}`);
    } catch (e) {
      dbg('driver creation FAILED', e);
      throw e;
    }

    let eventCount = 0;
    try {
      for await (const event of driver.sendMessage(prompt, signal, systemContext)) {
        eventCount++;
        if (signal.aborted) {
          dbg('signal aborted, returning');
          return new Turn(chat, promptId);
        }

        // Emit tool events as native ToolCallRequest/Response so the UI
        // renders them with proper tool call display (status icons, collapsible results)
        if (event.type === ProviderEventType.ToolUse) {
          dbg(`event #${eventCount} tool_use: ${event.toolName}`);
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

        const adapted = adaptProviderEvent(event);
        if (adapted) {
          dbg(`event #${eventCount} ${adapted.type}`);
          yield adapted;
        }
      }
      dbg(`handleSendMessage DONE, total events: ${eventCount}`);
    } catch (e) {
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
  }

  private async getOrCreateDriver(): Promise<ProviderDriver> {
    if (this.driver) {
      dbg('reusing existing driver');
      return this.driver;
    }

    const driverConfig = {
      model: this.config.model || 'sonnet',
      cwd: this.cwd,
      permissionMode: 'bypassPermissions',
      mcpServers: this.mcpServers, // AUDITARIA_CLAUDE_PROVIDER: MCP passthrough
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
}
