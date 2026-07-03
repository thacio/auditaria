/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Bridge for CLI ↔ Hive display sync and the turn-boundary idle signal.
// Module-level callback storage avoids circular dependencies between
// HiveService and React hooks (same shape as TelegramBridge).

import type { HistoryItemWithoutId } from '../../ui/types.js';

// --- CLI display push ---
// Allows HiveService to show hive messages/turn output in the CLI history.

type CliDisplayCallback = (item: HistoryItemWithoutId, ts?: number) => void;
let cliDisplayCallback: CliDisplayCallback | undefined;

export function registerHiveCliDisplayCallback(cb: CliDisplayCallback): void {
  cliDisplayCallback = cb;
}

export function unregisterHiveCliDisplayCallback(): void {
  cliDisplayCallback = undefined;
}

export function pushHiveToCliDisplay(item: HistoryItemWithoutId): void {
  cliDisplayCallback?.(item, Date.now());
}

// --- Hive processing flag ---
// True while a hive-triggered turn is running. Lets other components avoid
// echoing hive output back into the hive.

let hiveProcessing = false;

export function setHiveProcessing(value: boolean): void {
  hiveProcessing = value;
}

export function isHiveProcessing(): boolean {
  return hiveProcessing;
}

// --- Turn-boundary idle signal (§6.1) ---
// AppContainer publishes StreamingState transitions here; HiveService's
// drain-on-idle loop subscribes. This is the explicit signal the Telegram
// pattern lacks — its mutex only serializes its OWN turns, so hive delivery
// needs a real "the main session is idle" boundary.

type IdleListener = (idle: boolean) => void;
let streamingIdle = true;
const idleListeners = new Set<IdleListener>();

export function publishStreamingIdle(idle: boolean): void {
  if (streamingIdle === idle) return;
  streamingIdle = idle;
  for (const listener of idleListeners) {
    try {
      listener(idle);
    } catch {
      /* listener errors must not break the UI effect */
    }
  }
}

export function isStreamingIdle(): boolean {
  return streamingIdle;
}

/** Subscribe to idle transitions. Returns the unsubscribe function. */
export function onStreamingIdle(listener: IdleListener): () => void {
  idleListeners.add(listener);
  return () => idleListeners.delete(listener);
}
