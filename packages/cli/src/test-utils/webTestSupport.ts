/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: shared helpers for the web-server unit tests.

import { WebSocket } from 'ws';
import { vi } from 'vitest';
import type { WebLogger } from '../services/web/core/types.js';

/** A logger whose calls can be asserted on. */
export function createTestLogger(): WebLogger & {
  debug: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Minimal stand-in for a `ws` socket: records what was sent and lets a test
 * flip the ready state or make the next send fail.
 */
export class FakeSocket {
  readyState: number = WebSocket.OPEN;
  readonly sent: string[] = [];
  failNextSend = false;

  send(payload: string): void {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('send failed');
    }
    this.sent.push(payload);
  }

  /** Parsed envelopes sent so far. */
  get envelopes(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  /** Message types sent so far, in order. */
  get types(): string[] {
    return this.envelopes.map((envelope) => String(envelope['type']));
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  asWebSocket(): WebSocket {
     
    return this as unknown as WebSocket;
  }
}
