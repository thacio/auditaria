/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CircularMessageBuffer,
  type SequencedMessage,
} from './messageBuffer.js';

const entry = (sequence: number, ephemeral?: boolean): SequencedMessage => ({
  sequence,
  message: `m${sequence}`,
  timestamp: sequence,
  ephemeral,
});

const sequencesOf = (messages: SequencedMessage[]) =>
  messages.map((m) => m.sequence);

describe('CircularMessageBuffer', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new CircularMessageBuffer(0)).toThrow();
    expect(() => new CircularMessageBuffer(1.5)).toThrow();
  });

  it('returns messages newer than a sequence, in order', () => {
    const buffer = new CircularMessageBuffer(10);
    for (const seq of [3, 1, 2]) buffer.add(entry(seq));
    expect(sequencesOf(buffer.getMessagesFrom(1))).toEqual([2, 3]);
    expect(sequencesOf(buffer.getMessagesFrom(0))).toEqual([1, 2, 3]);
    expect(buffer.hasSequence(2)).toBe(true);
    expect(buffer.hasSequence(9)).toBe(false);
  });

  it('evicts the oldest entries once full', () => {
    const buffer = new CircularMessageBuffer(3);
    for (const seq of [1, 2, 3, 4, 5]) buffer.add(entry(seq));
    expect(sequencesOf(buffer.getMessagesFrom(0))).toEqual([3, 4, 5]);
    expect(buffer.getOldestSequence()).toBe(3);
    expect(buffer.hasSequence(1)).toBe(false);
  });

  it('keeps only the latest snapshot per latest-only type', () => {
    const buffer = new CircularMessageBuffer(3);
    buffer.add(entry(1), 'file_tree_response');
    buffer.add(entry(2), 'history_item');
    buffer.add(entry(3), 'file_tree_response');
    expect(sequencesOf(buffer.getMessagesFrom(0))).toEqual([2, 3]);
    expect(buffer.hasSequence(1)).toBe(false);
    expect(buffer.hasSequence(3)).toBe(true);
    // Snapshots do not consume ring slots.
    buffer.add(entry(4));
    buffer.add(entry(5));
    expect(sequencesOf(buffer.getMessagesFrom(0))).toEqual([2, 3, 4, 5]);
  });

  it('filters ephemeral messages when only persistent ones are wanted', () => {
    const buffer = new CircularMessageBuffer(5);
    buffer.add(entry(1));
    buffer.add(entry(2, true));
    buffer.add(entry(3, true), 'response_state');
    buffer.add(entry(4));
    expect(sequencesOf(buffer.getMessagesFrom(0, true))).toEqual([1, 4]);
    expect(sequencesOf(buffer.getMessagesFrom(0))).toEqual([1, 2, 3, 4]);
  });

  it('prunes acknowledged entries and still reports the real oldest one', () => {
    const buffer = new CircularMessageBuffer(5);
    for (const seq of [1, 2, 3, 4]) buffer.add(entry(seq));
    expect(buffer.pruneAcknowledged(2)).toBe(2);
    expect(buffer.getOldestSequence()).toBe(3);
    expect(sequencesOf(buffer.getMessagesFrom(0))).toEqual([3, 4]);
    expect(buffer.pruneAcknowledged(2)).toBe(0);
  });

  it('reports null as the oldest sequence when empty', () => {
    expect(new CircularMessageBuffer(2).getOldestSequence()).toBeNull();
  });
});
