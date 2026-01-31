/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Supervisor Strategies Exports

export type { RestartStrategy, RestartStrategyFactory } from './RestartStrategy.js';
export { InProcessStrategy } from './InProcessStrategy.js';
export { ChildProcessStrategy } from './ChildProcessStrategy.js';
