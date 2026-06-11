/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

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
  // AUDITARIA_CLAUDE_PROVIDER: Phase-1 interactive-prompt surfacing.
  // Fired when the active provider needs a user decision mid-turn that the
  // driver cannot resolve on its own (AskUserQuestion, tool permission,
  // trust dialog, OAuth re-auth, etc). The turn is paused until the UI
  // calls providerManager.respondToPrompt(promptId, response).
  InteractivePromptStart = 'interactive_prompt_start',
  InteractivePromptResolved = 'interactive_prompt_resolved',
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

// AUDITARIA_CLAUDE_PROVIDER_START: Phase-1 interactive-prompt surfacing
//
// Distinguishes what kind of interactive moment we're surfacing so the UI
// can render the right affordances (number list for ask-user, accept/deny
// for permissions, trust toggle for folders, abort-only for auth).
export type InteractivePromptKind =
  | 'ask-user' // Claude's AskUserQuestion tool
  | 'permission' // PreToolUse permission gate
  | 'trust' // Workspace trust dialog (--require-trust-confirmation only)
  | 'auth' // OAuth re-auth needed mid-session
  | 'plan-approval' // Plan-mode banner detected via PTY scrape
  | 'slash-blocked'; // Bare interactive slash command — informational reject

export interface InteractivePromptOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  isDestructive?: boolean;
}

// A single question. AskUserQuestion can have an array of these in one tool
// call; permission/trust/auth/plan-approval prompts always carry exactly
// one question (still wrapped in the array for uniformity).
export interface InteractivePromptQuestion {
  id: string; // stable identifier (uses Claude's question header or a generated UUID)
  question: string;
  header?: string;
  options: InteractivePromptOption[];
  multiSelect?: boolean;
}

export interface InteractivePromptStartEvent {
  type: ProviderEventType.InteractivePromptStart;
  promptId: string; // correlation key — usually Claude's tool_use_id
  kind: InteractivePromptKind;
  title: string; // short headline for the UI
  detail?: string; // optional longer body (e.g. tool input preview, cwd)
  questions: InteractivePromptQuestion[];
  cwd?: string; // for 'trust'
  toolName?: string; // for 'permission'
  timeoutMs?: number; // server-enforced; default 60_000
}

export interface InteractivePromptAnswer {
  questionId: string; // matches InteractivePromptQuestion.id
  optionIds: string[]; // one element for single-select; >=1 for multiSelect
  customText?: string; // when the user picked "Other" / free-form
}

export type InteractivePromptResponse =
  | {
      kind: 'answered';
      answers: InteractivePromptAnswer[];
      rememberForSession?: boolean; // permission: "approve for this session"
    }
  | { kind: 'cancelled'; reason: 'timeout' | 'disconnect' | 'user-cancel' };

export interface InteractivePromptResolvedEvent {
  type: ProviderEventType.InteractivePromptResolved;
  promptId: string;
  response: InteractivePromptResponse;
}
// AUDITARIA_CLAUDE_PROVIDER_END

export type ProviderEvent =
  | ProviderContentEvent
  | ProviderThinkingEvent
  | ProviderToolUseEvent
  | ProviderToolResultEvent
  | ProviderModelInfoEvent
  | ProviderFinishedEvent
  | ProviderErrorEvent
  | ProviderCompactedEvent
  | ProviderCompactionSummaryEvent
  // AUDITARIA_CLAUDE_PROVIDER
  | InteractivePromptStartEvent
  | InteractivePromptResolvedEvent;

// AUDITARIA_ATTACHMENTS: Image attachment for providers that support images.
// Codex uses filePath (temp file + -i flag), Copilot uses data (inline base64 via ACP).
export interface AttachmentFile {
  filePath: string;
  mimeType: string;
  data?: string; // Base64-encoded image data (avoids re-reading temp files)
}

