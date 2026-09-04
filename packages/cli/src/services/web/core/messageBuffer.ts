/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import {
  LATEST_ONLY_MESSAGE_TYPES,
  type ServerMessageType,
} from '../protocol.js';

/** A message already serialized for the wire, kept for gap recovery. */
export interface SequencedMessage {
  readonly sequence: number;
  readonly message: string;
  readonly timestamp: number;
  readonly ephemeral?: boolean;
}

/**
 * Fixed-capacity ring buffer of sent messages, one per client, so a client
 * that detects a sequence gap can ask for a replay. State-snapshot message
 * types (see `LATEST_ONLY_MESSAGE_TYPES`) are stored out of band, latest
 * only, because replaying stale snapshots is wasteful and misleading.
 */
export class CircularMessageBuffer {
  private readonly buffer: Array<SequencedMessage | null>;
  private head = 0;
  private tail = 0;
  private size = 0;
  private readonly latestOnly = new Map<string, SequencedMessage>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`Buffer capacity must be a positive integer`);
    }
    this.buffer = new Array<SequencedMessage | null>(capacity).fill(null);
  }

  add(message: SequencedMessage, messageType?: ServerMessageType): void {
    if (messageType && LATEST_ONLY_MESSAGE_TYPES.has(messageType)) {
      this.latestOnly.set(messageType, message);
      return;
    }

    this.buffer[this.tail] = message;
    this.tail = (this.tail + 1) % this.capacity;

    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Messages newer than `sequence`, in sequence order. */
  getMessagesFrom(
    sequence: number,
    persistentOnly = false,
  ): SequencedMessage[] {
    const accept = (msg: SequencedMessage): boolean =>
      msg.sequence > sequence && (!persistentOnly || !msg.ephemeral);

    const messages: SequencedMessage[] = [];
    this.forEachBuffered((msg) => {
      if (accept(msg)) messages.push(msg);
    });
    for (const msg of this.latestOnly.values()) {
      if (accept(msg)) messages.push(msg);
    }
    return messages.sort((a, b) => a.sequence - b.sequence);
  }

  hasSequence(sequence: number): boolean {
    let found = false;
    this.forEachBuffered((msg) => {
      if (msg.sequence === sequence) found = true;
    });
    if (found) return true;
    for (const msg of this.latestOnly.values()) {
      if (msg.sequence === sequence) return true;
    }
    return false;
  }

  /** Oldest retained sequence in the ring, or null when empty. */
  getOldestSequence(): number | null {
    if (this.size === 0) return null;
    // Acknowledged slots are nulled in place, so scan forward for the first
    // live entry instead of trusting the head slot.
    let oldest: number | null = null;
    this.forEachBuffered((msg) => {
      if (oldest === null || msg.sequence < oldest) oldest = msg.sequence;
    });
    return oldest;
  }

  /** Frees ring slots the client has acknowledged. Returns the count freed. */
  pruneAcknowledged(acknowledgedSequence: number): number {
    let pruned = 0;
    let current = this.head;
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg && msg.sequence <= acknowledgedSequence) {
        this.buffer[current] = null;
        pruned++;
      }
      current = (current + 1) % this.capacity;
    }
    return pruned;
  }

  private forEachBuffered(visit: (msg: SequencedMessage) => void): void {
    let current = this.head;
    for (let i = 0; i < this.size; i++) {
      const msg = this.buffer[current];
      if (msg) visit(msg);
      current = (current + 1) % this.capacity;
    }
  }
}
