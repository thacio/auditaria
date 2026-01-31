/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Supervisor Child Worker
// Entry point for child process that runs the full SearchSystem.
// Receives commands via stdin (JSONL), sends responses via stdout.

/* eslint-disable no-console */

import { createInterface } from 'node:readline';
import { SearchSystem } from '../../core/SearchSystem.js';
import { globalLogger, LogLevel } from '../../core/Logger.js';
import type {
  MainToChildMessage,
  ChildToMainMessage,
  SupervisorInitMessage,
  SupervisorCallMessage,
} from './supervisor-ipc-types.js';
import {
  getMemoryUsageMb,
  getDetailedMemoryUsage,
  serializeMessage,
} from './supervisor-ipc-types.js';

// ============================================================================
// Redirect console to stderr (CRITICAL for IPC)
// ============================================================================

// Save original stdout for our IPC messages
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

// Redirect console.log/info/warn/error to stderr so they don't corrupt IPC
const originalConsoleLog = console.log;
const originalConsoleInfo = console.info;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

console.log = (...args: unknown[]) => {
  process.stderr.write(args.map(String).join(' ') + '\n');
};
console.info = console.log;
console.warn = (...args: unknown[]) => {
  process.stderr.write('[WARN] ' + args.map(String).join(' ') + '\n');
};
console.error = (...args: unknown[]) => {
  process.stderr.write('[ERROR] ' + args.map(String).join(' ') + '\n');
};

// ============================================================================
// Global State
// ============================================================================

let searchSystem: SearchSystem | null = null;
let isShuttingDown = false;
let isInitialized = false;

// ============================================================================
// IPC Communication
// ============================================================================

/**
 * Send a message to the main process via stdout.
 */
function send(msg: ChildToMainMessage): void {
  if (process.stdout.writable) {
    process.stdout.write(serializeMessage(msg) + '\n');
  }
}

/**
 * Log to stderr (won't interfere with IPC on stdout).
 */
