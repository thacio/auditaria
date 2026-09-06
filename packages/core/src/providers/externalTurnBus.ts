/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: Process-wide bus for provider turns the UI did
 * not start. The active ProviderManager publishes here; the CLI subscribes
 * once at mount (`useProviderExternalTurns`). A singleton — like
 * `providerPtyMirror` — so the UI never has to track when a manager is
 * created, swapped (provider switch) or disposed.
 */

import { EventEmitter } from 'node:events';
import type { ServerGeminiStreamEvent } from '../core/turn.js';
import type { ExternalTurnSource, ProviderNotice } from './types.js';

/** A turn already translated to the UI's event vocabulary and mirrored
 *  into the chat history by the manager — render it like a chat turn. */
export interface ManagedExternalTurn {
  promptId: string;
  source: ExternalTurnSource;
  userText: string;
  stream: AsyncIterable<ServerGeminiStreamEvent>;
  /** Interrupt the turn in the provider (what Esc does for a chat turn). */
  interrupt(): void;
}

class ProviderTurnBus {
  private readonly emitter = new EventEmitter();

  onTurn(listener: (turn: ManagedExternalTurn) => void): () => void {
    this.emitter.on('turn', listener);
    return () => this.emitter.off('turn', listener);
  }

  onNotice(listener: (notice: ProviderNotice) => void): () => void {
    this.emitter.on('notice', listener);
    return () => this.emitter.off('notice', listener);
  }

  /** Returns false when nobody is listening (headless — caller must drain). */
  emitTurn(turn: ManagedExternalTurn): boolean {
    return this.emitter.emit('turn', turn);
  }

  emitNotice(notice: ProviderNotice): void {
    this.emitter.emit('notice', notice);
  }
}

export const providerTurnBus = new ProviderTurnBus();
