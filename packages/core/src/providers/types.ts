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

// AUDITARIA_CODEX_PROVIDER: Supported Codex reasoning effort values for model
// thinking intensity, ordered lowest → highest (the clamping logic below relies
// on that order). `max` and `ultra` arrived with the GPT-5.6 family; `ultra` is
// "maximum reasoning with automatic task delegation".
export const CODEX_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

// AUDITARIA_CODEX_PROVIDER: Per-model reasoning support in Codex CLI.
// Mirrors `supported_reasoning_levels` in the CLI's own `~/.codex/models_cache.json`.
const CODEX_EFFORTS_THROUGH_XHIGH = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const satisfies readonly CodexReasoningEffort[];

export const CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL: Readonly<
  Partial<Record<string, readonly CodexReasoningEffort[]>>
> = {
  'gpt-5.6-sol': CODEX_REASONING_EFFORTS,
  'gpt-5.6-terra': CODEX_REASONING_EFFORTS,
  // Luna tops out at `max` (no `ultra` delegation tier).
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'] as const,
  'gpt-5.5': CODEX_EFFORTS_THROUGH_XHIGH,
  'gpt-5.4': CODEX_EFFORTS_THROUGH_XHIGH,
  'gpt-5.4-mini': CODEX_EFFORTS_THROUGH_XHIGH,
};

export function getSupportedCodexReasoningEfforts(
  model?: string,
): readonly CodexReasoningEffort[] {
  if (!model) return CODEX_REASONING_EFFORTS;
  return (
    CODEX_SUPPORTED_REASONING_EFFORTS_BY_MODEL[model] ?? CODEX_REASONING_EFFORTS
  );
}

// AUDITARIA_PROVIDER_EFFORT_START: provider-agnostic reasoning effort.
// Codex was the first provider we exposed a thinking-intensity control for,
// but Claude Code (`--effort`) and Copilot (`--effort/--reasoning-effort`)
// accept one too. `agy` does NOT: it rejects `--effort` for every model in its
// catalog because the tier is baked into the model name ("Gemini 3.7 Flash
// (High)"), so it is deliberately absent from the table below.
//
// One ordered scale spans every provider (lowest → highest); each provider
// exposes the contiguous slice its CLI accepts. The `ultra` slot is the
// "top level plus orchestration" tier both frontier CLIs converged on:
// Codex's `ultra` ("maximum reasoning with automatic task delegation") and
// Claude Code's `ultracode` ("xhigh + dynamic workflow orchestration").
export const PROVIDER_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;
export type ProviderReasoningEffort =
  (typeof PROVIDER_REASONING_EFFORTS)[number];

/**
 * Claude Code levels: `claude --effort <low|medium|high|xhigh|max>` (verified
 * against 2.1.231 — anything else warns and falls back to the default).
 * `ultra` maps to Claude's session-scoped `ultracode` mode, which the flag
 * does NOT accept: the driver translates it to `--effort xhigh` plus
 * `"ultracode": true` in the `--settings` JSON (the delivery path Claude
 * Code's own settings schema documents for it).
 */
export const CLAUDE_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly ProviderReasoningEffort[];

/**
 * Copilot levels (CLI 1.0.79). `--help` also advertises a `minimal` choice,
 * but it appears nowhere in the app bundle — no level list, label, or
 * description includes it — so we mirror the TUI's canonical set.
 */
export const COPILOT_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ProviderReasoningEffort[];

/** Provider types that accept a reasoning-effort setting. */
export type ReasoningEffortProviderType =
  | 'claude-cli'
  | 'codex-cli'
  | 'copilot-cli';

export function providerSupportsReasoningEffort(
  type: string | undefined,
): type is ReasoningEffortProviderType {
  return (
    type === 'claude-cli' || type === 'codex-cli' || type === 'copilot-cli'
  );
}

/** Sensible starting point per provider (each CLI's own default is opaque). */
export const DEFAULT_REASONING_EFFORT_BY_PROVIDER: Readonly<
  Record<ReasoningEffortProviderType, ProviderReasoningEffort>
> = {
  'claude-cli': 'high',
  'codex-cli': 'xhigh',
  'copilot-cli': 'medium',
};

