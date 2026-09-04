/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { WebSocket } from 'ws';
import { CircularMessageBuffer } from './messageBuffer.js';

export interface ClientState {
  readonly buffer: CircularMessageBuffer;
  lastAcknowledgedSequence: number;
}

type ClientListener = (ws: WebSocket) => void;

/**
 * The set of connected chat clients plus their per-connection resilience
 * state. Every add/remove flows through here so connect/disconnect side
 * effects (file-watch cleanup, terminal-bridge client count, …) fire exactly
 * once no matter which code path noticed the socket going away.
 */
export class ClientRegistry implements Iterable<WebSocket> {
  private readonly clients = new Set<WebSocket>();
  private readonly states = new WeakMap<WebSocket, ClientState>();
  private readonly connectListeners = new Set<ClientListener>();
  private readonly disconnectListeners = new Set<ClientListener>();

  constructor(private readonly bufferCapacity: number) {}

  get size(): number {
    return this.clients.size;
  }

  has(ws: WebSocket): boolean {
    return this.clients.has(ws);
  }

  stateOf(ws: WebSocket): ClientState | undefined {
    return this.states.get(ws);
  }

  [Symbol.iterator](): Iterator<WebSocket> {
    return this.clients[Symbol.iterator]();
  }

  /** Registers a client. Idempotent: re-adding returns the existing state. */
  add(ws: WebSocket): ClientState {
    const existing = this.states.get(ws);
    if (existing && this.clients.has(ws)) {
      return existing;
    }
    const state: ClientState = {
      buffer: new CircularMessageBuffer(this.bufferCapacity),
      lastAcknowledgedSequence: 0,
    };
    this.clients.add(ws);
    this.states.set(ws, state);
    this.notify(this.connectListeners, ws);
    return state;
  }

  /** Unregisters a client. Returns false if it was not registered. */
  remove(ws: WebSocket): boolean {
    if (!this.clients.delete(ws)) {
      return false;
    }
    this.states.delete(ws);
    this.notify(this.disconnectListeners, ws);
    return true;
  }

  /** Unregisters every client and returns them (for closing). */
  removeAll(): WebSocket[] {
    const removed = Array.from(this.clients);
    for (const ws of removed) {
      this.remove(ws);
    }
    return removed;
  }

  onConnected(listener: ClientListener): () => void {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  onDisconnected(listener: ClientListener): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private notify(listeners: Set<ClientListener>, ws: WebSocket): void {
    for (const listener of Array.from(listeners)) {
      listener(ws);
    }
  }
}
