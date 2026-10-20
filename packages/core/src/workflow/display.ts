/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The tool's `returnDisplay` card sentinel. Only strings
// survive the MCP bridge to external orchestrators, so the tool returns a
// JSON string shaped `{"workflow":{...}}` and the CLI / web renderers parse it
// back with this helper (same pattern as the artifact tool).

import { isRecord, stringField } from './guards.js';
import type { WorkflowProgressEvent } from './types.js';

export type WorkflowAgentRow = Extract<
  WorkflowProgressEvent,
  { type: 'workflow_agent' }
>;

/** Never render a provider's missing usage as a measured zero. */
export function workflowUsageLabel(
  tokens?: number,
  unavailable = false,
): string {
  if (unavailable)
    return tokens
      ? `${tokens.toLocaleString()} tokens (partial)`
      : 'Usage unavailable';
  return tokens === undefined
    ? 'Usage pending'
    : `${tokens.toLocaleString()} tokens`;
}

/** Include agents without phase() calls and phases that have not started yet. */
export function workflowPhaseGroups(progress: WorkflowProgressEvent[]): Array<{
  index: number;
  title: string;
  agents: WorkflowAgentRow[];
}> {
  const groups = new Map<
    number,
    { index: number; title: string; agents: WorkflowAgentRow[] }
  >();
  for (const event of progress) {
    if (event.type === 'workflow_phase') {
      groups.set(event.index, {
        index: event.index,
        title: event.title,
        agents: [],
      });
    }
  }
  for (const event of progress) {
    if (event.type !== 'workflow_agent') continue;
    let group = groups.get(event.phaseIndex);
    if (!group) {
      group = {
        index: event.phaseIndex,
        title: event.phaseTitle || 'Agents',
        agents: [],
      };
      groups.set(event.phaseIndex, group);
    }
    group.agents.push(event);
  }
  return [...groups.values()].sort((a, b) => a.index - b.index);
}

export interface WorkflowDisplayData {
  workflow: {
    taskId: string;
    runId: string;
    name: string;
    description: string;
    scriptPath: string;
    resumed: boolean;
  };
}

export function tryParseWorkflowDisplay(
  content: unknown,
): WorkflowDisplayData | undefined {
  if (typeof content !== 'string' || !content.startsWith('{"workflow":')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed)) return undefined;
    const workflow = parsed['workflow'];
    if (!isRecord(workflow)) return undefined;
    const taskId = stringField(workflow, 'taskId');
    const runId = stringField(workflow, 'runId');
    const name = stringField(workflow, 'name');
    if (!taskId || !runId || !name) return undefined;
    return {
      workflow: {
        taskId,
        runId,
        name,
        description: stringField(workflow, 'description') ?? '',
        scriptPath: stringField(workflow, 'scriptPath') ?? '',
        resumed: workflow['resumed'] === true,
      },
    };
  } catch {
    return undefined;
  }
}
