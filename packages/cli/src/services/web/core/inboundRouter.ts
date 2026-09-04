/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { RawData, WebSocket } from 'ws';
import {
  parseClientMessage,
  type ClientMessage,
  type ClientMessageType,
} from '../protocol.js';
import type { WebLogger } from './types.js';

export type InboundHandler = (
  message: ClientMessage,
  ws: WebSocket,
) => void | Promise<void>;

/**
 * Dispatches chat-socket messages to the feature that registered their
 * type. Each type has exactly one owner (double registration is a
 * programming error and throws at startup), handlers validate their own
 * payload, and a throwing or rejecting handler is logged and isolated — one
 * bad message never takes the connection down.
 */
export class InboundRouter {
  private readonly handlers = new Map<string, InboundHandler>();

  constructor(private readonly logger: WebLogger) {}

  on(type: ClientMessageType, handler: InboundHandler): void {
    if (this.handlers.has(type)) {
      throw new Error(`Inbound handler for "${type}" is already registered`);
    }
    this.handlers.set(type, handler);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  /** Parses a raw socket frame and routes it. Never throws. */
  dispatch(raw: RawData | string, ws: WebSocket): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch (error) {
      this.logger.error('Error parsing WebSocket message:', error);
      return;
    }

    const message = parseClientMessage(parsed);
    if (!message) {
      this.logger.warn('Ignoring malformed WebSocket message (no type)');
      return;
    }
    this.route(message, ws);
  }

  /** Routes an already-parsed message. Never throws. */
  route(message: ClientMessage, ws: WebSocket): void {
    const handler = this.handlers.get(message.type);
    if (!handler) {
      this.logger.debug(`No handler for web message type "${message.type}"`);
      return;
    }
    try {
      const result = handler(message, ws);
      if (result instanceof Promise) {
        result.catch((error: unknown) => this.report(message.type, error));
      }
    } catch (error) {
      this.report(message.type, error);
    }
  }

  private report(type: string, error: unknown): void {
    this.logger.error(`Web message handler for "${type}" failed:`, error);
  }
}
