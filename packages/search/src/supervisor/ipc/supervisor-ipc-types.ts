/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Supervisor IPC Protocol Types
// Defines message types for communication between main process and child process.
// Uses JSONL (JSON Lines) protocol over stdin/stdout.

import type { SearchSystemConfig, DeepPartial } from '../../config.js';

// ============================================================================
// Main → Child Messages
// ============================================================================

/**
 * Initialize the SearchSystem in the child process.
 */
export interface SupervisorInitMessage {
  type: 'supervisor_init';
  id: string;
  rootPath: string;
  databasePath: string;
  config: DeepPartial<SearchSystemConfig>;
}

/**
 * Call a method on the SearchSystem.
 */
export interface SupervisorCallMessage {
  type: 'supervisor_call';
  id: string;
  method: string;
  args: unknown[];
}

/**
 * Request graceful shutdown.
 */
export interface SupervisorShutdownMessage {
  type: 'supervisor_shutdown';
  id: string;
}

/**
 * Health check ping.
 */
export interface SupervisorPingMessage {
  type: 'supervisor_ping';
  id: string;
}

/**
 * Union type of all main → child messages.
 */
export type MainToChildMessage =
  | SupervisorInitMessage
  | SupervisorCallMessage
  | SupervisorShutdownMessage
  | SupervisorPingMessage;

// ============================================================================
// Child → Main Messages
// ============================================================================

/**
 * Child process is ready to receive commands.
 */
export interface SupervisorReadyMessage {
  type: 'supervisor_ready';
  memoryUsageMb: number;
}

/**
 * Result of a method call.
 */
export interface SupervisorResultMessage {
  type: 'supervisor_result';
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Event forwarded from SearchSystem.
 */
export interface SupervisorEventMessage {
  type: 'supervisor_event';
  event: string;
  data: unknown;
}

/**
 * Memory usage report.
 */
export interface SupervisorMemoryMessage {
  type: 'supervisor_memory';
  memoryUsageMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
}

/**
 * Error in child process.
 */
export interface SupervisorErrorMessage {
  type: 'supervisor_error';
  id?: string;
  error: string;
  fatal: boolean;
}

/**
 * Response to ping.
 */
export interface SupervisorPongMessage {
  type: 'supervisor_pong';
  id: string;
  memoryUsageMb: number;
}

/**
 * Child is shutting down.
 */
export interface SupervisorShuttingDownMessage {
  type: 'supervisor_shutting_down';
  id: string;
}

/**
 * Union type of all child → main messages.
 */
export type ChildToMainMessage =
  | SupervisorReadyMessage
  | SupervisorResultMessage
  | SupervisorEventMessage
  | SupervisorMemoryMessage
  | SupervisorErrorMessage
  | SupervisorPongMessage
  | SupervisorShuttingDownMessage;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get current memory usage in MB.
 */
export function getMemoryUsageMb(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

/**
 * Get detailed memory usage.
 */
export function getDetailedMemoryUsage(): {
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  rssMb: number;
} {
  const usage = process.memoryUsage();
  return {
    heapUsedMb: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(usage.heapTotal / 1024 / 1024),
    externalMb: Math.round(usage.external / 1024 / 1024),
    rssMb: Math.round(usage.rss / 1024 / 1024),
  };
}

/**
 * Serialize a message to JSON string for IPC.
 */
export function serializeMessage(msg: MainToChildMessage | ChildToMainMessage): string {
  return JSON.stringify(msg);
}

/**
 * Parse a JSON line into a message.
 */
export function parseMessage(line: string): ChildToMainMessage | null {
  try {
    return JSON.parse(line) as ChildToMainMessage;
  } catch {
    return null;
  }
}

/**
 * Generate a unique message ID.
 */
export function generateMessageId(): string {
  return crypto.randomUUID();
}

// ============================================================================
// Pending Call Tracking
// ============================================================================

/**
 * Represents a pending method call waiting for response.
 */
export interface PendingCall {
  id: string;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  startTime: number;
}

/**
 * Create a pending call tracker.
 */
export function createPendingCall(
  id: string,
  method: string,
  timeoutMs: number,
  onTimeout: () => void,
): {
  pendingCall: Omit<PendingCall, 'resolve' | 'reject'>;
  promise: Promise<unknown>;
} {
  let resolve: (value: unknown) => void;
  let reject: (error: Error) => void;

  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  const timeout = setTimeout(onTimeout, timeoutMs);

  const pendingCall: PendingCall = {
    id,
    method,
    resolve: resolve!,
    reject: reject!,
    timeout,
    startTime: Date.now(),
  };

  return {
    pendingCall,
    promise,
  };
}
