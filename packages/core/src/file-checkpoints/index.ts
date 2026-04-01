/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: This entire file is part of the file checkpoints implementation

export { FileCheckpointManager } from './FileCheckpointManager.js';
export { ClaudeFileCheckpointAdapter } from './adapters/ClaudeFileCheckpointAdapter.js';
export type {
  FileCheckpointAdapter,
  FileCheckpointBackup,
  FileCheckpointSnapshot,
  FileCheckpointState,
  FileCheckpointDiffStats,
  TurnEndData,
} from './types.js';
