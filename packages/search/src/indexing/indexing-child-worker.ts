/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * @license
 */

/**
 * Child process entry point for indexing.
 *
 * This script runs in a separate child process to handle indexing operations.
 * When the child process exits, all its memory (including WASM heaps) is
 * completely released by the OS, solving the fundamental WASM memory limitation
 * (WASM memory can only grow, never shrink).
 *
 * Communication with the main process uses JSONL protocol over stdin/stdout.
 */

import type { Interface } from 'node:readline';
import { createInterface } from 'node:readline';
import type {
  MainToChildMessage,
  ChildToMainMessage,
  StartIndexingMessage,
} from './child-process-types.js';
import { getMemoryUsageMb, serializeMessage } from './child-process-types.js';

// Import SearchSystem type for typing (actual import is dynamic)
import type { SearchSystem } from '../core/SearchSystem.js';

// ============================================================================
// Global State
// ============================================================================

let readline: Interface | null = null;
let isShuttingDown = false;
/** Active SearchSystem instance (needed for graceful shutdown) */
let activeSearchSystem: SearchSystem | null = null;

// ============================================================================
// IPC Communication
// ============================================================================

/**
 * Send a message to the main process via stdout.
 */
function send(message: ChildToMainMessage): void {
  if (!isShuttingDown) {
    // eslint-disable-next-line no-console -- stdout is IPC channel to parent
    console.log(serializeMessage(message));
  }
}

/**
 * Log to stderr (doesn't interfere with IPC).
 */
