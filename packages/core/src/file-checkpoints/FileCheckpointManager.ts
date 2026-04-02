/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: This entire file is part of the file checkpoints implementation

import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import {
  copyFile,
  mkdir,
  stat,
  unlink,
  writeFile,
  appendFile,
  readFile,
} from 'node:fs/promises';
import { diffLines } from 'diff';

const DEBUG = false;
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[FILE_CHECKPOINT]', ...args); // eslint-disable-line no-console
}
import type {
  FileCheckpointAdapter,
  FileCheckpointBackup,
  FileCheckpointSnapshot,
  FileCheckpointState,
  FileCheckpointDiffStats,
  TurnEndData,
} from './types.js';
import {
  MAX_SNAPSHOTS,
  MAX_BACKUP_FILE_SIZE,
  SNAPSHOTS_LOG_FILENAME,
} from './types.js';

function isENOENT(e: unknown): boolean {
  if (!(e instanceof Error) || !('code' in e)) return false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Node.js error with code property
  return (e as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Returns a backup file name based on the SHA256 hash of the file path.
 * Format: {first 16 chars of hash}@s{version}
 */
function getBackupFileName(filePath: string, version: number): string {
  const hash = createHash('sha256').update(filePath).digest('hex').slice(0, 16);
  return `${hash}@s${version}`;
}

/**
 * Normalizes a file path to a relative tracking path.
 * Absolute paths are stored relative to cwd for portability.
 */
function toTrackingPath(filePath: string, cwd: string): string {
  if (isAbsolute(filePath)) {
    const rel = relative(cwd, filePath);
    // If relative path escapes cwd (starts with ..), keep absolute
    if (rel.startsWith('..')) return filePath;
    return rel;
  }
  return filePath;
}

/**
 * Expands a tracking path back to an absolute path.
 */
function toAbsolutePath(trackingPath: string, cwd: string): string {
  if (isAbsolute(trackingPath)) return trackingPath;
  return resolve(cwd, trackingPath);
}

/**
 * FileCheckpointManager manages file backups and snapshots for the rewind system.
 *
 * It stores backup copies of files before they are modified, organized by session.
 * Snapshots tie file states to conversation turn boundaries, enabling rewind.
 *
 * This system is primarily for external providers (Claude, Codex, Copilot)
 * where we cannot intercept tool execution. For Gemini, upstream's diff-based
 * revert handles file restoration.
 */
export class FileCheckpointManager {
  private state: FileCheckpointState;
  private adapter: FileCheckpointAdapter | null = null;
  private readonly checkpointDir: string;
  private readonly snapshotsLogPath: string;
  private readonly cwd: string;

  constructor(projectTempDir: string, sessionId: string, cwd: string) {
    this.checkpointDir = join(projectTempDir, 'file-checkpoints', sessionId);
    this.snapshotsLogPath = join(this.checkpointDir, SNAPSHOTS_LOG_FILENAME);
    this.cwd = cwd;
    this.state = {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    };
  }

  getCheckpointDir(): string {
    return this.checkpointDir;
  }

  setAdapter(adapter: FileCheckpointAdapter): void {
    this.adapter = adapter;
  }

  hasSnapshots(): boolean {
    return this.state.snapshots.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Backup operations
  // ---------------------------------------------------------------------------

  /**
   * Creates a backup of a file. Returns the backup record.
   * If the file doesn't exist, returns a null-backup record.
   */
  async createBackup(
    filePath: string,
    version: number,
  ): Promise<FileCheckpointBackup> {
    const trackingPath = toTrackingPath(filePath, this.cwd);

    // Check if file exists and its size
    let fileStats;
    try {
      fileStats = await stat(filePath);
    } catch (e) {
      if (isENOENT(e)) {
        // File doesn't exist — record as null backup
        return { backupFileName: null, version, backupTime: Date.now() };
      }
      throw e;
    }

    // Skip files that are too large
    if (fileStats.size > MAX_BACKUP_FILE_SIZE) {
      return { backupFileName: null, version, backupTime: Date.now() };
    }

    const backupFileName = getBackupFileName(trackingPath, version);
    const backupPath = join(this.checkpointDir, backupFileName);

    // Copy file to backup location (lazy mkdir)
    try {
      await copyFile(filePath, backupPath);
    } catch (e) {
      if (isENOENT(e)) {
        await mkdir(dirname(backupPath), { recursive: true });
        await copyFile(filePath, backupPath);
      } else {
        throw e;
      }
    }

    return { backupFileName, version, backupTime: Date.now() };
  }

  /**
   * Restores a file from a backup.
   */
  private async restoreBackup(
    filePath: string,
    backupFileName: string,
  ): Promise<void> {
    const backupPath = join(this.checkpointDir, backupFileName);

    try {
      await copyFile(backupPath, filePath);
    } catch (e) {
      if (isENOENT(e)) {
        // Backup dir may not exist, or target dir may not exist
        await mkdir(dirname(filePath), { recursive: true });
        await copyFile(backupPath, filePath);
      } else {
        throw e;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot operations
  // ---------------------------------------------------------------------------

  /**
   * Called after an external provider turn completes.
   * Delegates to the adapter to discover file changes and create backups,
   * then records a snapshot.
   */
  async createSnapshotFromAdapter(turnData: TurnEndData): Promise<void> {
    if (!this.adapter) return;

    const backups = await this.adapter.onAfterTurn(
      this.checkpointDir,
      turnData,
    );
    dbg('adapter returned backups:', backups ? Object.keys(backups) : null);
    if (backups) {
      for (const [k, v] of Object.entries(backups)) {
        dbg(`  backup: ${k} → ${v.backupFileName} (v${v.version})`);
      }
    }
    if (!backups) return;

    // Update tracked files
    for (const trackingPath of Object.keys(backups)) {
      this.state.trackedFiles.add(trackingPath);
    }

    // Build the snapshot — include ALL currently tracked files.
    // For files not in this turn's backups, carry forward from the previous snapshot.
    const trackedFileBackups: Record<string, FileCheckpointBackup> = {};
    const previousSnapshot =
      this.state.snapshots.length > 0
        ? this.state.snapshots[this.state.snapshots.length - 1]
        : null;

    for (const trackingPath of this.state.trackedFiles) {
      if (backups[trackingPath]) {
        // This file was changed in this turn — use new backup
        trackedFileBackups[trackingPath] = backups[trackingPath];
      } else if (previousSnapshot?.trackedFileBackups[trackingPath]) {
        // File unchanged — carry forward from previous snapshot
        trackedFileBackups[trackingPath] =
          previousSnapshot.trackedFileBackups[trackingPath];
      }
    }

    const snapshot: FileCheckpointSnapshot = {
      provider: turnData.provider,
      trackedFileBackups,
      timestamp: turnData.timestamp,
    };

    // Add to state (circular buffer)
    this.state.snapshots.push(snapshot);
    if (this.state.snapshots.length > MAX_SNAPSHOTS) {
      this.state.snapshots = this.state.snapshots.slice(-MAX_SNAPSHOTS);
    }
    this.state.snapshotSequence++;

    // Persist
    await this.appendSnapshotLog(snapshot);
  }

  // ---------------------------------------------------------------------------
  // Rewind operations
  // ---------------------------------------------------------------------------

  /**
   * Rewinds files to the state captured at a specific turn index.
   * turnIndex 0 = first turn's snapshot, 1 = second turn, etc.
   * Pass -1 to rewind to before any edits (deletes/restores all tracked files).
   *
   * Returns the list of files that were actually changed on disk.
   */
  async rewindTo(turnIndex: number): Promise<string[]> {
    dbg('rewindTo called', { turnIndex, snapshotCount: this.state.snapshots.length, trackedFiles: Array.from(this.state.trackedFiles) });

    const targetIndex = turnIndex;
    dbg('targetIndex', targetIndex);

    if (targetIndex < 0 || targetIndex >= this.state.snapshots.length) {
      dbg('turn index out of range, returning empty');
      return [];
    }

    const targetSnapshot = this.state.snapshots[targetIndex];
    dbg('targetSnapshot backups:', Object.keys(targetSnapshot.trackedFileBackups));
    const filesChanged: string[] = [];

    // Iterate ALL tracked files — not just the target snapshot's files
    for (const trackingPath of this.state.trackedFiles) {
      const filePath = toAbsolutePath(trackingPath, this.cwd);
      const backup = targetSnapshot.trackedFileBackups[trackingPath];
      dbg('processing', { trackingPath, filePath, hasBackup: !!backup, backupFileName: backup?.backupFileName });

      if (!backup) {
        // File was NOT tracked at the target snapshot.
        // Find its first-ever backup to determine original state.
        const firstBackup = this.getFirstVersionBackup(trackingPath);

        if (firstBackup && firstBackup.backupFileName === null) {
          // File didn't exist before it was first tracked → delete it
          try {
            await unlink(filePath);
            filesChanged.push(filePath);
          } catch (e) {
            if (!isENOENT(e)) throw e;
            // Already doesn't exist — fine
          }
        } else if (firstBackup && firstBackup.backupFileName) {
          // File existed before first edit → restore to original
          try {
            await this.restoreBackup(filePath, firstBackup.backupFileName);
            filesChanged.push(filePath);
          } catch (e) {
            if (!isENOENT(e)) throw e;
          }
        }
        continue;
      }

      if (backup.backupFileName === null) {
        // File didn't exist at this snapshot → delete if present
        try {
          await unlink(filePath);
          filesChanged.push(filePath);
        } catch (e) {
          if (!isENOENT(e)) throw e;
        }
      } else {
        // Restore from backup
        try {
          await this.restoreBackup(filePath, backup.backupFileName);
          filesChanged.push(filePath);
        } catch (e) {
          if (!isENOENT(e)) throw e;
        }
      }
    }

    // Truncate snapshots — remove everything after the target
    this.state.snapshots = this.state.snapshots.slice(0, targetIndex + 1);
    await this.persistSnapshots();

    return filesChanged;
  }

  /**
   * Gets per-turn diff stats (for UI display).
   * Shows what THIS turn changed by comparing snapshot[N] (pre-turn-N state)
   * against snapshot[N+1] (pre-turn-N+1 state, i.e. post-turn-N state),
   * or against the current file for the last turn.
   */
  async getDiffStatsForTurn(
    turnIndex: number,
  ): Promise<FileCheckpointDiffStats | null> {
    if (turnIndex < 0 || turnIndex >= this.state.snapshots.length) return null;

    const preSnapshot = this.state.snapshots[turnIndex];
    const postSnapshot = turnIndex + 1 < this.state.snapshots.length
      ? this.state.snapshots[turnIndex + 1]
      : null;

    const filesChanged: string[] = [];
    let totalInsertions = 0;
    let totalDeletions = 0;

    // Collect all file paths involved in this turn
    const relevantPaths = new Set<string>();
    for (const p of Object.keys(preSnapshot.trackedFileBackups)) relevantPaths.add(p);
    if (postSnapshot) {
      for (const p of Object.keys(postSnapshot.trackedFileBackups)) relevantPaths.add(p);
    }

    const results = await Promise.all(
      Array.from(relevantPaths, async (trackingPath) => {
        try {
          const filePath = toAbsolutePath(trackingPath, this.cwd);
          const preBackup = preSnapshot.trackedFileBackups[trackingPath];
          const postBackup = postSnapshot?.trackedFileBackups[trackingPath];

          // Pre-turn state (from this turn's snapshot)
          const prePath = preBackup?.backupFileName
            ? join(this.checkpointDir, preBackup.backupFileName)
            : null;

          // Post-turn state: next snapshot's backup, or current file
          let postContent: string | null;
          if (postSnapshot && postBackup) {
            const postPath = postBackup.backupFileName
              ? join(this.checkpointDir, postBackup.backupFileName)
              : null;
            postContent = postPath
              ? await readFile(postPath, 'utf-8').catch(() => null)
              : null;
          } else {
            // Last turn — compare against current file
            postContent = await readFile(filePath, 'utf-8').catch(() => null);
          }

          const preContent = prePath
            ? await readFile(prePath, 'utf-8').catch(() => null)
            : null;

          // Both null — no change in this turn
          if (preContent === null && postContent === null) return null;
          // Same content — no change
          if (preContent === postContent) return null;

          const changes = diffLines(preContent ?? '', postContent ?? '');
          let insertions = 0;
          let deletions = 0;
          for (const c of changes) {
            if (c.added) insertions += c.count || 0;
            if (c.removed) deletions += c.count || 0;
          }

          if (insertions === 0 && deletions === 0) return null;
          return { filePath, insertions, deletions };
        } catch {
          return null;
        }
      }),
    );

    for (const r of results) {
      if (!r) continue;
      filesChanged.push(r.filePath);
      totalInsertions += r.insertions;
      totalDeletions += r.deletions;
    }

    if (filesChanged.length === 0) return null;

    return {
      filesChanged,
      fileCount: filesChanged.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async appendSnapshotLog(
    snapshot: FileCheckpointSnapshot,
  ): Promise<void> {
    const line = JSON.stringify(snapshot) + '\n';
    try {
      await appendFile(this.snapshotsLogPath, line, { mode: 0o600 });
    } catch (e) {
      if (isENOENT(e)) {
        await mkdir(dirname(this.snapshotsLogPath), { recursive: true });
        await appendFile(this.snapshotsLogPath, line, { mode: 0o600 });
      } else {
        throw e;
      }
    }
  }

  /**
   * Rewrites the snapshots log (used after truncation on rewind).
   */
  private async persistSnapshots(): Promise<void> {
    const lines = this.state.snapshots
      .map((s) => JSON.stringify(s))
      .join('\n');
    const content = lines.length > 0 ? lines + '\n' : '';
    try {
      await writeFile(this.snapshotsLogPath, content, { mode: 0o600 });
    } catch (e) {
      if (isENOENT(e)) {
        await mkdir(dirname(this.snapshotsLogPath), { recursive: true });
        await writeFile(this.snapshotsLogPath, content, { mode: 0o600 });
      } else {
        throw e;
      }
    }
  }

  /**
   * Loads snapshot state from the JSONL log on disk (for session resume).
   */
  async loadFromDisk(): Promise<void> {
    let data: string;
    try {
      data = await readFile(this.snapshotsLogPath, 'utf-8');
    } catch (e) {
      if (isENOENT(e)) return; // No snapshots yet
      throw e;
    }

    const lines = data.trim().split('\n').filter(Boolean);
    const snapshots: FileCheckpointSnapshot[] = [];
    const trackedFiles = new Set<string>();

    for (const line of lines) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- JSONL is our own format
        const snapshot = JSON.parse(line) as FileCheckpointSnapshot;
        snapshots.push(snapshot);
        for (const trackingPath of Object.keys(snapshot.trackedFileBackups)) {
          trackedFiles.add(trackingPath);
        }
      } catch {
        // Skip malformed lines
      }
    }

    this.state = {
      snapshots,
      trackedFiles,
      snapshotSequence: snapshots.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the number of snapshots (= number of turns with file changes).
   */
  getSnapshotCount(): number {
    return this.state.snapshots.length;
  }

  /**
   * Finds the first-ever backup for a tracking path across all snapshots.
   */
  private getFirstVersionBackup(
    trackingPath: string,
  ): FileCheckpointBackup | null {
    for (const snapshot of this.state.snapshots) {
      const backup = snapshot.trackedFileBackups[trackingPath];
      if (backup) return backup;
    }
    return null;
  }

  dispose(): void {
    this.adapter?.dispose();
    this.adapter = null;
  }
}
