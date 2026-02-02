/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Supervisor IPC Exports

export type {
  MainToChildMessage,
  ChildToMainMessage,
  SupervisorInitMessage,
  SupervisorCallMessage,
  SupervisorShutdownMessage,
  SupervisorPingMessage,
  SupervisorReadyMessage,
  SupervisorResultMessage,
  SupervisorEventMessage,
  SupervisorMemoryMessage,
  SupervisorErrorMessage,
  SupervisorPongMessage,
  SupervisorShuttingDownMessage,
  PendingCall,
} from './supervisor-ipc-types.js';

export {
  getMemoryUsageMb,
  getDetailedMemoryUsage,
  serializeMessage,
  parseMessage,
  generateMessageId,
  createPendingCall,
} from './supervisor-ipc-types.js';
