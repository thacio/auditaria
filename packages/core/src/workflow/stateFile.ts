/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: `state.json` (Claude Code's `wf_<runId>.json`) plus the
// progress-folding rules the live task record uses (research 02 §8.4).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { WorkflowProgressEvent, WorkflowRunState } from './types.js';
import { isRecord, stringField } from './guards.js';

function isRunState(value: unknown): value is WorkflowRunState {
  return isRecord(value) && stringField(value, 'runId') !== undefined;
}

/** Retained progress rows; oldest `workflow_log` rows are evicted first past this. */
export const PROGRESS_CAP = 1000;

/**
 * Fold one event into the progress list: phase/agent rows are keyed by
 * `${type}:${index}` and replaced in place; logs append (capped).
 */
export function foldProgress(
  list: WorkflowProgressEvent[],
  event: WorkflowProgressEvent,
): WorkflowProgressEvent[] {
  if (event.type === 'workflow_log') {
    const next = [...list, event];
    if (next.length > PROGRESS_CAP) {
      const firstLog = next.findIndex((e) => e.type === 'workflow_log');
      if (firstLog >= 0) next.splice(firstLog, 1);
      else next.shift();
    }
    return next;
  }
  const id = `${event.type}:${event.index}`;
  const at = list.findIndex(
    (e) => e.type !== 'workflow_log' && `${e.type}:${e.index}` === id,
  );
  if (at >= 0) {
    const next = [...list];
    next[at] = event;
    return next;
  }
  return [...list, event];
}

/** Sum of per-agent tokens / tool calls across the folded rows. */
export function totalsOf(list: WorkflowProgressEvent[]): {
  totalTokens: number;
  totalToolCalls: number;
  agentCount: number;
} {
  let totalTokens = 0;
  let totalToolCalls = 0;
  let agentCount = 0;
  for (const e of list) {
    if (e.type !== 'workflow_agent') continue;
    agentCount = Math.max(agentCount, e.index);
    totalTokens += e.tokens ?? 0;
    totalToolCalls += e.toolCalls ?? 0;
  }
  return { totalTokens, totalToolCalls, agentCount };
}

export async function writeRunState(
  statePath: string,
  state: WorkflowRunState,
): Promise<void> {
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 1), 'utf8');
  try {
    await fsp.rename(tmp, statePath);
  } catch {
    // Windows can refuse to replace a file another reader holds open; fall
    // back to an in-place write rather than losing the state.
    await fsp.writeFile(statePath, JSON.stringify(state, null, 1), 'utf8');
    await fsp.rm(tmp, { force: true });
  }
}

export function readRunState(statePath: string): WorkflowRunState | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (isRunState(parsed)) return parsed;
  } catch {
    /* missing or torn */
  }
  return undefined;
}
