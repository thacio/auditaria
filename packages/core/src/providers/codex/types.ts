// AUDITARIA_CODEX_PROVIDER: Codex-specific JSONL event types (codex exec --json)

import type {
  CodexReasoningEffort,
  ExternalMCPServerConfig,
} from '../types.js';

/** Item payload types emitted by Codex CLI */

export interface CodexAgentMessageItem {
  id: string;
  type: 'agent_message';
  text: string;
}

export interface CodexReasoningItem {
  id: string;
  type: 'reasoning';
  text: string;
  summary?: string;
  content?: string;
}

export interface CodexCommandExecutionItem {
  id: string;
  type: 'command_execution';
  command: string;
  cwd?: string;
  status: string;
  aggregated_output?: string;
  exit_code?: number;
  duration_ms?: number;
}

export interface CodexFileChangeItem {
  id: string;
  type: 'file_change';
  changes: Array<{ path: string; action: string; [key: string]: unknown }>;
  status: string;
}

export interface CodexMcpToolCallItem {
  id: string;
  type: 'mcp_tool_call';
  server: string;
  tool: string;
  status: string;
  arguments: Record<string, unknown>;
  result?: string;
  error?: string;
  duration_ms?: number;
}

export interface CodexWebSearchItem {
  id: string;
  type: 'web_search';
  query: string;
}

export interface CodexTodoListItem {
  id: string;
  type: 'todo_list';
  items: Array<{ text: string; completed?: boolean; [key: string]: unknown }>;
}

export interface CodexContextCompactionItem {
  id: string;
  type: 'contextCompaction';
}

export interface CodexErrorItem {
  id: string;
  type: 'error';
  message: string;
}

export type CodexItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexContextCompactionItem
  | CodexErrorItem;

/** Item lifecycle events */
export interface CodexItemEvent {
  type: 'item.started' | 'item.updated' | 'item.completed';
  item: CodexItem;
}

/** Turn lifecycle events */
export interface CodexTurnEvent {
  type: 'turn.started' | 'turn.completed' | 'turn.failed';
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  error?: string;
}

/** Thread lifecycle events */
export interface CodexThreadEvent {
  type: 'thread.started';
  thread_id: string;
}

/** Union of all Codex JSONL event types */
export type CodexStreamMessage =
  | CodexItemEvent
  | CodexTurnEvent
  | CodexThreadEvent
  | { type: string; [key: string]: unknown };

/** Driver configuration for Codex providers */
export interface CodexDriverConfig {
  model?: string;
  cwd: string;
  mcpServers?: Record<string, ExternalMCPServerConfig>;
  toolBridgePort?: number;
  toolBridgeScript?: string;
  toolBridgeExclude?: string[]; // AUDITARIA_AGENT_SESSION: Tools to exclude from MCP bridge
  reasoningEffort?: CodexReasoningEffort;
  codexConfigHome?: string; // AUDITARIA_AGENT_SESSION: Custom config directory (isolates concurrent instances)
  sandboxMode?: string; // AUDITARIA_AGENT_SESSION: 'danger-full-access' (default) | 'workspace-read-only' (consult)
}