// AUDITARIA_PROVIDER_EFFORT: per-provider display vocabulary. `label` is the
// exact word the provider's own CLI shows for the level, so users can
// correlate what they pick here with what they see in that CLI;
// `description` is the provider's own explanation where it publishes one.
// Sources (all extracted from the installed CLIs, not invented):
// - Claude Code 2.1.231: bare tokens (`/effort low|medium|high|xhigh|max`);
//   `ultracode` wording from its /effort help and settings schema.
// - Codex CLI 0.146.0: tokens + per-level descriptions from the CLI's own
//   `~/.codex/models_cache.json` `supported_reasoning_levels`.
// - Copilot CLI 1.0.79: label map {none:"None"…xhigh:"Extra High",max:"Max"}
//   and the "Select Effort Level" descriptions, both from its app bundle.
export interface ReasoningEffortDisplay {
  label: string;
  description?: string;
}

const CLAUDE_EFFORT_DISPLAY: Partial<
  Record<ProviderReasoningEffort, ReasoningEffortDisplay>
> = {
  low: { label: 'low' },
  medium: { label: 'medium' },
  high: { label: 'high' },
  xhigh: { label: 'xhigh' },
  max: { label: 'max' },
  ultra: {
    label: 'ultracode',
    description:
      'xhigh + dynamic workflow orchestration (needs workflows enabled and an xhigh-capable model)',
  },
};

const CODEX_EFFORT_DISPLAY: Partial<
  Record<ProviderReasoningEffort, ReasoningEffortDisplay>
> = {
  low: { label: 'low', description: 'Fast responses with lighter reasoning' },
  medium: {
    label: 'medium',
    description: 'Balances speed and reasoning depth for everyday tasks',
  },
  high: {
    label: 'high',
    description: 'Greater reasoning depth for complex problems',
  },
  xhigh: {
    label: 'xhigh',
    description: 'Extra high reasoning depth for complex problems',
  },
  max: {
    label: 'max',
    description: 'Maximum reasoning depth for the hardest problems',
  },
  ultra: {
    label: 'ultra',
    description: 'Maximum reasoning with automatic task delegation',
  },
};

const COPILOT_EFFORT_DISPLAY: Partial<
  Record<ProviderReasoningEffort, ReasoningEffortDisplay>
> = {
  none: { label: 'None', description: 'No model thinking' },
  low: { label: 'Low', description: 'Minimal thinking, prioritizes speed' },
  medium: {
    label: 'Medium',
    description: 'Balanced, thinks on harder problems',
  },
  high: {
    label: 'High',
    description: 'Optimal performance, thorough thinking',
  },
  xhigh: {
    label: 'Extra High',
    description: 'Extra performance, extended thinking',
  },
  max: { label: 'Max', description: 'Maximum performance, deepest thinking' },
};

const EFFORT_DISPLAY_BY_PROVIDER: Readonly<
  Record<
    ReasoningEffortProviderType,
    Partial<Record<ProviderReasoningEffort, ReasoningEffortDisplay>>
  >
> = {
  'claude-cli': CLAUDE_EFFORT_DISPLAY,
  'codex-cli': CODEX_EFFORT_DISPLAY,
  'copilot-cli': COPILOT_EFFORT_DISPLAY,
};

/**
 * The provider CLI's own label (and, where it has one, its own explanation)
 * for an effort level. Falls back to the bare token for unknown combinations.
 */
export function getReasoningEffortDisplay(
  providerType: string | undefined,
  effort: ProviderReasoningEffort,
): ReasoningEffortDisplay {
  if (providerSupportsReasoningEffort(providerType)) {
    const display = EFFORT_DISPLAY_BY_PROVIDER[providerType][effort];
    if (display) return display;
  }
  return { label: effort };
}

