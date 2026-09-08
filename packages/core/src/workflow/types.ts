/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Shared types for the Workflow tool (a clone of Claude
// Code's Workflow tool — see .auditaria/workflow-research/12-final-plan.md).

/** `export const meta = {...}` — the pure-literal header every script starts with. */
export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowPhaseMeta[];
}

export interface WorkflowPhaseMeta {
  title: string;
  detail?: string;
  model?: string;
}

/** Options accepted by the script-level `agent(prompt, opts)` hook. */
export interface AgentOpts {
  label?: string;
  phase?: string;
  schema?: Record<string, unknown>;
  model?: string;
  /** Auditaria extension: run this call on a different provider family. */
  provider?: WorkflowProviderFamily;
  effort?: string;
  isolation?: 'worktree' | 'remote';
  agentType?: string;
  disallowedTools?: string[];
  bashCommandClamp?: string[];
  stallMs?: number;
}

export type WorkflowProviderFamily =
  | 'gemini'
  | 'claude'
  | 'codex'
  | 'copilot'
  | 'agy';

/** One line of `journal.jsonl`. Shapes are identical to Claude Code's. */
export type JournalLine =
  | { type: 'started'; key: string; agentId: string }
  | { type: 'result'; key: string; agentId: string; result: unknown }
  | { type: 'failed'; key: string; agentId?: string };

export type WorkflowRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'killed'
  | 'paused';

export type WorkflowAgentState = 'start' | 'progress' | 'done' | 'error';

/** Progress events folded into the run record (same vocabulary as Claude Code). */
export type WorkflowProgressEvent =
  | { type: 'workflow_phase'; index: number; title: string; kind?: 'child' }
  | {
      type: 'workflow_agent';
      index: number;
      label: string;
      phaseIndex: number;
      phaseTitle: string;
      agentId?: string;
      agentType?: string;
      model?: string;
      state: WorkflowAgentState;
      startedAt?: number;
      queuedAt?: number;
      attempt?: number;
      lastToolName?: string;
      lastToolSummary?: string;
      promptPreview: string;
      lastProgressAt: number;
      tokens?: number;
      toolCalls?: number;
      durationMs?: number;
      resultPreview?: string;
      error?: string;
      cached?: boolean;
      skipped?: boolean;
      usageUnavailable?: boolean;
    }
  | { type: 'workflow_log'; message: string; at: number };

/** The persisted `state.json` (Claude Code's `wf_<runId>.json`). */
export interface WorkflowRunState {
  runId: string;
  timestamp: string;
  taskId: string;
  script?: string;
  scriptPath: string;
  args?: unknown;
  result: unknown;
  agentCount: number;
  logs: string[];
  durationMs: number;
  error?: string;
  summary: string;
  workflowName: string;
  status: WorkflowRunStatus;
  startTime: number;
  phases: WorkflowPhaseMeta[];
  defaultModel: string;
  /** Provider family + model pinned at launch (Auditaria addition). */
  providerAtLaunch?: { family: WorkflowProviderFamily; model?: string };
  workflowProgress: WorkflowProgressEvent[];
  totalTokens: number;
  totalToolCalls: number;
}

/** What `runner.run()` resolves with once the script has settled. */
export interface WorkflowRunOutcome {
  result: unknown;
  error?: string;
  status: WorkflowRunStatus;
  agentCount: number;
  logs: string[];
  failures: string[];
  durationMs: number;
}

/** Result of one sub-agent turn, as consumed by hostApi. */
export interface SubagentOutcome {
  /** Final text (no schema) or the validated structured object (schema). */
  value: unknown;
  agentId: string;
  model?: string;
  tokens: number;
  toolCalls: number;
  usageUnavailable: boolean;
  durationMs: number;
}

/** `settings.workflows` (CLI settings schema) as the core sees it. */
export interface WorkflowSettings {
  enabled?: boolean;
  sizeGuideline?: string;
  keywordTriggerEnabled?: boolean;
  ultracode?: boolean;
  skipUsageWarning?: boolean;
}
