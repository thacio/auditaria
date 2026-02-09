// AUDITARIA_CLAUDE_PROVIDER: Provider abstraction for alternative LLM backends (Claude, future Codex)

export enum ProviderEventType {
  Content = 'content',
  Thinking = 'thinking',
  ToolUse = 'tool_use',
  ToolResult = 'tool_result',
  ModelInfo = 'model_info',
  Finished = 'finished',
  Error = 'error',
  Compacted = 'compacted', // AUDITARIA_CLAUDE_PROVIDER: Claude context compaction boundary
  CompactionSummary = 'compaction_summary', // AUDITARIA_CLAUDE_PROVIDER: Summary captured after compaction
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

// AUDITARIA_CLAUDE_PROVIDER: Emitted when Claude auto-compacts its context window
export interface ProviderCompactedEvent {
  type: ProviderEventType.Compacted;
  preTokens: number;
  trigger: 'manual' | 'auto';
}

// AUDITARIA_CLAUDE_PROVIDER: Emitted with Claude's compaction summary text (post-compact user message)
export interface ProviderCompactionSummaryEvent {
  type: ProviderEventType.CompactionSummary;
  summary: string;
}

export type ProviderEvent =
  | ProviderContentEvent
  | ProviderThinkingEvent
  | ProviderToolUseEvent
  | ProviderToolResultEvent
  | ProviderModelInfoEvent
  | ProviderFinishedEvent
  | ProviderErrorEvent
  | ProviderCompactedEvent
  | ProviderCompactionSummaryEvent;

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
  type: 'gemini' | 'claude-cli';
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
