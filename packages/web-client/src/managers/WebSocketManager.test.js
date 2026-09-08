/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketManager } from './WebSocketManager.js';

describe('WebSocketManager message recovery', () => {
  let manager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new WebSocketManager();
    manager.isConnected = true;
    manager.socket = { send: vi.fn() };
    manager.handleMessage({
      type: 'connection',
      sequence: 1,
      data: { startingSequence: 1 },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const requests = () =>
    manager.socket.send.mock.calls
      .map(([payload]) => JSON.parse(payload))
      .filter((message) => message.type === 'resync_request');

  it('does not resync after streaming updates and a completed tool call', () => {
    manager.handleMessage({ type: 'history_item', sequence: 2, data: {} });
    manager.handleMessage({
      type: 'response_state',
      sequence: 3,
      ephemeral: true,
      data: [],
    });
    manager.handleMessage({
      type: 'loading_state',
      sequence: 4,
      ephemeral: true,
      data: {},
    });
    vi.advanceTimersByTime(manager.ACK_BATCH_DELAY);
    manager.handleMessage({
      type: 'history_item',
      sequence: 5,
      data: { type: 'tool_group' },
    });

    expect(requests()).toEqual([]);
    expect(manager.lastReceivedSequence).toBe(5);
  });

  it('requests recovery for a real gap, even when the next update is ephemeral', () => {
    manager.handleMessage({
      type: 'response_state',
      sequence: 3,
      ephemeral: true,
      data: [],
    });

    expect(requests()).toEqual([
      { type: 'resync_request', from: 1, persistentOnly: true },
    ]);
  });

  it('delivers a missing replay once without moving the live cursor backwards', () => {
    const received = vi.fn();
    manager.addEventListener('history_item', received);
    manager.handleMessage({ type: 'history_item', sequence: 4, data: {} });
    const replay = { type: 'history_item', sequence: 2, data: {} };
    manager.handleMessage(replay);
    manager.handleMessage(replay);
    manager.handleMessage({ type: 'history_item', sequence: 5, data: {} });

    expect(received).toHaveBeenCalledTimes(3);
    expect(requests()).toHaveLength(1);
    expect(manager.lastReceivedSequence).toBe(5);
    expect(manager.lastPersistentSequence).toBe(5);
  });

  it('checks tab visibility recovery from the latest received streaming update', () => {
    manager.handleMessage({
      type: 'response_state',
      sequence: 2,
      ephemeral: true,
      data: [],
    });
    manager.checkForMissedMessages();

    expect(requests()).toEqual([
      { type: 'resync_request', from: 2, persistentOnly: true },
    ]);
  });
});
