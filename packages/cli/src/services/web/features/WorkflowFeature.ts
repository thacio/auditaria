/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_WORKFLOW: mirrors background workflow runs to the web client
// (live progress for the tool card, notices, stop/skip/retry controls).

import type { WebSocket } from 'ws';
import type {
  WorkflowNotice,
  WorkflowProgressEvent,
  WorkflowRunRecord,
  WorkflowService,
} from '@google/gemini-cli-core';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import { readNumber, readString, type ClientMessage } from '../protocol.js';

/** One run as the web client sees it. */
export interface WorkflowListRow {
  runId: string;
  taskId: string;
  name: string;
  description: string;
  status: string;
  startTime: number;
  endTime?: number;
  provider: string;
  scriptPath: string;
  agentCount: number;
  agentsDone: number;
  totalTokens: number;
  totalToolCalls: number;
  progress: WorkflowProgressEvent[];
  logs: string[];
  failures: string[];
  error?: string;
  result?: unknown;
}

const BROADCAST_THROTTLE_MS = 150;
const MAX_LOG_ROWS = 20;

export class WorkflowFeature extends WebFeature {
  readonly name = 'workflows';
  private unsubscribe: Array<() => void> = [];
  private throttle: NodeJS.Timeout | null = null;

  constructor(private readonly service: WorkflowService) {
    super();
  }

  protected onAttach(ctx: WebFeatureContext): void {
    const onChange = () => this.scheduleBroadcast();
    const onNotice = (notice: WorkflowNotice) => {
      this.broadcast('workflow_event', { event: 'notice', ...notice });
      this.scheduleBroadcast();
    };
    this.service.on('change', onChange);
    this.service.on('notice', onNotice);
    this.unsubscribe.push(
      () => this.service.off('change', onChange),
      () => this.service.off('notice', onNotice),
    );

    ctx.inbound.on('workflow_list_request', (_message, ws) => {
      this.send(ws, 'workflow_list', { runs: this.rows() });
    });
    ctx.inbound.on('workflow_update_request', (message) => {
      this.handleUpdate(message);
    });
  }

  protected onDetach(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.throttle) {
      clearTimeout(this.throttle);
      this.throttle = null;
    }
  }

  override sendInitialState(ws: WebSocket): void {
    this.send(ws, 'workflow_list', { runs: this.rows() });
  }

  private scheduleBroadcast(): void {
    if (this.throttle) return;
    this.throttle = setTimeout(() => {
      this.throttle = null;
      this.broadcast('workflow_list', { runs: this.rows() });
    }, BROADCAST_THROTTLE_MS);
  }

  private rows(): WorkflowListRow[] {
    return this.service.registry.list().map((run) => this.rowOf(run));
  }

  private rowOf(run: WorkflowRunRecord): WorkflowListRow {
    const summary = this.service.registry.summaryOf(run);
    const family = run.providerAtLaunch.family;
    const provider = run.providerAtLaunch.model
      ? `${family}:${run.providerAtLaunch.model}`
      : family;
    return {
      runId: run.runId,
      taskId: run.taskId,
      name: summary.name,
      description: summary.description,
      status: summary.status,
      startTime: summary.startTime,
      endTime: summary.endTime,
      provider,
      scriptPath: run.scriptPath,
      agentCount: summary.agentCount,
      agentsDone: summary.agentsDone,
      totalTokens: summary.totalTokens,
      totalToolCalls: summary.totalToolCalls,
      progress: run.workflowProgress.filter((e) => e.type !== 'workflow_log'),
      logs: run.logs.slice(-MAX_LOG_ROWS),
      failures: run.failures,
      ...(run.error ? { error: run.error } : {}),
      ...(run.status !== 'running' && run.result !== undefined
        ? { result: run.result }
        : {}),
    };
  }

  private handleUpdate(message: ClientMessage): void {
    const op = readString(message, 'op');
    const id = readString(message, 'id');
    if (!op || !id) return;
    switch (op) {
      case 'stop':
        this.service.stop(id);
        break;
      case 'skip_agent': {
        const index = readNumber(message, 'index');
        if (index !== undefined) this.service.skipAgent(id, index);
        break;
      }
      case 'retry_agent': {
        const index = readNumber(message, 'index');
        if (index !== undefined) this.service.retryAgent(id, index);
        break;
      }
      default:
        break;
    }
    this.scheduleBroadcast();
  }
}
