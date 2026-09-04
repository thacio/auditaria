/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  FakeSocket,
  createTestLogger,
} from '../../../test-utils/webTestSupport.js';
import { Broadcaster } from './broadcaster.js';
import { ClientRegistry } from './clientRegistry.js';

function setup(clientCount = 2) {
  const registry = new ClientRegistry(10);
  const logger = createTestLogger();
  const broadcaster = new Broadcaster(registry, logger);
  const sockets = Array.from({ length: clientCount }, () => new FakeSocket());
  for (const socket of sockets) registry.add(socket.asWebSocket());
  return { registry, broadcaster, sockets, logger };
}

describe('ClientRegistry', () => {
  it('adds and removes idempotently and notifies listeners once', () => {
    const registry = new ClientRegistry(5);
    const socket = new FakeSocket().asWebSocket();
    const connected = vi.fn();
    const disconnected = vi.fn();
    registry.onConnected(connected);
    registry.onDisconnected(disconnected);

    const state = registry.add(socket);
    expect(registry.add(socket)).toBe(state);
    expect(registry.size).toBe(1);
    expect(connected).toHaveBeenCalledTimes(1);

    expect(registry.remove(socket)).toBe(true);
    expect(registry.remove(socket)).toBe(false);
    expect(registry.size).toBe(0);
    expect(registry.stateOf(socket)).toBeUndefined();
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it('removeAll returns every client and empties the registry', () => {
    const registry = new ClientRegistry(5);
    const a = new FakeSocket().asWebSocket();
    const b = new FakeSocket().asWebSocket();
    registry.add(a);
    registry.add(b);
    expect(registry.removeAll()).toEqual([a, b]);
    expect(registry.size).toBe(0);
  });

  it('unsubscribes listeners', () => {
    const registry = new ClientRegistry(5);
    const listener = vi.fn();
    const off = registry.onConnected(listener);
    off();
    registry.add(new FakeSocket().asWebSocket());
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('Broadcaster', () => {
  it('does nothing without clients', () => {
    const registry = new ClientRegistry(10);
    const broadcaster = new Broadcaster(registry, createTestLogger());
    broadcaster.broadcast('clear', null);
    expect(broadcaster.currentSequence).toBe(0);
  });

  it('sends one sequenced envelope to every client and buffers it', () => {
    const { registry, broadcaster, sockets } = setup();
    broadcaster.broadcast('history_item', { id: 1 });

    for (const socket of sockets) {
      expect(socket.envelopes).toEqual([
        {
          type: 'history_item',
          data: { id: 1 },
          sequence: 1,
          timestamp: expect.any(Number),
        },
      ]);
      const state = registry.stateOf(socket.asWebSocket());
      expect(state?.buffer.hasSequence(1)).toBe(true);
    }
    expect(broadcaster.currentSequence).toBe(1);
  });

  it('marks ephemeral messages and applies a replacer', () => {
    const { broadcaster, sockets } = setup(1);
    broadcaster.broadcast(
      'response_state',
      { secret: 'x' },
      {
        ephemeral: true,
        replacer: (key, value) => (key === 'secret' ? 'hidden' : value),
      },
    );
    expect(sockets[0].envelopes[0]).toMatchObject({
      ephemeral: true,
      data: { secret: 'hidden' },
    });
  });

  it('drops closed sockets and failed sends from the registry', () => {
    const { registry, broadcaster, sockets } = setup(3);
    const disconnected = vi.fn();
    registry.onDisconnected(disconnected);
    sockets[0].readyState = WebSocket.CLOSED;
    sockets[1].failNextSend = true;

    broadcaster.broadcast('clear', null);

    expect(registry.size).toBe(1);
    expect(registry.has(sockets[2].asWebSocket())).toBe(true);
    expect(sockets[2].types).toEqual(['clear']);
    expect(disconnected).toHaveBeenCalledTimes(2);
  });

  it('unicasts with fresh or caller-chosen sequences', () => {
    const { broadcaster, sockets } = setup(2);
    const [a, b] = sockets;
    expect(broadcaster.send(a.asWebSocket(), 'footer_data', 'f')).toBe(true);
    const seq = broadcaster.nextSequence();
    broadcaster.sendSequenced(a.asWebSocket(), seq, 'connection', {
      startingSequence: seq,
    });
    expect(a.envelopes.map((e) => e['sequence'])).toEqual([1, 2]);
    expect(a.envelopes[1]['data']).toEqual({ startingSequence: 2 });
    expect(b.sent).toEqual([]);
  });

  it('sendTo only reaches registered targets', () => {
    const { broadcaster, sockets } = setup(2);
    const stranger = new FakeSocket();
    broadcaster.sendTo(
      [sockets[1].asWebSocket(), stranger.asWebSocket()],
      'file_external_change',
      { path: 'a' },
    );
    expect(sockets[0].sent).toEqual([]);
    expect(sockets[1].types).toEqual(['file_external_change']);
    expect(stranger.sent).toEqual([]);
  });

  it('sendRaw is neither sequenced nor buffered', () => {
    const { registry, broadcaster, sockets } = setup(1);
    broadcaster.sendRaw(sockets[0].asWebSocket(), { type: 'force_resync' });
    expect(sockets[0].envelopes[0]).toEqual({ type: 'force_resync' });
    expect(broadcaster.currentSequence).toBe(0);
    const state = registry.stateOf(sockets[0].asWebSocket());
    expect(state?.buffer.getOldestSequence()).toBeNull();
  });

  it('replays serialized messages verbatim', () => {
    const { broadcaster, sockets } = setup(1);
    expect(broadcaster.replay(sockets[0].asWebSocket(), '{"x":1}')).toBe(true);
    expect(sockets[0].sent).toEqual(['{"x":1}']);
  });

  it('wraps the sequence counter before it overflows', () => {
    const { broadcaster } = setup(0);
    Object.assign(broadcaster, { sequence: Number.MAX_SAFE_INTEGER - 1_000 });
    expect(broadcaster.nextSequence()).toBe(1);
  });
});
