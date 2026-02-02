/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Restart Strategy Interface
// Defines the contract for different restart strategies (in-process, child-process).

import type { SearchSystemConfig, DeepPartial } from '../../config.js';
import type { SupervisorConfig, SupervisorEvents } from '../types.js';

// ============================================================================
// Restart Strategy Interface
// ============================================================================

/**
 * Interface for restart strategies.
 *
 * Both InProcessStrategy and ChildProcessStrategy implement this interface,
 * allowing the supervisor to switch between them without changing its logic.
 */
export interface RestartStrategy {
  /**
   * Strategy name for logging and debugging.
   */
  readonly name: string;

  /**
   * Initialize the strategy with the given configuration.
   *
   * @param rootPath - Root path for file indexing
   * @param databasePath - Path to the database file
   * @param config - SearchSystem configuration
   * @param supervisorConfig - Supervisor-specific configuration
   */
  initialize(
    rootPath: string,
    databasePath: string,
    config: DeepPartial<SearchSystemConfig>,
    supervisorConfig: SupervisorConfig,
  ): Promise<void>;

  /**
   * Check if the strategy is initialized and ready for operations.
   */
  isReady(): boolean;

  /**
   * Perform a restart of the SearchSystem.
   *
   * For in-process: Close current SearchSystem, run GC, reinitialize.
   * For child-process: Send shutdown message, wait for exit, spawn new child.
   *
   * @param reason - Human-readable reason for the restart (for logging)
   */
  restart(reason: string): Promise<void>;

  /**
   * Call a method on the SearchSystem.
   *
   * For in-process: Direct method call.
   * For child-process: IPC message with response.
   *
   * @param method - Method name to call
   * @param args - Arguments to pass to the method
   * @returns The result of the method call
   */
  call<T>(method: string, args: unknown[]): Promise<T>;

  /**
   * Subscribe to SearchSystem events.
   *
   * @param event - Event name
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  onEvent<K extends keyof SupervisorEvents>(
    event: K,
    handler: (data: SupervisorEvents[K]) => void,
  ): () => void;

  /**
   * Get current memory usage in MB.
   *
   * For in-process: Current process memory.
   * For child-process: Child process memory (from last report).
   */
  getMemoryUsageMb(): number;

  /**
   * Get child process PID (only for child-process strategy).
   *
   * @returns PID or null if not applicable
   */
  getChildPid(): number | null;

  /**
   * Gracefully dispose of all resources.
   *
   * For in-process: Close SearchSystem.
   * For child-process: Send shutdown, wait for exit, cleanup.
   */
  dispose(): Promise<void>;
}

// ============================================================================
// Strategy Factory Type
// ============================================================================

/**
 * Factory function type for creating restart strategies.
 */
export type RestartStrategyFactory = () => RestartStrategy;
