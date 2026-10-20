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
  WorkflowAgentDetail,
} from '@google/gemini-cli-core';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext } from '../core/types.js';
import { readNumber, readString, type ClientMessage } from '../protocol.js';

/** One run as the web client sees it. */
export interface WorkflowListRow {
  runId: string;
  taskId: string;
  name: string;
  title?: string;
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
    ctx.inbound.on('workflow_update_request', (message, ws) =>
      this.handleUpdate(message, ws),
    );
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
      ...(run.meta.title ? { title: run.meta.title } : {}),
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

  private async handleUpdate(
    message: ClientMessage,
    ws: WebSocket,
  ): Promise<void> {
    const op = readString(message, 'op');
    const id = readString(message, 'id');
    const requestId = readString(message, 'requestId');
    let text = '';
    let ok = true;
    let detail: WorkflowAgentDetail | undefined;
    try {
      if (!op || !id) throw new Error('Choose a workflow and an action.');
      switch (op) {
        case 'agent_detail': {
          const index = readNumber(message, 'index');
          if (index === undefined || !Number.isInteger(index))
            throw new Error('Choose an agent.');
          detail = await this.service.agentDetail(id, index);
          if (!detail)
            throw new Error('The agent transcript is not available yet.');
          break;
        }
        case 'stop': {
          const result = this.service.stop(id);
          if (!result.ok) throw new Error(result.message);
          text = 'Stopping workflow…';
          break;
        }
        case 'pause':
          if (!this.service.pause(id))
            throw new Error('This workflow is no longer running.');
          text = 'Pausing workflow…';
          break;
        case 'resume':
          await this.service.resume(id);
          text = 'Workflow resumed.';
          break;
        case 'save':
          text = `Saved to ${this.service.save(id, readString(message, 'scope') === 'user' ? 'user' : 'project')}`;
          break;
        case 'skip_agent': {
          const index = readNumber(message, 'index');
          if (
            index === undefined ||
            !Number.isInteger(index) ||
            !this.service.skipAgent(id, index)
          )
            throw new Error('This agent is no longer running.');
          text = 'Stopping agent…';
          break;
        }
        case 'retry_agent': {
          const index = readNumber(message, 'index');
          if (
            index === undefined ||
            !Number.isInteger(index) ||
            !this.service.retryAgent(id, index)
          )
            throw new Error('Only an active agent can restart.');
          text = 'Restarting agent…';
          break;
        }
        default:
          throw new Error('Unknown workflow action.');
      }
    } catch (error) {
      ok = false;
      text = error instanceof Error ? error.message : String(error);
    }
    this.send(ws, 'workflow_event', {
      event: 'action_result',
      requestId,
      id,
      op,
      ok,
      message: text,
      ...(detail ? { detail } : {}),
    });
    if (op !== 'agent_detail') this.scheduleBroadcast();
  }
}
