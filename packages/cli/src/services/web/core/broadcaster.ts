/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { WebSocket } from 'ws';
import type { ServerEnvelope, ServerMessageType } from '../protocol.js';
import type { ClientRegistry } from './clientRegistry.js';
import type { WebLogger } from './types.js';

export type JsonReplacer = (key: string, value: unknown) => unknown;

export interface SendOptions {
  /** Transient UI state — skipped when a client replays a gap. */
  readonly ephemeral?: boolean;
  /** JSON.stringify replacer, e.g. to strip binary blobs from history. */
  readonly replacer?: JsonReplacer;
}

/** Leave headroom before MAX_SAFE_INTEGER so the wrap is never mid-burst. */
const MAX_SEQUENCE_NUMBER = Number.MAX_SAFE_INTEGER - 1_000_000;

/**
 * The single place that builds envelopes, assigns sequence numbers, writes
 * to sockets, and records what was sent in each client's replay buffer.
 * Sockets that are closed or fail to write are dropped from the registry
 * immediately so every code path sees a consistent client set.
 */
export class Broadcaster {
  private sequence = 0;

  constructor(
    private readonly clients: ClientRegistry,
    private readonly logger: WebLogger,
  ) {}

  /** The most recently assigned sequence number. */
  get currentSequence(): number {
    return this.sequence;
  }

  nextSequence(): number {
    if (this.sequence >= MAX_SEQUENCE_NUMBER) {
      this.sequence = 0;
    }
    return ++this.sequence;
  }

  /** Sends to every connected chat client. No-op without clients. */
  broadcast(
    type: ServerMessageType,
    data: unknown,
    options: SendOptions = {},
  ): void {
    if (this.clients.size === 0) {
      return;
    }
    const sequence = this.nextSequence();
    const timestamp = Date.now();
    const payload = this.encode(type, data, sequence, timestamp, options);
    for (const ws of Array.from(this.clients)) {
      this.deliver(ws, type, sequence, timestamp, payload, options);
    }
  }

  /** Sends to the given clients only (they must still be registered). */
  sendTo(
    targets: Iterable<WebSocket>,
    type: ServerMessageType,
    data: unknown,
    options: SendOptions = {},
  ): void {
    const recipients = Array.from(targets).filter((ws) => this.clients.has(ws));
    if (recipients.length === 0) {
      return;
    }
    const sequence = this.nextSequence();
    const timestamp = Date.now();
    const payload = this.encode(type, data, sequence, timestamp, options);
    for (const ws of recipients) {
      this.deliver(ws, type, sequence, timestamp, payload, options);
    }
  }

  /** Sends a freshly sequenced message to one client. */
  send(
    ws: WebSocket,
    type: ServerMessageType,
    data: unknown,
    options: SendOptions = {},
  ): boolean {
    return this.sendSequenced(ws, this.nextSequence(), type, data, options);
  }

  /**
   * Sends one message with a caller-chosen sequence (obtained from
   * `nextSequence()`), for payloads that must embed their own sequence.
   */
  sendSequenced(
    ws: WebSocket,
    sequence: number,
    type: ServerMessageType,
    data: unknown,
    options: SendOptions = {},
  ): boolean {
    const timestamp = Date.now();
    const payload = this.encode(type, data, sequence, timestamp, options);
    return this.deliver(ws, type, sequence, timestamp, payload, options);
  }

  /** Replays an already-serialized message verbatim (gap recovery). */
  replay(ws: WebSocket, serialized: string): boolean {
    return this.write(ws, serialized);
  }

  /** Sends an unsequenced control message that is not buffered. */
  sendRaw(ws: WebSocket, payload: Readonly<Record<string, unknown>>): boolean {
    return this.write(ws, JSON.stringify(payload));
  }

  private encode(
    type: ServerMessageType,
    data: unknown,
    sequence: number,
    timestamp: number,
    options: SendOptions,
  ): string {
    const envelope: ServerEnvelope = options.ephemeral
      ? { type, data, sequence, ephemeral: true, timestamp }
      : { type, data, sequence, timestamp };
    return JSON.stringify(envelope, options.replacer);
  }

  private deliver(
    ws: WebSocket,
    type: ServerMessageType,
    sequence: number,
    timestamp: number,
    payload: string,
    options: SendOptions,
  ): boolean {
    if (!this.write(ws, payload)) {
      return false;
    }
    this.clients.stateOf(ws)?.buffer.add(
      {
        sequence,
        message: payload,
        timestamp,
        ephemeral: options.ephemeral,
      },
      type,
    );
    return true;
  }

  private write(ws: WebSocket, payload: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      this.clients.remove(ws);
      return false;
    }
    try {
      ws.send(payload);
      return true;
    } catch (error) {
      this.logger.warn('Dropping web client after send failure:', error);
      this.clients.remove(ws);
      return false;
    }
  }
}
