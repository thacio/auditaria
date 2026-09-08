/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Every model-facing string of the Workflow tool in one
// place. Wording follows Claude Code's verbatim where the research recovered
// it (10-empirical-probes.md), lightly adapted elsewhere.

export const SKILL_TRAILER =
  'Load the `workflow-authoring` skill for the script reference if you have not, fix the script, and retry.';

export const DISABLED_MANAGED =
  'Dynamic workflows are disabled by managed settings.';
export const DISABLED_SESSION =
  'Dynamic workflows are not enabled for this session (the "Workflows" setting in /settings, or AUDITARIA_DISABLE_WORKFLOW).';
export const MUST_PROVIDE_SOURCE = 'Must provide script, name, or scriptPath';

export function nameOnlyRestriction(fields: string[]): string {
  return `This session restricts the Workflow tool to named workflows (AUDITARIA_WORKFLOW_NAME_ONLY is set). Not allowed here: ${fields.join(', ')}. Invoke as {name, args} only.`;
}

export function unknownNamedWorkflow(
  name: string,
  available: string[],
): string {
  return `Workflow "${name}" not found. Available: ${available.length ? available.join(', ') : '(none)'}`;
}

export function scriptPathNotAllowed(p: string): string {
  return `Network (UNC, NT-namespace, or automount) paths are not allowed for workflow scriptPath: ${p}`;
}

export function scriptPathUnreadable(p: string): string {
  return `scriptPath must be a script path this tool returned, or a file you can already read: ${p}`;
}

export function stillRunning(runId: string, taskId: string): string {
  return `Workflow ${runId} is still running (task ${taskId}). Stop it first with workflow({action: 'stop', taskId: "${taskId}"}) before resuming.`;
}

export function syntaxErrorNotLaunched(error: string): string {
  return `Workflow script has a syntax error and was not launched:\n${error}`;
}

export interface LaunchTextInput {
  taskId: string;
  summary: string;
  transcriptDir: string;
  scriptPath: string;
  runId: string;
  resumed: boolean;
}

/** The tool result of a successful launch (research 10 §2). */
export function launchText(input: LaunchTextInput): string {
  return [
    `Workflow launched in background. Task ID: ${input.taskId}`,
    `Summary: ${input.summary}`,
    `Transcript dir: ${input.transcriptDir}`,
    `Script file: ${input.scriptPath}`,
    `(Edit this file with Write/Edit and re-invoke workflow with {scriptPath: "${input.scriptPath}"} to iterate without resending the script.)`,
    `Run ID: ${input.runId}`,
    `To resume after editing the script: workflow({scriptPath: "${input.scriptPath}", resumeFromRunId: "${input.runId}"}) — completed agents return cached results (cached results may themselves be empty — inspect journal.jsonl before assuming there is something to recover).`,
    '',
    'You will be notified when it completes. Use /workflows to watch live progress.',
  ].join('\n');
}

export const REVIEW_TITLE = 'Review dynamic workflow before running';

export const WORKFLOW_ABORTED = 'Workflow aborted';
