/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowsManager } from './WorkflowsManager.js';
import { workflowGroups } from './WorkflowsPanel.js';

describe('workflow web state', () => {
  let ws;
  let manager;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', new EventTarget());
    vi.stubGlobal('window', {});
    ws = Object.assign(new EventTarget(), { send: vi.fn(() => true) });
    manager = new WorkflowsManager(ws);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const deliver = (type, detail) =>
    ws.dispatchEvent(new CustomEvent(type, { detail }));

  it('owns the snapshot before any transcript card subscribes', () => {
    const runs = [{ runId: 'wf_run', status: 'completed' }];
    deliver('workflow_list', { runs });
    expect(manager.get('wf_run')).toEqual(runs[0]);
    expect(window.auditariaWorkflowRuns).toEqual(runs);
  });

  it('correlates concurrent control responses and exposes server errors', async () => {
    const stop = manager.update('stop', 'wf_a');
    const retry = manager.update('retry_agent', 'wf_b', 3);
    const stopped = expect(stop).resolves.toBe('Stopped');
    const rejected = expect(retry).rejects.toThrow('Agent finished');
    const [stopRequest, retryRequest] = ws.send.mock.calls.map(
      ([request]) => request,
    );
    deliver('workflow_event', {
      event: 'action_result',
      requestId: retryRequest.requestId,
      ok: false,
      message: 'Agent finished',
    });
    deliver('workflow_event', {
      event: 'action_result',
      requestId: stopRequest.requestId,
      ok: true,
      message: 'Stopped',
    });
    await Promise.all([stopped, rejected]);
    expect(manager.pending.size).toBe(0);
  });

  it('rejects pending actions when disconnected', async () => {
    const pending = manager.update('pause', 'wf_a');
    const rejected = expect(pending).rejects.toThrow('Connection lost');
    deliver('disconnected');
    await rejected;
    expect(manager.pending.size).toBe(0);
  });

  it('shows unphased agents alongside empty planned phases', () => {
    const agent = {
      type: 'workflow_agent',
      index: 1,
      phaseIndex: 0,
      label: 'Research',
    };
    const groups = workflowGroups([
      { type: 'workflow_phase', index: 1, title: 'Later' },
      agent,
    ]);
    expect(groups).toEqual([
      { index: 0, title: 'Agents', agents: [agent] },
      { type: 'workflow_phase', index: 1, title: 'Later', agents: [] },
    ]);
  });
});