function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  data?: Record<string, unknown>,
): void {
  // Only log errors to stderr - suppress debug/info/warn noise
  if (level !== 'error') return;

  const logEntry = {
    level,
    message,
    data,
    timestamp: new Date().toISOString(),
    memoryMb: getMemoryUsageMb(),
  };
  process.stderr.write(JSON.stringify(logEntry) + '\n');
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Handle supervisor_init message.
 */
async function handleInit(msg: SupervisorInitMessage): Promise<void> {
  if (isInitialized) {
    send({
      type: 'supervisor_error',
      id: msg.id,
      error: 'Already initialized',
      fatal: false,
    });
    return;
  }

  log('info', 'Initializing SearchSystem', {
    rootPath: msg.rootPath,
    databasePath: msg.databasePath,
  });

  try {
    // Configure logging to stderr only (don't interfere with IPC)
    globalLogger.configure({
      level: LogLevel.DEBUG,
      console: false, // No console - we use our own logging to stderr
    });

    // Initialize SearchSystem
    searchSystem = await SearchSystem.initialize({
      rootPath: msg.rootPath,
      config: msg.config,
    });

    // Subscribe to all events and forward them
    subscribeToEvents();

    isInitialized = true;

    send({
      type: 'supervisor_ready',
      memoryUsageMb: getMemoryUsageMb(),
    });

    log('info', 'SearchSystem initialized', { memoryMb: getMemoryUsageMb() });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to initialize SearchSystem', { error: errorMsg });
    send({
      type: 'supervisor_error',
      id: msg.id,
      error: errorMsg,
      fatal: true,
    });
    // Exit with error code
    await shutdown(1);
  }
}

/**
 * Handle supervisor_call message.
 */
async function handleCall(msg: SupervisorCallMessage): Promise<void> {
  if (!searchSystem || !isInitialized) {
    send({
      type: 'supervisor_result',
      id: msg.id,
      success: false,
      error: 'SearchSystem not initialized',
    });
    return;
  }

  log('debug', `Calling method: ${msg.method}`, { args: msg.args.length });

  try {
    // Get the method from SearchSystem
    const fn = (searchSystem as unknown as Record<string, unknown>)[msg.method];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown method: ${msg.method}`);
    }

    // Call the method
    const result = await fn.apply(searchSystem, msg.args);

    send({
      type: 'supervisor_result',
      id: msg.id,
      success: true,
      result,
    });

    log('debug', `Method ${msg.method} completed`, { memoryMb: getMemoryUsageMb() });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log('error', `Method ${msg.method} failed`, { error: errorMsg });
    send({
      type: 'supervisor_result',
      id: msg.id,
      success: false,
      error: errorMsg,
    });
  }
}

/**
 * Handle supervisor_shutdown message.
 */
async function handleShutdown(id: string): Promise<void> {
  if (isShuttingDown) {
    return;
  }

  log('info', 'Shutdown requested');
  send({
    type: 'supervisor_shutting_down',
    id,
  });

  await shutdown(0);
}

/**
 * Handle supervisor_ping message.
 */
function handlePing(id: string): void {
  send({
    type: 'supervisor_pong',
    id,
    memoryUsageMb: getMemoryUsageMb(),
  });
}

// ============================================================================
// Event Forwarding
// ============================================================================

/**
 * Subscribe to all SearchSystem events and forward to main process.
 */
function subscribeToEvents(): void {
  if (!searchSystem) return;

  const events = [
    'search:started',
    'search:completed',
    'indexing:started',
    'indexing:progress',
    'indexing:completed',
    'ocr:started',
    'ocr:progress',
    'ocr:completed',
    'ocr:failed',
  ];

  for (const event of events) {
    searchSystem.on(event as keyof typeof searchSystem extends never ? never : string, (data: unknown) => {
      send({
        type: 'supervisor_event',
        event,
        data,
      });
    });
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

/**
 * Graceful shutdown.
 */
async function shutdown(exitCode: number): Promise<void> {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;

  log('info', 'Shutting down', { exitCode });

  // Close SearchSystem
  if (searchSystem) {
    try {
      log('info', 'Closing SearchSystem');
      await Promise.race([
        searchSystem.close(),
        new Promise((resolve) => setTimeout(resolve, 30000)), // 30s timeout
      ]);
      log('info', 'SearchSystem closed');
    } catch (error) {
      log('error', 'Error closing SearchSystem', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    searchSystem = null;
  }

  // Close readline
  if (readline) {
    readline.close();
  }

  // Final memory report
  const memory = getDetailedMemoryUsage();
  log('info', 'Final memory state', memory);

  // Exit after a short delay to ensure messages are sent
  setTimeout(() => {
    process.exit(exitCode);
  }, 100);
}

/**
 * Send periodic memory reports.
 */
function startMemoryReporting(): void {
  const REPORT_INTERVAL = 30000; // 30 seconds

  setInterval(() => {
    if (!isShuttingDown) {
      const memory = getDetailedMemoryUsage();
      send({
        type: 'supervisor_memory',
        memoryUsageMb: memory.heapUsedMb,
        heapUsedMb: memory.heapUsedMb,
        heapTotalMb: memory.heapTotalMb,
      });
    }
  }, REPORT_INTERVAL);
}

// ============================================================================
// Main Entry Point
// ============================================================================

let readline: ReturnType<typeof createInterface> | null = null;

/**
 * Main function - sets up IPC and message handling.
 */
async function main(): Promise<void> {
  log('info', 'Supervisor child worker starting', {
    pid: process.pid,
    nodeVersion: process.version,
    memoryMb: getMemoryUsageMb(),
  });

  // Set up readline for JSONL parsing
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
        case 'supervisor_init':
          await handleInit(msg);
          break;

        case 'supervisor_call':
          await handleCall(msg);
          break;

        case 'supervisor_shutdown':
          await handleShutdown(msg.id);
          break;

        case 'supervisor_ping':
          handlePing(msg.id);
          break;

        default:
          log('warn', 'Unknown message type', { type: (msg as Record<string, unknown>).type });
      }
    } catch (error) {
      log('error', 'Failed to parse message', {
        error: error instanceof Error ? error.message : String(error),
        line: line.substring(0, 100),
      });
    }
  });

  // Handle stdin close (parent process exited)
  readline.on('close', async () => {
    if (!isShuttingDown) {
      log('info', 'stdin closed, shutting down');
      await shutdown(0);
    }
  });

  // Handle process signals
  process.on('SIGTERM', async () => {
    log('info', 'Received SIGTERM');
    await shutdown(0);
  });

  process.on('SIGINT', async () => {
    log('info', 'Received SIGINT');
    await shutdown(0);
  });

  // Handle uncaught errors
  process.on('uncaughtException', async (error) => {
    log('error', 'Uncaught exception', {
      error: error.message,
      stack: error.stack,
    });
    send({
      type: 'supervisor_error',
      error: `Uncaught exception: ${error.message}`,
      fatal: true,
    });
    await shutdown(1);
  });

  process.on('unhandledRejection', async (reason) => {
    const error = reason instanceof Error ? reason.message : String(reason);
    log('error', 'Unhandled rejection', { error });
    send({
      type: 'supervisor_error',
      error: `Unhandled rejection: ${error}`,
      fatal: true,
    });
    await shutdown(1);
  });

  // Start memory reporting
  startMemoryReporting();

  log('info', 'Supervisor child worker ready for commands');

  // Signal to parent that we're ready to receive commands (especially supervisor_init)
  send({
    type: 'supervisor_ready',
    memoryUsageMb: getMemoryUsageMb(),
  });
}

// Run main
main().catch(async (error) => {
  log('error', 'Failed to start supervisor child worker', {
    error: error instanceof Error ? error.message : String(error),
  });
  await shutdown(1);
});
