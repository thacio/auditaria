/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: In-Process Restart Strategy
// Manages SearchSystem lifecycle within the same process.
// Restart involves close() -> GC -> setTimeout -> initialize().

/* eslint-disable no-console */

import type { RestartStrategy } from './RestartStrategy.js';
import type { SearchSystemConfig, DeepPartial } from '../../config.js';
import type { SupervisorConfig, SupervisorEvents } from '../types.js';
import { getMemoryUsageMb } from '../types.js';
import { SearchSystem } from '../../core/SearchSystem.js';
import { globalLogger, LogLevel } from '../../core/Logger.js';

// ============================================================================
// InProcessStrategy Implementation
// ============================================================================

/**
 * In-process restart strategy.
 *
 * Manages SearchSystem in the same process. On restart:
 * 1. Close current SearchSystem (disposes all resources)
 * 2. Trigger garbage collection if available (--expose-gc flag)
 * 3. Wait for event loop to clear
 * 4. Reinitialize SearchSystem from disk
 *
 * Memory recovery: ~60-80% (JS objects freed, WASM may not fully release)
 */
export class InProcessStrategy implements RestartStrategy {
  readonly name = 'in-process';

  private searchSystem: SearchSystem | null = null;
  private rootPath: string = '';
  private databasePath: string = '';
  private config: DeepPartial<SearchSystemConfig> = {};
  private supervisorConfig: SupervisorConfig | null = null;
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private eventUnsubscribers: Array<() => void> = [];
  private ready: boolean = false;

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

    // Configure globalLogger to reduce console noise
    // Only show warnings and errors, suppress verbose debug/info logs
    // File logging at debug level is still available if DEBUG=auditaria:search is set
    globalLogger.configure({
      level: LogLevel.WARN, // Only warnings and errors in console
      console: true,
    });

    // Initialize SearchSystem
    this.searchSystem = await SearchSystem.initialize({
      rootPath: this.rootPath,
      config: this.config,
    });

    // Subscribe to all SearchSystem events and forward them
    this.subscribeToEvents();

    this.ready = true;
    // console.log(`[InProcessStrategy] Ready (memory: ${getMemoryUsageMb()}MB)`);
  }

  isReady(): boolean {
    return this.ready && this.searchSystem !== null;
  }

  async restart(reason: string): Promise<void> {
    if (!this.searchSystem) {
      throw new Error('Cannot restart: SearchSystem not initialized');
    }

    const memoryBefore = getMemoryUsageMb();
    // console.log(`[InProcessStrategy] Restarting: ${reason} (memory: ${memoryBefore}MB)`);

    this.ready = false;

    // 1. Unsubscribe from current SearchSystem events
    this.unsubscribeFromEvents();

    // 2. Close current SearchSystem
    // console.log('[InProcessStrategy] Closing SearchSystem...');
    try {
      await this.searchSystem.close();
    } catch (error) {
      console.warn(
        '[InProcessStrategy] Error closing SearchSystem:',
        error instanceof Error ? error.message : String(error),
      );
    }
    this.searchSystem = null;

    // 3. Trigger garbage collection if available
    this.forceGarbageCollection();

    // 4. Wait for event loop to clear
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 5. Reinitialize SearchSystem
    // console.log('[InProcessStrategy] Reinitializing SearchSystem...');
    this.searchSystem = await SearchSystem.initialize({
      rootPath: this.rootPath,
      config: this.config,
    });

    // 6. Resubscribe to events
    this.subscribeToEvents();

    this.ready = true;

    // const memoryAfter = getMemoryUsageMb();
    // const memoryFreed = memoryBefore - memoryAfter;
    // console.log(`[InProcessStrategy] Restart complete (memory: ${memoryAfter}MB, freed: ${memoryFreed}MB)`);
  }

  async call<T>(method: string, args: unknown[]): Promise<T> {
    if (!this.searchSystem) {
      throw new Error('SearchSystem not initialized');
    }

    // Get the method from SearchSystem
    const fn = (this.searchSystem as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      throw new Error(`Unknown method: ${method}`);
    }

    // Call the method
    return fn.apply(this.searchSystem, args) as T;
  }

  onEvent<K extends keyof SupervisorEvents>(
    event: K,
    handler: (data: SupervisorEvents[K]) => void,
  ): () => void {
    // Store handler for resubscription after restart
    if (!this.eventHandlers.has(event as string)) {
      this.eventHandlers.set(event as string, new Set());
    }
    this.eventHandlers.get(event as string)!.add(handler as (data: unknown) => void);

    // Return unsubscribe function
    return () => {
      const handlers = this.eventHandlers.get(event as string);
      if (handlers) {
        handlers.delete(handler as (data: unknown) => void);
      }
    };
  }

  getMemoryUsageMb(): number {
    return getMemoryUsageMb();
  }

  getChildPid(): number | null {
    // In-process strategy doesn't use child processes
    return null;
  }

  async dispose(): Promise<void> {
    // console.log('[InProcessStrategy] Disposing...');

    this.ready = false;
    this.unsubscribeFromEvents();

    if (this.searchSystem) {
      try {
        await this.searchSystem.close();
      } catch (error) {
        console.warn(
          '[InProcessStrategy] Error closing SearchSystem:',
          error instanceof Error ? error.message : String(error),
        );
      }
      this.searchSystem = null;
    }

    this.eventHandlers.clear();
    // console.log('[InProcessStrategy] Disposed');
  }

  // -------------------------------------------------------------------------
  // Private Methods
  // -------------------------------------------------------------------------

  /**
   * Subscribe to all SearchSystem events and forward to registered handlers.
   */
  private subscribeToEvents(): void {
    if (!this.searchSystem) return;

    // List of events to forward from SearchSystem
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
      const unsub = this.searchSystem.on(event as keyof typeof this.searchSystem extends never ? never : string, (data: unknown) => {
        // Forward to all registered handlers
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(data);
            } catch (error) {
              console.error(
                `[InProcessStrategy] Error in event handler for ${event}:`,
                error,
              );
            }
          }
        }
      });
      this.eventUnsubscribers.push(unsub);
    }
  }

  /**
   * Unsubscribe from all SearchSystem events.
   */
  private unsubscribeFromEvents(): void {
    for (const unsub of this.eventUnsubscribers) {
      try {
        unsub();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.eventUnsubscribers = [];
  }

  /**
   * Attempt to trigger garbage collection.
   * Requires Node.js to be started with --expose-gc flag.
   */
  private forceGarbageCollection(): void {
    if (typeof global.gc === 'function') {
      global.gc();
    }
    // GC not exposed warning removed - not useful in production
  }
}
