/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Child Process Restart Strategy
// Runs SearchSystem in a child process for complete memory isolation.
// On restart, the child process is killed and a new one is spawned.

/* eslint-disable no-console */

import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import type { Interface } from 'node:readline';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RestartStrategy } from './RestartStrategy.js';
import type { SearchSystemConfig, DeepPartial } from '../../config.js';
import type { SupervisorConfig, SupervisorEvents } from '../types.js';
import { getMemoryUsageMb } from '../types.js';
import type {
  MainToChildMessage,
  ChildToMainMessage,
  PendingCall,
} from '../ipc/supervisor-ipc-types.js';
import { generateMessageId, serializeMessage } from '../ipc/supervisor-ipc-types.js';

// ============================================================================
// ChildProcessStrategy Implementation
// ============================================================================

/**
 * Child process restart strategy.
 *
 * Runs SearchSystem in a separate child process. On restart:
 * 1. Send shutdown message to child
 * 2. Wait for child to exit
 * 3. Spawn new child process
 * 4. Initialize SearchSystem in new child
 *
 * Memory recovery: 100% (OS releases all memory when process exits)
 */
export class ChildProcessStrategy implements RestartStrategy {
  readonly name = 'child-process';

  private child: ChildProcess | null = null;
  private readline: Interface | null = null;
  private stderrReader: Interface | null = null;
  private rootPath: string = '';
  private databasePath: string = '';
  private config: DeepPartial<SearchSystemConfig> = {};
  private supervisorConfig: SupervisorConfig | null = null;
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private pendingCalls: Map<string, PendingCall> = new Map();
  private ready: boolean = false;
  private lastMemoryMb: number = 0;
  private childPid: number | null = null;

  // -------------------------------------------------------------------------
  // RestartStrategy Implementation
  // -------------------------------------------------------------------------

  async initialize(
    rootPath: string,
    databasePath: string,
    config: DeepPartial<SearchSystemConfig>,
    supervisorConfig: SupervisorConfig,
  ): Promise<void> {
    this.rootPath = rootPath;
    this.databasePath = databasePath;
    this.config = config;
    this.supervisorConfig = supervisorConfig;

    // console.log('[ChildProcessStrategy] Spawning child process...');
    await this.spawnChild();
  }

  isReady(): boolean {
    return this.ready && this.child !== null && !this.child.killed;
  }

  async restart(reason: string): Promise<void> {
    // console.log(`[ChildProcessStrategy] Restarting: ${reason}`);

    this.ready = false;

    // Kill current child
    if (this.child) {
      await this.shutdownChild();
    }

    // Spawn new child
    await this.spawnChild();

    // console.log('[ChildProcessStrategy] Restart complete');
  }

