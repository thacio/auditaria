/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: This entire file is part of the file checkpoints implementation

/**
 * A backup record for a single file at a specific version.
 * backupFileName is null when the file didn't exist at that point.
 */
export interface FileCheckpointBackup {
  backupFileName: string | null;
  version: number;
  backupTime: number; // epoch ms
}

/**
 * A snapshot capturing the state of all tracked files at a specific turn boundary.
 */
export interface FileCheckpointSnapshot {
  provider: string;
  trackedFileBackups: Record<string, FileCheckpointBackup>;
  timestamp: number; // epoch ms — used for correlation with conversation messages
}

/**
 * Runtime state for the file checkpoint system.
 */
export interface FileCheckpointState {
  snapshots: FileCheckpointSnapshot[];
  trackedFiles: Set<string>;
  snapshotSequence: number;
}

/**
 * Diff stats for the rewind UI.
 */
export interface FileCheckpointDiffStats {
  filesChanged: string[];
  fileCount: number;
  insertions: number;
  deletions: number;
}

/**
 * Data passed to the adapter after a turn completes.
 */
export interface TurnEndData {
  provider: string;
  timestamp: number;
}

/**
 * Provider-specific adapter that knows how to discover file changes
 * and create backups from external provider data.
 */
export interface FileCheckpointAdapter {
  readonly provider: string;

  /**
   * Called after an external provider turn completes.
   * The adapter should discover which files were changed, copy backups
   * into the checkpoint directory, and return the backup records.
   *
   * Returns null if no file changes were detected.
   */
  onAfterTurn(
    checkpointDir: string,
    turnData: TurnEndData,
  ): Promise<Record<string, FileCheckpointBackup> | null>;

  /**
   * Called when the adapter is no longer needed.
   */
  dispose(): void;
}

export const MAX_SNAPSHOTS = 100;
export const MAX_BACKUP_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const SNAPSHOTS_LOG_FILENAME = 'snapshots.jsonl';
