// AUDITARIA_COPILOT_PROVIDER: ACP (Agent Client Protocol) types for GitHub Copilot CLI driver
// Based on real protocol testing against Copilot CLI 0.0.418 (Feb 2026)

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 base types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

// ---------------------------------------------------------------------------
// ACP initialize (requires protocolVersion in params)
// ---------------------------------------------------------------------------

export interface AcpInitializeParams {
  protocolVersion: number;
  clientInfo: { name: string; version: string };
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: { audio?: boolean; embeddedContext?: boolean; image?: boolean };
  sessionCapabilities?: Record<string, unknown>;
}

export interface AcpAgentInfo {
  name: string;
  version: string;
  title?: string | null;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo: AcpAgentInfo;
  agentCapabilities: AcpAgentCapabilities;
  authMethods?: unknown[];
}

// ---------------------------------------------------------------------------
// ACP session/new (requires cwd + mcpServers)
// ---------------------------------------------------------------------------

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: unknown[];
}

export interface AcpAvailableModel {
  modelId: string;
  name: string;
  description?: string | null;
  _meta?: {
    copilotUsage?: string;    // e.g., "1x", "3x", "0.33x", "0x"
    copilotEnablement?: string; // e.g., "enabled"
  };
}

export interface AcpAvailableMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
  models?: {
    availableModels: AcpAvailableModel[];
    currentModelId?: string;
  } | null;
  modes?: {
    availableModes?: AcpAvailableMode[];
    currentModeId?: string;
  } | null;
}

// ---------------------------------------------------------------------------
// ACP session/set_model
// ---------------------------------------------------------------------------

export interface AcpSetModelParams {
  sessionId: string;
  modelId: string;
}

// session/set_model returns {} on success

// ---------------------------------------------------------------------------
// ACP session/prompt
// ---------------------------------------------------------------------------

export interface AcpPromptContentText {
  type: 'text';
  text: string; // ACP uses 'text', NOT 'content'
}

export interface AcpPromptContentResourceLink {
  type: 'resource_link';
  name: string;
  uri: string;
}

export interface AcpPromptContentImage {
  type: 'image';
  data: string;
  mimeType: string;
}

export type AcpPromptContent = AcpPromptContentText | AcpPromptContentResourceLink | AcpPromptContentImage;

export interface AcpPromptParams {
  sessionId: string; // ACP uses camelCase, NOT snake_case
  prompt: AcpPromptContent[];
}

export type AcpStopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'tool_use';

export interface AcpPromptResult {
  stopReason: AcpStopReason; // camelCase
}

// ---------------------------------------------------------------------------
// ACP session/update notification
//
// Real structure:
// {
//   "method": "session/update",
//   "params": {
//     "sessionId": "...",
//     "update": {
//       "sessionUpdate": "agent_message_chunk" | "tool_call" | ...,
//       "content": { "type": "text", "text": "..." },  // for message chunks
//       "toolCallId": "...",                            // for tool_call/update
//       "title": "...",
//       "kind": "read" | "edit" | ...,
//       "status": "pending" | "completed" | "failed",
//       "rawInput": { ... },
//       "rawOutput": { "content": "...", "detailedContent": "..." },
//       "locations": [{ "path": "..." }]
//     }
//   }
// }
// ---------------------------------------------------------------------------

export type AcpUpdateKind =
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'mode_update'
  | 'available_commands_update';

export interface AcpSessionUpdateContent {
  type: 'text';
  text: string;
}

export interface AcpToolLocation {
  path: string;
}

export interface AcpSessionUpdate {
  sessionUpdate: AcpUpdateKind;
  // For agent_message_chunk / agent_thought_chunk
  content?: AcpSessionUpdateContent;
  // For tool_call / tool_call_update
  toolCallId?: string;
  title?: string;
  kind?: string; // 'read', 'edit', 'execute', 'fetch', etc.
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: Record<string, unknown>;
  rawOutput?: { content?: string; detailedContent?: string };
  locations?: AcpToolLocation[];
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

// ---------------------------------------------------------------------------
// ACP session/request_permission (agent request — we must respond)
// ---------------------------------------------------------------------------

export interface AcpPermissionRequestParams {
  sessionId: string;
  toolCallId: string;
  title: string;
  description?: string;
}

export type AcpPermissionResponse = 'allow_once' | 'reject';

// ---------------------------------------------------------------------------
// ACP session/cancel
// ---------------------------------------------------------------------------

export interface AcpCancelParams {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Client-side methods (Copilot calls these, we respond)
// ---------------------------------------------------------------------------

export interface AcpFsReadParams {
  path: string;
}

export interface AcpFsWriteParams {
  path: string;
  content: string;
}

export interface AcpFsEditParams {
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}

// ---------------------------------------------------------------------------
// Driver config
// ---------------------------------------------------------------------------

export interface CopilotDriverConfig {
  model?: string;
  cwd: string;
  toolBridgePort?: number;
  toolBridgeScript?: string;
  toolBridgeExclude?: string[];
  promptFileId?: string;
}

// ---------------------------------------------------------------------------
// Parsed model info (from session/new models.availableModels)
// ---------------------------------------------------------------------------

export interface CopilotModelInfo {
  value: string;   // The modelId to pass to session/set_model (e.g., 'claude-sonnet-4.5')
  name: string;    // Human-readable name (e.g., 'Claude Sonnet 4.5')
  description?: string | null;
  copilotUsage?: string | null; // Usage multiplier from _meta.copilotUsage (e.g., '1x', '3x', '0.33x', '0x')
}
