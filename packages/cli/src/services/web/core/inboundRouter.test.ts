/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  FakeSocket,
  createTestLogger,
} from '../../../test-utils/webTestSupport.js';
import { InboundRouter } from './inboundRouter.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('InboundRouter', () => {
  it('routes a parsed frame to the handler registered for its type', () => {
    const logger = createTestLogger();
    const router = new InboundRouter(logger);
    const ws = new FakeSocket().asWebSocket();
    const handler = vi.fn();
    router.on('user_message', handler);

    router.dispatch(
      JSON.stringify({ type: 'user_message', content: 'hi' }),
      ws,
    );

    expect(handler).toHaveBeenCalledWith(
      { type: 'user_message', content: 'hi' },
      ws,
    );
    expect(router.has('user_message')).toBe(true);
  });

  it('refuses a second handler for the same type', () => {
    const router = new InboundRouter(createTestLogger());
    router.on('ack', () => {});
    expect(() => router.on('ack', () => {})).toThrow(/already registered/);
  });

  it('ignores malformed frames and unknown types without throwing', () => {
    const logger = createTestLogger();
    const router = new InboundRouter(logger);
    const ws = new FakeSocket().asWebSocket();

    router.dispatch('not json', ws);
    router.dispatch(JSON.stringify({ noType: true }), ws);
    router.dispatch(JSON.stringify({ type: 'mystery' }), ws);

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('isolates synchronous and asynchronous handler failures', async () => {
    const logger = createTestLogger();
    const router = new InboundRouter(logger);
    const ws = new FakeSocket().asWebSocket();
    router.on('interrupt_request', () => {
      throw new Error('sync boom');
    });
    router.on('parse_request', async () => {
      throw new Error('async boom');
    });

    expect(() =>
      router.dispatch(JSON.stringify({ type: 'interrupt_request' }), ws),
    ).not.toThrow();
    router.dispatch(JSON.stringify({ type: 'parse_request' }), ws);
    await flush();

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(String(logger.error.mock.calls[0][0])).toContain(
      'interrupt_request',
    );
    expect(String(logger.error.mock.calls[1][0])).toContain('parse_request');
  });
});
