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
  // AUDITARIA_CODEX_PROVIDER: Actual per-turn context usage from session JSONL.
  // When present, providerManager uses this instead of heuristic estimation.
  // Value is last_token_usage.input_tokens + output_tokens (output becomes next turn's input).
  contextTokensUsed?: number;
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

// AUDITARIA_CODEX_PROVIDER: Supported Codex reasoning effort values for model thinking intensity.
export const CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type CodexReasoningEffort =
  (typeof CODEX_REASONING_EFFORTS)[number];

// AUDITARIA_CODEX_PROVIDER: Per-model reasoning support in Codex CLI.
// Keep this in sync with Codex model capabilities to avoid unsupported API calls.
export const CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL: Readonly<
  Partial<Record<string, readonly CodexReasoningEffort[]>>
> = {
  'gpt-5.3-codex': CODEX_REASONING_EFFORTS,
  'gpt-5.2-codex': CODEX_REASONING_EFFORTS,
  // API currently supports low/medium/high for mini (xhigh is rejected).
  'gpt-5.1-codex-mini': ['low', 'medium', 'high'] as const,
};

export function getSupportedCodexReasoningEfforts(
  model?: string,
): readonly CodexReasoningEffort[] {
  if (!model) return CODEX_REASONING_EFFORTS;
  return (
    CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL[model] ?? CODEX_REASONING_EFFORTS
  );
}

export function clampCodexReasoningEffortForModel(
  model: string | undefined,
  effort: CodexReasoningEffort,
): CodexReasoningEffort {
  const supported = getSupportedCodexReasoningEfforts(model);
  if (supported.includes(effort)) return effort;

  const requestedIndex = CODEX_REASONING_EFFORTS.indexOf(effort);
  if (requestedIndex === -1) return supported[0] ?? 'medium';

  const supportedIndices = supported
    .map((value) => CODEX_REASONING_EFFORTS.indexOf(value))
    .filter((index) => index !== -1);
  if (supportedIndices.length === 0) return 'medium';

  const minIndex = Math.min(...supportedIndices);
  const maxIndex = Math.max(...supportedIndices);
  const clampedIndex = Math.max(minIndex, Math.min(maxIndex, requestedIndex));
  const clampedEffort = CODEX_REASONING_EFFORTS[clampedIndex];

  if (supported.includes(clampedEffort)) return clampedEffort;

  // Fallback for non-contiguous support sets.
  let best = supported[0] ?? 'medium';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const candidateIndex = CODEX_REASONING_EFFORTS.indexOf(candidate);
    if (candidateIndex === -1) continue;
    const distance = Math.abs(candidateIndex - requestedIndex);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ProviderConfig {
  type: 'gemini' | 'claude-cli' | 'codex-cli' | 'copilot-cli' | 'auditaria-cli'; // AUDITARIA_CODEX_PROVIDER: added codex-cli // AUDITARIA_COPILOT_PROVIDER: added copilot-cli // AUDITARIA_AGENT_SESSION: added auditaria-cli
  model?: string;
  cwd?: string;
  options?: Record<string, unknown>;
}

// AUDITARIA_AGENT_SESSION: Canonical model ID lists for external providers (DRY source of truth).
// Used by tool schemas and UI model catalogs.
export const CLAUDE_MODEL_IDS = ['auto', 'opus', 'sonnet', 'haiku'] as const;
export type ClaudeModelId = (typeof CLAUDE_MODEL_IDS)[number];

export const CODEX_MODEL_IDS = ['auto', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.1-codex-mini'] as const;
export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

// AUDITARIA_COPILOT_PROVIDER: Fallback model IDs for Copilot provider.
// Dynamic discovery from ACP configOptions is preferred; this is the minimal fallback.
export const COPILOT_MODEL_IDS = ['auto'] as const;
export type CopilotModelId = (typeof COPILOT_MODEL_IDS)[number];

// AUDITARIA_AGENT_SESSION: Canonical model ID list for Auditaria (Gemini) sub-agents.
export const AUDITARIA_MODEL_IDS = ['auto', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'] as const;
export type AuditariaModelId = (typeof AUDITARIA_MODEL_IDS)[number];

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