function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
): void {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({
    timestamp,
    level,
    process: 'indexing-child',
    message,
    data,
  });
  process.stderr.write(logLine + '\n');
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Perform graceful shutdown of all resources.
 *
 * This is used when indexing has COMPLETED naturally (success or error in
 * handleStartIndexing). For forced shutdowns (shutdown command, signals, stdin
 * close), use tryQuickClose() which has a shorter timeout.
 */
async function gracefulShutdown(reason: string): Promise<void> {
  if (isShuttingDown) {
    return; // Already shutting down
  }

  isShuttingDown = true;
  log('info', 'Graceful shutdown started', { reason });

  // Close readline first to stop receiving new messages
  if (readline) {
    readline.close();
    readline = null;
  }

  // Close SearchSystem if active (this properly disposes WASM, workers, etc.)
  if (activeSearchSystem) {
    log('info', 'Closing SearchSystem...');
    try {
      await activeSearchSystem.close();
      log('info', 'SearchSystem closed successfully');
    } catch (error) {
      log('warn', 'Error closing SearchSystem', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    activeSearchSystem = null;
  }

  // Small delay to ensure all async cleanup finishes
  await new Promise((resolve) => setTimeout(resolve, 100));

  log('info', 'Graceful shutdown complete');
}

/**
 * Attempt a quick close with a short timeout.
 * Used for forced shutdown scenarios (signals, stdin close).
 * If close hangs or fails, we just exit - OS will release memory.
 */
async function tryQuickClose(): Promise<void> {
  if (!activeSearchSystem) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return;
  }

  const closeTimeout = 2000; // 2 seconds max for forced scenarios
  let closeCompleted = false;

  const closePromise = (async () => {
    try {
      await activeSearchSystem.close();
      closeCompleted = true;
      log('info', 'Quick close successful');
    } catch (error) {
      log('warn', 'Quick close error (ignoring)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!closeCompleted) {
        log('warn', 'Quick close timed out, forcing exit');
      }
      resolve();
    }, closeTimeout);
  });

  await Promise.race([closePromise, timeoutPromise]);
  activeSearchSystem = null;
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Handle start_indexing command from main process.
 */
async function handleStartIndexing(msg: StartIndexingMessage): Promise<void> {
  const startTime = Date.now();
  let processed = 0;
  let _failed = 0; // Tracked but not used in messages (result.failed is used instead)

  log('info', 'Starting indexing', {
    rootPath: msg.rootPath,
    databasePath: msg.databasePath,
    force: msg.options.force,
    maxDocuments: msg.options.maxDocuments,
  });

  try {
    // Dynamic import to avoid loading heavy modules until needed
    const { SearchSystem } = await import('../core/SearchSystem.js');

    // Initialize search system
    const searchSystem = await SearchSystem.initialize({
      rootPath: msg.rootPath,
      config: msg.config,
    });

    // Store reference for graceful shutdown
    activeSearchSystem = searchSystem;

    log('info', 'SearchSystem initialized', { memoryMb: getMemoryUsageMb() });

    // Check if shutdown was requested while we were initializing
    if (isShuttingDown) {
      log('info', 'Shutdown requested during initialization, aborting');
      await gracefulShutdown('shutdown during init');
      process.exit(0);
      return;
    }

    // Subscribe to progress events and forward to main process
    searchSystem.on('document:completed', (event) => {
      processed++;
      send({
        type: 'progress',
        event: 'document:completed',
        data: event,
        memoryUsageMb: getMemoryUsageMb(),
        processed,
        total: msg.options.maxDocuments ?? 0,
      });
    });

    searchSystem.on('document:failed', (event) => {
      _failed++;
      send({
        type: 'progress',
        event: 'document:failed',
        data: event,
        memoryUsageMb: getMemoryUsageMb(),
        processed,
        total: msg.options.maxDocuments ?? 0,
      });
    });

    // Run indexing with in-process mode (we're already in the child)
    const result = await searchSystem.indexAll({
      force: msg.options.force,
      useChildProcess: false, // Don't spawn another child!
      maxDocuments: msg.options.maxDocuments,
    });

    // Check if there are more items to process
    const queueStatus = await searchSystem.getQueueStatus();
    const hasMore = queueStatus.pending > 0;

    const duration = Date.now() - startTime;
    log('info', 'Indexing complete', {
      processed: result.indexed,
      failed: result.failed,
      duration,
      hasMore,
      memoryMb: getMemoryUsageMb(),
    });

    // Report completion BEFORE close to ensure message is sent
    send({
      type: 'batch_complete',
      id: msg.id,
      stats: {
        processed: result.indexed,
        failed: result.failed,
        duration,
        memoryUsageMb: getMemoryUsageMb(),
      },
      hasMore,
    });

    // Graceful shutdown (closes SearchSystem properly)
    await gracefulShutdown('indexing complete');

    // Exit cleanly - this releases all WASM memory!
    process.exit(0);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', 'Indexing failed', { error: errorMessage });

    send({
      type: 'error',
      id: msg.id,
      error: errorMessage,
      fatal: true,
    });

    // Still try to cleanup gracefully
    await gracefulShutdown('indexing error');
    process.exit(1);
  }
}

/**
 * Handle shutdown command from main process.
 *
 * We attempt to close SearchSystem with a timeout to ensure database integrity,
 * but if it hangs or crashes, we force exit. The OS will release memory anyway.
 */
async function handleShutdown(id: string): Promise<void> {
  log('info', 'Shutdown requested', { id });

  // Set flag to stop accepting new messages
  isShuttingDown = true;

  // Close readline to stop receiving messages
  if (readline) {
    readline.close();
    readline = null;
  }

  // Try to close SearchSystem with a timeout for database integrity
  if (activeSearchSystem) {
    log('info', 'Attempting SearchSystem close with timeout...');

    const closeTimeout = 3000; // 3 seconds max
    let closeCompleted = false;

    const closePromise = (async () => {
      try {
        await activeSearchSystem.close();
        closeCompleted = true;
        log('info', 'SearchSystem closed successfully');
      } catch (error) {
        log('warn', 'Error during SearchSystem close', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!closeCompleted) {
          log('warn', 'SearchSystem close timed out, forcing exit');
        }
        resolve();
      }, closeTimeout);
    });

    // Wait for close or timeout, whichever comes first
    await Promise.race([closePromise, timeoutPromise]);
    activeSearchSystem = null;
  }

  // Small delay to flush logs
  await new Promise((resolve) => setTimeout(resolve, 50));

  process.exit(0);
}

/**
 * Handle ping command (health check).
 */
function handlePing(id: string): void {
  send({
    type: 'pong',
    id,
    memoryUsageMb: getMemoryUsageMb(),
  });
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  log('info', 'Child process started', {
    pid: process.pid,
    memoryMb: getMemoryUsageMb(),
  });

  // Set up readline for IPC
  readline = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Handle incoming messages
  readline.on('line', async (line) => {
    if (isShuttingDown) return;

    try {
      const msg: MainToChildMessage = JSON.parse(line);

      switch (msg.type) {
        case 'start_indexing':
          await handleStartIndexing(msg);
          break;
        case 'shutdown':
          await handleShutdown(msg.id);
          break;
        case 'ping':
          handlePing(msg.id);
          break;
        default:
          log('warn', 'Unknown message type', { msg });
      }
    } catch (error) {
      log('error', 'Failed to parse message', {
        error: error instanceof Error ? error.message : String(error),
        line,
      });

      send({
        type: 'error',
        error: `Failed to parse message: ${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      });
    }
  });

  // Handle readline close (parent closed stdin)
  readline.on('close', async () => {
    if (!isShuttingDown) {
      isShuttingDown = true;
      log('info', 'Stdin closed, attempting quick close...');
      await tryQuickClose();
      process.exit(0);
    }
  });

  // Handle process signals
  process.on('SIGTERM', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'SIGTERM received, attempting quick close...');
    await tryQuickClose();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'SIGINT received, attempting quick close...');
    await tryQuickClose();
    process.exit(0);
  });

  // Signal ready to main process
  send({
    type: 'ready',
    memoryUsageMb: getMemoryUsageMb(),
  });
}

// Run main
main().catch(async (error) => {
  log('error', 'Uncaught error in main', {
    error: error instanceof Error ? error.message : String(error),
  });
  isShuttingDown = true;
  await tryQuickClose();
  process.exit(1);
});