  async call<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.child || !this.ready) {
      throw new Error('Child process not ready');
    }

    const id = generateMessageId();
    const timeoutMs = this.supervisorConfig?.callTimeoutMs ?? 300000;

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`Call to ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Store pending call
      const pendingCall: PendingCall = {
        id,
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
        startTime: Date.now(),
      };
      this.pendingCalls.set(id, pendingCall);

      // Send message to child
      this.send({
        type: 'supervisor_call',
        id,
        method,
        args,
      });
    });
  }

  onEvent<K extends keyof SupervisorEvents>(
    event: K,
    handler: (data: SupervisorEvents[K]) => void,
  ): () => void {
    if (!this.eventHandlers.has(event as string)) {
      this.eventHandlers.set(event as string, new Set());
    }
    this.eventHandlers.get(event as string)!.add(handler as (data: unknown) => void);

    return () => {
      const handlers = this.eventHandlers.get(event as string);
      if (handlers) {
        handlers.delete(handler as (data: unknown) => void);
      }
    };
  }

  getMemoryUsageMb(): number {
    // Return last reported memory from child, or main process memory if not available
    return this.lastMemoryMb || getMemoryUsageMb();
  }

  getChildPid(): number | null {
    return this.childPid;
  }

  async dispose(): Promise<void> {
    // console.log('[ChildProcessStrategy] Disposing...');

    this.ready = false;

    // Reject all pending calls
    for (const [id, pendingCall] of this.pendingCalls) {
      clearTimeout(pendingCall.timeout);
      pendingCall.reject(new Error('Strategy disposed'));
      this.pendingCalls.delete(id);
    }

    // Shutdown child
    if (this.child) {
      await this.shutdownChild();
    }

    this.eventHandlers.clear();
    // console.log('[ChildProcessStrategy] Disposed');
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Spawn a new child process and initialize SearchSystem in it.
   */
  private async spawnChild(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Get path to worker script
      // Handle both development (running from src/) and production (running from dist/)
      const currentDir = dirname(fileURLToPath(import.meta.url));
      let workerPath: string;

      if (currentDir.includes('src') && !currentDir.includes('dist')) {
        // Running from TypeScript source (e.g., vitest), use dist directory
        const projectRoot = currentDir.replace(/[/\\]src[/\\]supervisor[/\\]strategies$/, '');
        workerPath = join(projectRoot, 'dist', 'src', 'supervisor', 'ipc', 'supervisor-child-worker.js');
      } else {
        // Running from compiled JavaScript in dist, use relative path
        workerPath = join(currentDir, '..', 'ipc', 'supervisor-child-worker.js');
      }

      // console.log('[ChildProcessStrategy] Spawning child process', { workerPath });

      // Spawn child process
      this.child = fork(workerPath, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      });

      this.childPid = this.child.pid ?? null;
      // console.log(`[ChildProcessStrategy] Child spawned with PID: ${this.childPid}`);

      // Set up readline for JSONL parsing (stdout)
      this.readline = createInterface({
        input: this.child.stdout!,
        crlfDelay: Infinity,
      });

      // Set up readline for stderr (child logs in JSONL format)
      this.stderrReader = createInterface({
        input: this.child.stderr!,
        crlfDelay: Infinity,
      });

      // Handle child stderr logs - only forward errors
      this.stderrReader.on('line', (line) => {
        try {
          const logEntry = JSON.parse(line);
          if (logEntry.level === 'error') {
            console.error(`[Child:${logEntry.level}] ${logEntry.message}`, logEntry.data);
          }
          // Suppress info/debug/warn logs from child
        } catch {
          // Suppress non-JSON stderr output
        }
      });

      // Set up timeouts
      const startupTimeout = setTimeout(() => {
        reject(new Error(`Child process startup timed out after ${this.supervisorConfig?.startupTimeoutMs ?? 120000}ms`));
        this.cleanup();
      }, this.supervisorConfig?.startupTimeoutMs ?? 120000);

      let initSent = false;

      // Handle messages from child
      this.readline.on('line', (line) => {
        try {
          const msg: ChildToMainMessage = JSON.parse(line);
          this.handleChildMessage(msg, {
            onReady: () => {
              if (!initSent) {
                // Child is ready for init command
                initSent = true;
                this.send({
                  type: 'supervisor_init',
                  id: generateMessageId(),
                  rootPath: this.rootPath,
                  databasePath: this.databasePath,
                  config: this.config,
                });
              } else {
                // Init complete, child is fully ready
                clearTimeout(startupTimeout);
                this.ready = true;
                resolve();
              }
            },
            onError: (error, fatal) => {
              if (fatal && !this.ready) {
                clearTimeout(startupTimeout);
                reject(new Error(error));
              }
            },
          });
        } catch {
          // Ignore non-JSON lines (e.g., stray log output)
        }
      });

      // Handle child exit
      this.child.on('exit', (code, signal) => {
        // console.log(`[ChildProcessStrategy] Child exited with code ${code}, signal ${signal}`);
        this.cleanup();

        if (!this.ready) {
          clearTimeout(startupTimeout);
          reject(new Error(`Child process exited unexpectedly with code ${code}`));
        }
      });

      // Handle child error
      this.child.on('error', (error) => {
        console.error('[ChildProcessStrategy] Child process error:', error);
        clearTimeout(startupTimeout);
        reject(error);
      });
    });
  }

  /**
   * Handle a message from the child process.
   */
  private handleChildMessage(
    msg: ChildToMainMessage,
    callbacks: {
      onReady: () => void;
      onError: (error: string, fatal: boolean) => void;
    },
  ): void {
    switch (msg.type) {
      case 'supervisor_ready':
        this.lastMemoryMb = msg.memoryUsageMb;
        callbacks.onReady();
        break;

      case 'supervisor_result': {
        const pendingCall = this.pendingCalls.get(msg.id);
        if (pendingCall) {
          clearTimeout(pendingCall.timeout);
          this.pendingCalls.delete(msg.id);
          if (msg.success) {
            pendingCall.resolve(msg.result);
          } else {
            pendingCall.reject(new Error(msg.error ?? 'Unknown error'));
          }
        }
        break;
      }

      case 'supervisor_event':
        this.forwardEvent(msg.event, msg.data);
        break;

      case 'supervisor_memory':
        this.lastMemoryMb = msg.memoryUsageMb;
        break;

      case 'supervisor_error':
        console.error(`[ChildProcessStrategy] Child error: ${msg.error} (fatal: ${msg.fatal})`);
        callbacks.onError(msg.error, msg.fatal);
        break;

      case 'supervisor_pong':
        this.lastMemoryMb = msg.memoryUsageMb;
        break;

      case 'supervisor_shutting_down':
        // console.log('[ChildProcessStrategy] Child acknowledged shutdown');
        break;

      default:
        // console.warn('[ChildProcessStrategy] Unknown message type:', (msg as Record<string, unknown>).type);
    }
  }

  /**
   * Forward an event from the child to registered handlers.
   */
  private forwardEvent(event: string, data: unknown): void {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (error) {
          console.error(`[ChildProcessStrategy] Error in event handler for ${event}:`, error);
        }
      }
    }
  }

  /**
   * Send a message to the child process.
   */
  private send(msg: MainToChildMessage): void {
    if (this.child?.stdin && !this.child.killed) {
      this.child.stdin.write(serializeMessage(msg) + '\n');
    }
  }

  /**
   * Shutdown the child process gracefully.
   */
  private async shutdownChild(): Promise<void> {
    const child = this.child;
    if (!child) return;

    const shutdownTimeout = this.supervisorConfig?.shutdownTimeoutMs ?? 30000;

    return new Promise<void>((resolve) => {
      // Send shutdown message
      const id = generateMessageId();
      this.send({
        type: 'supervisor_shutdown',
        id,
      });

      // Wait for child to exit with timeout
      const timeout = setTimeout(() => {
        // console.warn('[ChildProcessStrategy] Shutdown timeout, force killing child');
        if (!child.killed) {
          child.kill('SIGKILL');
        }
        resolve();
      }, shutdownTimeout);

      child.once('exit', () => {
        clearTimeout(timeout);
        this.cleanup();
        resolve();
      });
    });
  }

  /**
   * Cleanup child process resources.
   */
  private cleanup(): void {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.stderrReader) {
      this.stderrReader.close();
      this.stderrReader = null;
    }

    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    this.childPid = null;
    this.ready = false;
  }
}
