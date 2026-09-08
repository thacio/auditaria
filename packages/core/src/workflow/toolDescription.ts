/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The model-facing description of the `workflow` tool —
// Claude Code's structure and rules, rephrased (research 03 §4.1), with the
// live "workflow size guideline" sentence appended (research 03 §3.4).

import type { Config } from '../config/config.js';

export type WorkflowSizeGuideline =
  | 'unrestricted'
  | 'small'
  | 'medium'
  | 'large';

export const SIZE_CAPS: Record<
  Exclude<WorkflowSizeGuideline, 'unrestricted'>,
  number
> = {
  small: 5,
  medium: 15,
  large: 50,
};

export const DEFAULT_SIZE_GUIDELINE: WorkflowSizeGuideline = 'medium';

export function isSizeGuideline(
  value: unknown,
): value is WorkflowSizeGuideline {
  return (
    value === 'unrestricted' ||
    value === 'small' ||
    value === 'medium' ||
    value === 'large'
  );
}

/** "medium — keep workflows under 15 agents" */
export function sizePhrase(size: WorkflowSizeGuideline): string {
  if (size === 'unrestricted') return 'unrestricted';
  return `${size} — keep workflows under ${SIZE_CAPS[size]} agents`;
}

export function sizeGuidelineSentence(
  size: WorkflowSizeGuideline,
  isDefault: boolean,
): string {
  if (size === 'unrestricted') {
    return 'Workflow size is unrestricted for this session — no size guideline applies.';
  }
  const lead = isDefault
    ? 'This session has the default workflow size guideline:'
    : 'A workflow size guideline is configured for this session:';
  const tail = isDefault
    ? ' The user can raise or remove it with the "Workflow size guideline" setting in /settings.'
    : '';
  return `${lead} ${sizePhrase(size)}. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.${tail}`;
}

/** The reminder shown when the guideline changes mid-session. */
export function sizeGuidelineChanged(size: WorkflowSizeGuideline): string {
  if (size === 'unrestricted')
    return 'Workflow size is now unrestricted — no size guideline applies.';
  return `The workflow size guideline for this session changed: ${sizePhrase(size)}. This is a guideline, not a hard limit — follow it unless the user's prompt calls for a different scale.`;
}

export function resolveSizeGuideline(config: Config): {
  size: WorkflowSizeGuideline;
  isDefault: boolean;
} {
  const configured = config.getWorkflowSizeGuideline?.();
  if (isSizeGuideline(configured))
    return { size: configured, isDefault: false };
  return { size: DEFAULT_SIZE_GUIDELINE, isDefault: true };
}

const DESCRIPTION_BODY = `Execute a workflow script that orchestrates multiple sub-agents deterministically. Workflows run in the background — this tool returns immediately with a task ID, and a <task-notification> arrives when the workflow completes. Use /workflows to watch live progress.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. Workflows can spawn dozens of agents and consume a large amount of tokens; the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** in the workflow authoring reference.
- The user directly asked you to run a workflow or use multi-agent orchestration in their own words ("use a workflow", "run a workflow", "fan out agents", "orchestrate this with subagents"). The ask must be in the user's words — a task that would merely benefit from a workflow does not count.
- The user invoked a skill or slash command whose instructions tell you to call this tool.
- The user asked you to run a specific named or saved workflow.

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool. Use your sub-agent tool for individual delegations, or briefly describe what a multi-agent workflow could do and how much it would roughly cost, and ask the user whether to run it. Mention they can ask for one with "use a workflow" in a future message to skip the ask.

Every script must begin with \`export const meta = {...}\`: a PURE LITERAL (no variables, calls or interpolation) giving the workflow's \`name\`, a one-line \`description\` (shown in the review dialog) and optionally \`phases\` — one \`{ title, detail? }\` per phase() call, titles matched exactly. Pass the script inline via \`script\` — do not write it to a file first, and do not also set \`name\` (that selects a saved workflow); it is plain JavaScript, not TypeScript.

The canonical multi-stage pattern — pipeline by default, each dimension verifies as soon as its review completes:
  export const meta = {
    name: 'review-changes',
    description: 'Review changed files across dimensions, verify each finding',
    phases: [{ title: 'Review' }, { title: 'Verify' }],
  }
  const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS_SCHEMA}),
    review => parallel(review.findings.map(f => () =>
      agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.file}\`, phase: 'Verify', schema: VERDICT_SCHEMA})
        .then(v => ({...f, verdict: v}))
    ))
  )
  const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
  return { confirmed }
  // Dimension 'bugs' findings verify while dimension 'perf' is still reviewing. No wasted wall-clock.

Before writing a script, load the \`workflow-authoring\` skill — the workflow authoring reference: script API and gotchas, resume, the **Ultracode** section, quality patterns, worked examples.`;

export function buildWorkflowToolDescription(config: Config): string {
  const { size, isDefault } = resolveSizeGuideline(config);
  return `${DESCRIPTION_BODY}\n\n${sizeGuidelineSentence(size, isDefault)}`;
}
