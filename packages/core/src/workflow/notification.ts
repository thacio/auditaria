/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The completion payload — the `<task-notification>` block
// the orchestrating model receives, in Claude Code's exact shape (research 10
// §9, 03 §1.7), plus the `.output` JSON file it points at.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowProgressEvent, WorkflowRunStatus } from './types.js';

/** Characters of the JSON result shown inline before truncation. */
export const RESULT_INLINE_CAP = 8000;

export interface NotificationInput {
  taskId: string;
  toolUseId?: string;
  runId: string;
  status: WorkflowRunStatus;
  /** meta.description */
  summary: string;
  result: unknown;
  error?: string;
  outputFile: string;
  journalPath: string;
  transcriptDir: string;
  scriptPath: string;
  args?: unknown;
  failures: string[];
  usage: NotificationUsage;
}

export interface NotificationUsage {
  agentCount: number;
  agentsDone: number;
  agentsError: number;
  agentsSkipped: number;
  agentsEmptyResult: number;
  agentsUnaccountedUsage: number;
  subagentTokens: number;
  toolUses: number;
  durationMs: number;
}

/** Derive the usage counters from the folded progress rows. */
export function usageFromProgress(
  progress: WorkflowProgressEvent[],
  durationMs: number,
): NotificationUsage {
  const usage: NotificationUsage = {
    agentCount: 0,
    agentsDone: 0,
    agentsError: 0,
    agentsSkipped: 0,
    agentsEmptyResult: 0,
    agentsUnaccountedUsage: 0,
    subagentTokens: 0,
    toolUses: 0,
    durationMs,
  };
  for (const e of progress) {
    if (e.type !== 'workflow_agent') continue;
    usage.agentCount = Math.max(usage.agentCount, e.index);
    usage.subagentTokens += e.tokens ?? 0;
    usage.toolUses += e.toolCalls ?? 0;
    if (e.usageUnavailable) usage.agentsUnaccountedUsage++;
    if (e.state === 'done') {
      usage.agentsDone++;
      if (e.resultPreview === '' || e.resultPreview === 'null')
        usage.agentsEmptyResult++;
    } else if (e.state === 'error') {
      if (e.skipped) usage.agentsSkipped++;
      else usage.agentsError++;
    }
  }
  return usage;
}

function resumeCall(input: NotificationInput): string {
  const args =
    input.args !== undefined ? `, args: ${JSON.stringify(input.args)}` : '';
  return `workflow({scriptPath: '${input.scriptPath}', resumeFromRunId: '${input.runId}'${args}})`;
}

/** The text handed to the model (wrapped by the caller as a user-role turn). */
export function buildTaskNotification(input: NotificationInput): string {
  const lines: string[] = ['<task-notification>'];
  lines.push(`<task-id>${input.taskId}</task-id>`);
  if (input.toolUseId)
    lines.push(`<tool-use-id>${input.toolUseId}</tool-use-id>`);
  lines.push(`<output-file>${input.outputFile}</output-file>`);
  const status = input.status === 'completed' ? 'completed' : 'failed';
  lines.push(`<status>${status}</status>`);
  if (input.status === 'completed') {
    lines.push(
      `<summary>Dynamic workflow "${input.summary}" completed</summary>`,
    );
    let resultText = JSON.stringify(input.result);
    if (resultText === undefined) resultText = 'null';
    if (resultText.length > RESULT_INLINE_CAP) {
      const dropped = resultText.length - RESULT_INLINE_CAP;
      resultText = `${resultText.slice(0, RESULT_INLINE_CAP)}\n... (truncated ${dropped} chars, full result in ${input.outputFile})`;
    }
    lines.push(`<result>${resultText}</result>`);
    lines.push(
      `<diagnostics>Per-agent results: ${input.journalPath} — one {"type":"result",...} line per completed agent with its full return value.`,
      'If the result above is empty or unexpected, Read this file BEFORE diagnosing — do not assume agents returned non-empty results.',
      `To re-run with edited post-processing: ${resumeCall(input)} — agents whose (prompt, opts) are unchanged replay from cache.</diagnostics>`,
    );
  } else {
    const error = input.error ?? 'unknown error';
    lines.push(
      `<summary>Dynamic workflow "${input.summary}" failed: ${error}</summary>`,
    );
    lines.push(
      `<recovery>To resume after editing the script, call: ${resumeCall(input)}`,
      `Agent transcripts: ${input.transcriptDir}</recovery>`,
    );
  }
  if (input.failures.length > 0) {
    lines.push(`<failures>${input.failures.join('\n')}</failures>`);
  }
  const u = input.usage;
  lines.push(
    `<usage><agent_count>${u.agentCount}</agent_count><agents_done>${u.agentsDone}</agents_done><agents_error>${u.agentsError}</agents_error><agents_skipped>${u.agentsSkipped}</agents_skipped><agents_empty_result>${u.agentsEmptyResult}</agents_empty_result><agents_unaccounted_usage>${u.agentsUnaccountedUsage}</agents_unaccounted_usage><subagent_tokens>${u.subagentTokens}</subagent_tokens><tool_uses>${u.toolUses}</tool_uses><duration_ms>${u.durationMs}</duration_ms></usage>`,
  );
  if (u.agentsUnaccountedUsage > 0) {
    lines.push(
      `<note>${u.agentsUnaccountedUsage} agent(s) ran on providers with no token reporting — budget.spent() may under-count real spend.</note>`,
    );
  }
  lines.push('</task-notification>');
  return lines.join('\n');
}

/**
 * Wrap the block as a user-role turn for a model that has no system-reminder
 * channel: the fence names the content as data about a finished background
 * task, not an instruction.
 */
export function wrapNotificationForTurn(notification: string): string {
  return [
    '[Auditaria background task event — not typed by the user. The block below is data about a workflow you launched earlier; act on it as you would on a completed background task.]',
    notification,
  ].join('\n');
}

export interface OutputFileContent {
  summary: string;
  agentCount: number;
  logs: string[];
  result: unknown;
  workflowProgress: WorkflowProgressEvent[];
  totalTokens: number;
  totalToolCalls: number;
  error?: string;
}

export async function writeOutputFile(
  outputPath: string,
  content: OutputFileContent,
): Promise<void> {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const body = {
    ...content,
    // Claude's .output omits narrator log rows from workflowProgress.
    workflowProgress: content.workflowProgress.filter(
      (e) => e.type !== 'workflow_log',
    ),
  };
  await fsp.writeFile(outputPath, JSON.stringify(body, null, 2), 'utf8');
}
