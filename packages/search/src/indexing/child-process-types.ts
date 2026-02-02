/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * IPC message types for communication between main process and indexing child process.
 *
 * The child process architecture solves the fundamental WASM memory limitation:
 * WebAssembly memory can only grow, never shrink. By running indexing in a child
 * process that exits after N documents, we ensure memory is fully released.
 *
 * Protocol: JSONL (JSON Lines) over stdin/stdout
 * - Main -> Child: Commands via child.stdin
 * - Child -> Main: Responses via child.stdout (parsed with readline)
 */

import type { DeepPartial, SearchSystemConfig } from '../config.js';

// ============================================================================
// Main -> Child Messages
// ============================================================================

/**
 * Command to start indexing in the child process.
 */
export interface StartIndexingMessage {
  type: 'start_indexing';
  /** Unique request ID for correlation */
  id: string;
  /** Root path of the project to index */
  rootPath: string;
  /** Path to the search database */
  databasePath: string;
  /** Search system configuration */
  config: DeepPartial<SearchSystemConfig>;
  /** Indexing options */
  options: {
    /** Force re-index all files */
    force?: boolean;
    /** Maximum documents to process before exiting (for respawn) */
    maxDocuments?: number;
    /** Specific file paths to index (for incremental indexing) */
    filePaths?: string[];
  };
}

/**
 * Command to gracefully shut down the child process.
 */
export interface ShutdownMessage {
  type: 'shutdown';
  /** Unique request ID for correlation */
  id: string;
}

/**
 * Health check ping message.
 */
export interface PingMessage {
  type: 'ping';
  /** Unique request ID for correlation */
  id: string;
}

/**
 * Union type for all messages from main to child.
 */
export type MainToChildMessage =
  | StartIndexingMessage
  | ShutdownMessage
  | PingMessage;

// ============================================================================
// Child -> Main Messages
// ============================================================================

/**
 * Sent when child process is initialized and ready to receive commands.
 */
export interface ReadyMessage {
  type: 'ready';
  /** Current memory usage in MB */
  memoryUsageMb: number;
}

/**
 * Progress update during indexing.
 */
export interface ProgressMessage {
  type: 'progress';
  /** Event type from IndexingPipeline */
  event:
    | 'document:started'
    | 'document:completed'
    | 'document:failed'
    | 'sync:completed'
    | 'indexing:progress';
  /** Event data (varies by event type) */
  data: unknown;
  /** Current memory usage in MB */
  memoryUsageMb: number;
  /** Number of documents processed so far */
  processed: number;
  /** Total documents to process */
  total: number;
}

/**
 * Sent when the current batch is complete.
 * Child process will exit after sending this message.
 */
export interface BatchCompleteMessage {
  type: 'batch_complete';
  /** Request ID from StartIndexingMessage */
  id: string;
  /** Batch statistics */
  stats: {
    /** Number of documents successfully indexed */
    processed: number;
    /** Number of documents that failed */
    failed: number;
    /** Duration in milliseconds */
    duration: number;
    /** Memory usage at completion in MB */
    memoryUsageMb: number;
  };
  /** Whether there are more items in the queue to process */
  hasMore: boolean;
}

/**
 * Error message from child process.
 */
export interface ErrorMessage {
  type: 'error';
  /** Request ID if error relates to a specific request */
  id?: string;
  /** Error message */
  error: string;
  /** Whether the error is fatal (child will exit) */
  fatal: boolean;
}

/**
 * Pong response to ping.
 */
export interface PongMessage {
  type: 'pong';
  /** Request ID from PingMessage */
  id: string;
  /** Current memory usage in MB */
  memoryUsageMb: number;
}

/**
 * Union type for all messages from child to main.
 */
export type ChildToMainMessage =
  | ReadyMessage
  | ProgressMessage
  | BatchCompleteMessage
  | ErrorMessage
  | PongMessage;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get current memory usage in megabytes.
 */
export function getMemoryUsageMb(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

/**
 * Serialize a message to JSONL format.
 */
export function serializeMessage(
  message: MainToChildMessage | ChildToMainMessage,
): string {
  return JSON.stringify(message);
}

/**
 * Parse a JSONL message.
 */
export function parseMessage(line: string): ChildToMainMessage {
  return JSON.parse(line) as ChildToMainMessage;
}