export function isProviderReasoningEffort(
  value: unknown,
): value is ProviderReasoningEffort {
  return (
    typeof value === 'string' &&
    (PROVIDER_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/**
 * Effort levels the given provider (and, for Codex, the given model) accepts.
 * Returns [] for providers without an effort control.
 */
export function getSupportedReasoningEfforts(
  providerType: string | undefined,
  model?: string,
): readonly ProviderReasoningEffort[] {
  switch (providerType) {
    case 'claude-cli':
      return CLAUDE_REASONING_EFFORTS;
    case 'copilot-cli':
      return COPILOT_REASONING_EFFORTS;
    case 'codex-cli':
      return getSupportedCodexReasoningEfforts(model);
    default:
      return [];
  }
}

/** Clamp an effort into the range the provider/model actually accepts. */
export function clampReasoningEffortForProvider(
  providerType: string | undefined,
  model: string | undefined,
  effort: ProviderReasoningEffort,
): ProviderReasoningEffort {
  const supported = getSupportedReasoningEfforts(providerType, model);
  if (supported.length === 0) return effort;
  if (supported.includes(effort)) return effort;

  const requested = PROVIDER_REASONING_EFFORTS.indexOf(effort);
  const indices = supported.map((value) =>
    PROVIDER_REASONING_EFFORTS.indexOf(value),
  );
  const clamped = Math.max(
    Math.min(...indices),
    Math.min(Math.max(...indices), requested),
  );
  return PROVIDER_REASONING_EFFORTS[clamped];
}
// AUDITARIA_PROVIDER_EFFORT_END

// AUDITARIA_PROVIDER_EFFORT: accepts any level on the shared scale (Copilot's
// `none`/`minimal` have no Codex equivalent and clamp to the lowest supported)
// and always returns one Codex accepts.
export function clampCodexReasoningEffortForModel(
  model: string | undefined,
  effort: ProviderReasoningEffort,
): CodexReasoningEffort {
  const clamped = clampReasoningEffortForProvider('codex-cli', model, effort);
  // Re-find in the Codex list so the return type narrows without an assertion.
  return (
    getSupportedCodexReasoningEfforts(model).find(
      (candidate) => candidate === clamped,
    ) ?? 'medium'
  );
}

export interface ProviderConfig {
  type:
    | 'gemini'
    | 'claude-cli'
    | 'codex-cli'
    | 'copilot-cli'
    | 'agy-cli'
    | 'auditaria-cli'
    | `openai-compat:${string}`; // AUDITARIA_CODEX_PROVIDER: added codex-cli // AUDITARIA_COPILOT_PROVIDER: added copilot-cli // AUDITARIA_AGY_PROVIDER: added agy-cli // AUDITARIA_AGENT_SESSION: added auditaria-cli // AUDITARIA_OPENAI_COMPAT: template literal for custom providers
  model?: string;
  cwd?: string;
  options?: Record<string, unknown>;
}

// AUDITARIA_AGENT_SESSION: Canonical model ID lists for external providers (DRY source of truth).
// Used by tool schemas and UI model catalogs.
// AUDITARIA_AGENT_SESSION: 1M context is Claude Code's DEFAULT for opus /
// sonnet / fable since 2.1.x (only haiku stays 200K), so the old `[1m]`
// variants are gone from the catalog — the suffix is a no-op for current
// models and Claude still accepts/strips it in previously-persisted
// selections. `opusplan` = Opus while planning, Sonnet while executing.
// 'auto' means "do not pass --model" — Claude resolves its own default
// (respecting the user's last TUI selection).
export const CLAUDE_MODEL_IDS = [
  'auto',
  'opus',
  'opusplan',
  'sonnet',
  'haiku',
  'fable',
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODEL_IDS)[number];

// AUDITARIA_CODEX_PROVIDER: Mirrors the user-selectable (`visibility: "list"`)
// models in the Codex CLI's own `~/.codex/models_cache.json`.
export const CODEX_MODEL_IDS = [
  'auto',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
] as const;
export type CodexModelId = (typeof CODEX_MODEL_IDS)[number];

// AUDITARIA_COPILOT_PROVIDER: Fallback model IDs for Copilot provider.
// Dynamic discovery from ACP configOptions is preferred; this is the minimal fallback.
export const COPILOT_MODEL_IDS = ['auto'] as const;
export type CopilotModelId = (typeof COPILOT_MODEL_IDS)[number];

// AUDITARIA_AGY_PROVIDER: Model IDs for the Google Antigravity (`agy`) provider.
// Each maps to an agy `--model` display name (see AGY_MODEL_DISPLAY in
// agy/agyCLIDriver.ts). Gemini / Claude / GPT-OSS families bill against
// SEPARATE Antigravity quota pools, so each variant is independently selectable.
export const AGY_MODEL_IDS = [
  'auto',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-high',
  'gemini-3.6-flash-low',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-high',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-high',
  'gemini-3.1-pro-low',
  'gemini-3.1-pro-high',
  'claude-sonnet-4.6',
  'claude-opus-4.6',
  'gpt-oss-120b',
] as const;
export type AgyModelId = (typeof AGY_MODEL_IDS)[number];

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
