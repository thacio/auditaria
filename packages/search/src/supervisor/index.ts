/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: SearchSystem Supervisor Module
// Provides automatic memory management through periodic restarts.

// Main supervisor class
export {
  SearchSystemSupervisor,
  createSearchSystemSupervisor,
} from './SearchSystemSupervisor.js';

// Types
export type {
  SupervisorConfig,
  SupervisorState,
  SupervisorStatus,
  SupervisorEvents,
  IndexAllResult,
  IndexAllOptions,
  SupervisorInitOptions,
} from './types.js';

export {
  DEFAULT_SUPERVISOR_CONFIG,
  INITIAL_SUPERVISOR_STATE,
  getMemoryUsageMb,
  createSupervisorConfig,
} from './types.js';

// Strategies (for advanced use cases)
export type { RestartStrategy } from './strategies/index.js';
export { InProcessStrategy, ChildProcessStrategy } from './strategies/index.js';
