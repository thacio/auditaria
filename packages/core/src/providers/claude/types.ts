// AUDITARIA_CLAUDE_PROVIDER: Claude-specific message types (SDK/CLI JSON format)

/** Content block types emitted by Claude SDK/CLI */
export interface ClaudeTextBlock {
  type: 'text';
  text: string;
}

export interface ClaudeThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ClaudeToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeThinkingBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock;

/** SDK message types (from async generator) */
export interface ClaudeSystemMessage {
  type: 'system';
  session_id: string;
  [key: string]: unknown;
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  message: {
    type: 'message';
    content: ClaudeContentBlock[];
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    [key: string]: unknown;
  };
  session_id?: string;
}

export interface ClaudeUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: ClaudeContentBlock[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ClaudeResultMessage {
  type: 'result';
  subtype?: string;
  session_id?: string;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      cumulativeInputTokens?: number;
      cumulativeOutputTokens?: number;
      cumulativeCacheReadInputTokens?: number;
      cumulativeCacheCreationInputTokens?: number;
    }
  >;
  [key: string]: unknown;
}

export type ClaudeStreamMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeResultMessage
  | { type: string; [key: string]: unknown };

/** Driver configuration for Claude providers */
export interface ClaudeDriverConfig {
  model: string;
  cwd: string;
  permissionMode?: string;
  allowedTools?: string[];
  resumeSessionId?: string;
}
