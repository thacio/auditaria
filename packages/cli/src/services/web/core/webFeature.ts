/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { WebSocket } from 'ws';
import type { ServerMessageType } from '../protocol.js';
import type { SendOptions } from './broadcaster.js';
import type { ListenInfo, WebFeatureContext } from './types.js';

/**
 * A self-contained capability of the web interface: file browser, knowledge
 * base, provider terminal, … Features are constructed once and outlive
 * server restarts, so any state that must survive `/web stop` + `/web start`
 * (the chat history snapshot, for example) lives on the feature instance.
 *
 * Lifecycle:
 *   attach(ctx)  — server starting: register inbound handlers, HTTP routes
 *                  and WebSocket endpoints, subscribe to external sources.
 *   detach()     — server stopping: release everything acquired in attach.
 *
 * Per-client hooks:
 *   sendInitialState(ws)     — push the feature's current snapshot to a
 *                              freshly connected (or force-resynced) client.
 *   onClientDisconnected(ws) — release per-client resources.
 *
 * The `broadcast`/`send` helpers are safe to call while detached: they are
 * no-ops, which is exactly what the CLI expects when it pushes footer or
 * history updates before the web interface is started.
 */
export abstract class WebFeature {
  abstract readonly name: string;

  private context: WebFeatureContext | null = null;

  protected get ctx(): WebFeatureContext | null {
    return this.context;
  }

  protected get isAttached(): boolean {
    return this.context !== null;
  }

  async attach(ctx: WebFeatureContext): Promise<void> {
    if (this.context) {
      throw new Error(`Web feature "${this.name}" is already attached`);
    }
    this.context = ctx;
    try {
      await this.onAttach(ctx);
    } catch (error) {
      this.context = null;
      throw error;
    }
  }

  async detach(): Promise<void> {
    if (!this.context) return;
    try {
      await this.onDetach();
    } finally {
      this.context = null;
    }
  }

  protected abstract onAttach(ctx: WebFeatureContext): void | Promise<void>;

  protected onDetach(): void | Promise<void> {}

  /**
   * Called once the server is listening (after every feature attached), with
   * the bound port and the origins the console answers on. Features that
   * build absolute URLs or origin allowlists implement this.
   */
  onListening?(info: ListenInfo): void;

  sendInitialState?(ws: WebSocket): void;

  onClientDisconnected?(ws: WebSocket): void;

  protected broadcast(
    type: ServerMessageType,
    data: unknown,
    options?: SendOptions,
  ): void {
    this.context?.broadcaster.broadcast(type, data, options);
  }

  protected send(
    ws: WebSocket,
    type: ServerMessageType,
    data: unknown,
    options?: SendOptions,
  ): void {
    this.context?.broadcaster.send(ws, type, data, options);
  }
}
