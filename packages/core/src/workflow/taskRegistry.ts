/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: In-memory registry of the runs this process knows —
// the live record every UI reads (progress rows, status, totals) and the
// control surface for stop / skip / retry.

import { EventEmitter } from 'node:events';
import type {
  WorkflowMeta,
  WorkflowProgressEvent,
  WorkflowProviderFamily,
  WorkflowRunStatus,
} from './types.js';
import { foldProgress, totalsOf } from './stateFile.js';

export interface WorkflowRunRecord {
  runId: string;
  taskId: string;
  toolUseId?: string;
  meta: WorkflowMeta;
  scriptPath: string;
  args?: unknown;
  status: WorkflowRunStatus;
  startTime: number;
  endTime?: number;
  providerAtLaunch: { family: WorkflowProviderFamily; model?: string };
  defaultModel: string;
  workflowProgress: WorkflowProgressEvent[];
  logs: string[];
  failures: string[];
  result?: unknown;
  error?: string;
  /** Session ids of the sub-agents this run created (never cross-killed). */
  leafSessionIds: Set<string>;
  abortController: AbortController;
  /** Per-agent controllers so one agent can be skipped/retried without stopping the run. */
  agentControllers: Map<
    number,
    { controller: AbortController; reason?: 'user-skip' | 'user-retry' }
  >;
  notified: boolean;
}

export interface WorkflowRunSummary {
  runId: string;
  taskId: string;
  name: string;
  description: string;
  status: WorkflowRunStatus;
  startTime: number;
  endTime?: number;
  agentCount: number;
  agentsDone: number;
  totalTokens: number;
  totalToolCalls: number;
  scriptPath: string;
  lastLog?: string;
}

export interface WorkflowRegistryEvents {
  change: [runId: string];
}

export class WorkflowTaskRegistry extends EventEmitter<WorkflowRegistryEvents> {
  private readonly runs = new Map<string, WorkflowRunRecord>();
  private readonly taskToRun = new Map<string, string>();

  register(record: WorkflowRunRecord): void {
    this.runs.set(record.runId, record);
    this.taskToRun.set(record.taskId, record.runId);
    this.emit('change', record.runId);
  }

  /** Accepts either a run id (`wf_…`) or a task id (`w…`). */
  get(id: string): WorkflowRunRecord | undefined {
    return this.runs.get(id) ?? this.runs.get(this.taskToRun.get(id) ?? '');
  }

  list(): WorkflowRunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startTime - a.startTime);
  }

  running(): WorkflowRunRecord[] {
    return this.list().filter((r) => r.status === 'running');
  }

  applyProgress(runId: string, event: WorkflowProgressEvent): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.workflowProgress = foldProgress(run.workflowProgress, event);
    this.emit('change', runId);
  }

  addLog(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.logs.push(message);
    this.emit('change', runId);
  }

  addFailure(runId: string, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.failures.push(message);
    this.emit('change', runId);
  }

  settle(
    runId: string,
    outcome: { status: WorkflowRunStatus; result?: unknown; error?: string },
  ): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = outcome.status;
    run.result = outcome.result;
    run.error = outcome.error;
    run.endTime = Date.now();
    this.emit('change', runId);
  }

  /** Stop the whole run (TaskStop equivalent). Returns false when it is not running. */
  stop(id: string, reason = 'user-stop'): WorkflowRunRecord | undefined {
    const run = this.get(id);
    if (!run || run.status !== 'running') return undefined;
    run.status = reason === 'pause' ? 'paused' : 'killed';
    run.abortController.abort(new Error(reason));
    this.emit('change', run.runId);
    return run;
  }

  /** Abort one in-flight agent; the run continues (agent() resolves null). */
  skipAgent(id: string, agentIndex: number): boolean {
    return this.abortAgent(id, agentIndex, 'user-skip');
  }

  /** Abort one in-flight agent so its retry ladder starts a fresh attempt. */
  retryAgent(id: string, agentIndex: number): boolean {
    return this.abortAgent(id, agentIndex, 'user-retry');
  }

  private abortAgent(
    id: string,
    agentIndex: number,
    reason: 'user-skip' | 'user-retry',
  ): boolean {
    const run = this.get(id);
    const entry = run?.agentControllers.get(agentIndex);
    if (!run || !entry || entry.controller.signal.aborted) return false;
    entry.reason = reason;
    entry.controller.abort(new Error(reason));
    this.emit('change', run.runId);
    return true;
  }

  summaryOf(run: WorkflowRunRecord): WorkflowRunSummary {
    const totals = totalsOf(run.workflowProgress);
    const agentsDone = run.workflowProgress.filter(
      (e) => e.type === 'workflow_agent' && e.state === 'done',
    ).length;
    const lastLog = [...run.workflowProgress]
      .reverse()
      .find((e) => e.type === 'workflow_log');
    return {
      runId: run.runId,
      taskId: run.taskId,
      name: run.meta.name,
      description: run.meta.description,
      status: run.status,
      startTime: run.startTime,
      endTime: run.endTime,
      agentCount: totals.agentCount,
      agentsDone,
      totalTokens: totals.totalTokens,
      totalToolCalls: totals.totalToolCalls,
      scriptPath: run.scriptPath,
      lastLog:
        lastLog && lastLog.type === 'workflow_log'
          ? lastLog.message
          : undefined,
    };
  }
}