export interface ProviderDriver {
  sendMessage(
    prompt: string,
    signal: AbortSignal,
    systemContext?: string,
    attachmentFiles?: AttachmentFile[], // AUDITARIA_ATTACHMENTS: Temp file paths for image attachments
  ): AsyncGenerator<ProviderEvent>;
  interrupt(): Promise<void>;
  getSessionId(): string | undefined;
  resetSession?(): void; // AUDITARIA_CLAUDE_PROVIDER: Clear session so next call is "first call" (used by context_forget)
  dispose(): void;

  // AUDITARIA_SESSION_MANAGEMENT_START: Session resume support for multi-context providers
  /** Set native session ID so next sendMessage resumes that session */
  setSessionId?(nativeSessionId: string): void;
  /** Whether this driver supports cross-restart resume */
  readonly canResume: boolean;
  // AUDITARIA_SESSION_MANAGEMENT_END

  // AUDITARIA_CLAUDE_PROVIDER_START: Phase-1 interactive-prompt response
  /**
   * Called by providerManager.respondToPrompt() when the UI collected the
   * user's answer to an InteractivePromptStart. Drivers without
   * interactive-prompt support can omit this. The driver is responsible
   * for unblocking whatever in-flight machinery was awaiting the answer
   * (HTTP hook response, PTY keystroke, etc) and emitting the
   * corresponding InteractivePromptResolved event.
   */
  respondToPrompt?(
    promptId: string,
    response: InteractivePromptResponse,
  ): Promise<void>;
  // AUDITARIA_CLAUDE_PROVIDER_END
}

// AUDITARIA_CODEX_PROVIDER: Supported Codex reasoning effort values for model thinking intensity.
export const CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

// AUDITARIA_CODEX_PROVIDER: Per-model reasoning support in Codex CLI.
// Keep this in sync with Codex model capabilities to avoid unsupported API calls.
export const CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL: Readonly<
  Partial<Record<string, readonly CodexReasoningEffort[]>>
> = {
  'gpt-5.5': CODEX_REASONING_EFFORTS,
  'gpt-5.4': CODEX_REASONING_EFFORTS,
  // API currently supports low/medium/high for mini (xhigh is rejected).
  'gpt-5.4-mini': ['low', 'medium', 'high'] as const,
  'gpt-5.3-codex': CODEX_REASONING_EFFORTS,
  'gpt-5.2': CODEX_REASONING_EFFORTS,
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
  type:
    | 'gemini'
    | 'claude-cli'
    | 'codex-cli'
    | 'copilot-cli'
    | 'auditaria-cli'
    | `openai-compat:${string}`; // AUDITARIA_CODEX_PROVIDER: added codex-cli // AUDITARIA_COPILOT_PROVIDER: added copilot-cli // AUDITARIA_AGENT_SESSION: added auditaria-cli // AUDITARIA_OPENAI_COMPAT: template literal for custom providers
  model?: string;
  cwd?: string;
  options?: Record<string, unknown>;
}

// AUDITARIA_AGENT_SESSION: Canonical model ID lists for external providers (DRY source of truth).
// Used by tool schemas and UI model catalogs.
// AUDITARIA_AGENT_SESSION: Includes 1M-context variants (opus[1m], sonnet[1m]).
// 'auto' means "do not pass --model" — Claude resolves its own default
// (typically the 1M-context Opus when the user has access).
export const CLAUDE_MODEL_IDS = [
  'auto',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'opus[1m]',
  'sonnet[1m]',
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODEL_IDS)[number];

export const CODEX_MODEL_IDS = [
  'auto',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
] as const;
export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

// AUDITARIA_COPILOT_PROVIDER: Fallback model IDs for Copilot provider.
// Dynamic discovery from ACP configOptions is preferred; this is the minimal fallback.
export const COPILOT_MODEL_IDS = ['auto'] as const;
export type CopilotModelId = (typeof COPILOT_MODEL_IDS)[number];

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
