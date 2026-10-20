/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowService } from '@google/gemini-cli-core';
import { WorkflowFeature } from './WorkflowFeature.js';
import {
  FakeSocket,
  createTestLogger,
} from '../../../test-utils/webTestSupport.js';
import { Broadcaster } from '../core/broadcaster.js';
import { ClientRegistry } from '../core/clientRegistry.js';
import { InboundRouter } from '../core/inboundRouter.js';

describe('WorkflowFeature controls', () => {
  const service = Object.assign(new EventEmitter(), {
    registry: { list: () => [] },
    stop: vi.fn(() => ({ ok: true })),
    pause: vi.fn(() => true),
    resume: vi.fn(async () => ({ runId: 'wf_run' })),
    save: vi.fn(() => 'saved.js'),
    skipAgent: vi.fn(() => true),
    retryAgent: vi.fn(() => true),
    agentDetail: vi.fn(async () => ({
      prompt: 'Full prompt',
      result: 'Full result',
      tools: [],
      truncated: false,
    })),
  });
  let feature: WorkflowFeature;
  let inbound: InboundRouter;
  let requester: FakeSocket;
  let observer: FakeSocket;
  beforeEach(async () => {
    vi.clearAllMocks();
    const logger = createTestLogger();
    const clients = new ClientRegistry(50);
    inbound = new InboundRouter(logger);
    requester = new FakeSocket();
    observer = new FakeSocket();
    clients.add(requester.asWebSocket());
    clients.add(observer.asWebSocket());
    feature = new WorkflowFeature(service as unknown as WorkflowService);
    await feature.attach({
      workspaceRoot: process.cwd(),
      logger,
      clients,
      inbound,
      broadcaster: new Broadcaster(clients, logger),
      http: { mount: () => {}, mountHost: () => {} },
      ws: { addEndpoint: () => {} },
    });
  });
  afterEach(async () => {
    await feature.detach();
  });
  const send = (data: Record<string, unknown>) =>
    inbound.dispatch(
      JSON.stringify({
        type: 'workflow_update_request',
        id: 'wf_run',
        requestId: 'req',
        ...data,
      }),
      requester.asWebSocket(),
    );

  it('acknowledges controls only to the requesting client', () => {
    send({ op: 'retry_agent', index: 2 });
    expect(service.retryAgent).toHaveBeenCalledWith('wf_run', 2);
    expect(requester.envelopes[0]?.['data']).toMatchObject({
      event: 'action_result',
      requestId: 'req',
      ok: true,
    });
    expect(observer.sent).toHaveLength(0);
  });

  it('sends an agent transcript only to the client that requested it', async () => {
    send({ op: 'agent_detail', index: 4 });
    await vi.waitFor(() =>
      expect(requester.envelopes[0]?.['data']).toMatchObject({
        ok: true,
        detail: { prompt: 'Full prompt', result: 'Full result' },
      }),
    );
    expect(service.agentDetail).toHaveBeenCalledWith('wf_run', 4);
    expect(observer.sent).toHaveLength(0);
  });

  it('reports rejected and malformed agent operations', () => {
    send({ op: 'skip_agent', index: 1.5 });
    expect(service.skipAgent).not.toHaveBeenCalled();
    expect(requester.envelopes[0]?.['data']).toMatchObject({ ok: false });
    send({ op: 'unknown' });
    expect(requester.envelopes[1]?.['data']).toMatchObject({
      ok: false,
      message: 'Unknown workflow action.',
    });
  });

  it('waits for resume and returns failures instead of silently ignoring them', async () => {
    service.resume.mockRejectedValueOnce(new Error('Script is missing'));
    send({ op: 'resume' });
    await vi.waitFor(() =>
      expect(requester.envelopes[0]?.['data']).toMatchObject({
        ok: false,
        message: 'Script is missing',
      }),
    );
  });

  it('saves to the selected scope and unsubscribes when detached', async () => {
    send({ op: 'save', scope: 'user' });
    expect(service.save).toHaveBeenCalledWith('wf_run', 'user');
    expect(service.listenerCount('change')).toBe(1);
    await feature.detach();
    expect(service.listenerCount('change')).toBe(0);
    expect(service.listenerCount('notice')).toBe(0);
  });
});
