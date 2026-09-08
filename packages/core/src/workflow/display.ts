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
