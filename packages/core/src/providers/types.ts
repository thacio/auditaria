// AUDITARIA_CLAUDE_PROVIDER: Provider abstraction for alternative LLM backends (Claude, future Codex)

export enum ProviderEventType {
  Content = 'content',
  Thinking = 'thinking',
  ToolUse = 'tool_use',
  ToolResult = 'tool_result',
  ModelInfo = 'model_info',
  Finished = 'finished',
  Error = 'error',
}

export interface ProviderContentEvent {
  type: ProviderEventType.Content;
  text: string;
}

export interface ProviderThinkingEvent {
  type: ProviderEventType.Thinking;
  text: string;
}

export interface ProviderToolUseEvent {
  type: ProviderEventType.ToolUse;
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
}

export interface ProviderToolResultEvent {
  type: ProviderEventType.ToolResult;
  toolId: string;
  output: string;
  isError?: boolean;
}

export interface ProviderModelInfoEvent {
  type: ProviderEventType.ModelInfo;
  model: string;
}

export interface ProviderFinishedEvent {
  type: ProviderEventType.Finished;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}

export interface ProviderErrorEvent {
  type: ProviderEventType.Error;
  message: string;
  status?: number;
}

export type ProviderEvent =
  | ProviderContentEvent
  | ProviderThinkingEvent
  | ProviderToolUseEvent
  | ProviderToolResultEvent
  | ProviderModelInfoEvent
  | ProviderFinishedEvent
  | ProviderErrorEvent;

export interface ProviderDriver {
  sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
  ): AsyncGenerator<ProviderEvent>;
  interrupt(): Promise<void>;
  getSessionId(): string | undefined;
  resetSession?(): void; // AUDITARIA_CLAUDE_PROVIDER: Clear session so next call is "first call" (used by context_forget)
  dispose(): void;
}

export interface ProviderConfig {
  type: 'gemini' | 'claude-sdk' | 'claude-cli';
  model?: string;
  cwd?: string;
  options?: Record<string, unknown>;
}

// AUDITARIA_CLAUDE_PROVIDER: Minimal MCP server shape for external providers.
// Avoids importing MCPServerConfig from config.ts (circular dependency).
export interface ExternalMCPServerConfig {
  // stdio transport
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http/sse transport
  url?: string;
  httpUrl?: string;
  headers?: Record<string, string>;
  type?: string;
}
