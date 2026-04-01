/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: This entire file is part of the file checkpoints implementation

import { join } from 'node:path';
import { homedir } from 'node:os';
import { copyFile, stat, mkdir } from 'node:fs/promises';

const DEBUG = true; // Debug logging TEMPORARILY ENABLED
function dbg(...args: unknown[]) {
  if (DEBUG) console.log('[CLAUDE_CHECKPOINT]', ...args); // eslint-disable-line no-console
}
import type {
  FileCheckpointAdapter,
  FileCheckpointBackup,
  TurnEndData,
} from '../types.js';

function isENOENT(e: unknown): boolean {
  if (!(e instanceof Error) || !('code' in e)) return false;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Node.js error with code property
  return (e as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Schema of a file-history-snapshot entry in Claude's JSONL transcript.
 */
interface ClaudeSnapshotEntry {
  type: 'file-history-snapshot';
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<
      string,
      {
        backupFileName: string | null;
        version: number;
        backupTime: string; // ISO date
      }
    >;
    timestamp: string; // ISO date
  };
  isSnapshotUpdate: boolean;
}

/**
 * Derives the Claude project directory hash from a working directory path.
 * Claude replaces : \ / with - and strips leading separators.
 * E.g., "C:\projects\auditaria" → "C--projects-auditaria"
 */
function getClaudeProjectDirHash(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-').replace(/^-+/, '');
}

/**
 * Adapter that reads Claude Code's own file-history system and copies
 * backups into Auditaria's file-checkpoints directory.
 *
 * Claude Code creates pre-edit backups before each file modification
 * (via its FileEditTool/FileWriteTool/NotebookEditTool). These backups
 * are stored at ~/.claude/file-history/{sessionId}/{hash}@v{N}.
 *
 * Snapshot metadata is appended to the session JSONL at
 * ~/.claude/projects/{projectDirHash}/{sessionId}.jsonl
 * as entries with type "file-history-snapshot".
 *
 * This adapter tail-reads the JSONL from a high-water mark to find
 * new snapshot entries, then copies the corresponding backup files
 * into our checkpoint directory.
 */
export class ClaudeFileCheckpointAdapter implements FileCheckpointAdapter {
  readonly provider = 'claude-cli';

  private lastJSONLSize = 0;
  private readonly cwd: string;
  private readonly getClaudeSessionId: () => string | undefined;

  constructor(
    cwd: string,
    getClaudeSessionId: () => string | undefined,
  ) {
    this.cwd = cwd;
    this.getClaudeSessionId = getClaudeSessionId;
  }

  /**
   * After a Claude turn completes, reads new file-history-snapshot entries
   * from Claude's JSONL and copies backup files into our checkpoint dir.
   */
  async onAfterTurn(
    checkpointDir: string,
    _turnData: TurnEndData,
  ): Promise<Record<string, FileCheckpointBackup> | null> {
    const claudeSessionId = this.getClaudeSessionId();
    dbg('onAfterTurn start', { claudeSessionId, cwd: this.cwd });
    if (!claudeSessionId) { dbg('no claudeSessionId, returning null'); return null; }

    // Find Claude's JSONL path
    const projectDirHash = getClaudeProjectDirHash(this.cwd);
    const claudeHome = join(homedir(), '.claude');
    const jsonlPath = join(
      claudeHome,
      'projects',
      projectDirHash,
      `${claudeSessionId}.jsonl`,
    );
    dbg('jsonlPath', jsonlPath);

    // Get current file size
    let fileSize: number;
    try {
      fileSize = (await stat(jsonlPath)).size;
    } catch (e) {
      if (isENOENT(e)) { dbg('JSONL not found (ENOENT)'); return null; }
      throw e;
    }

    dbg('fileSize', fileSize, 'lastJSONLSize', this.lastJSONLSize);
    if (fileSize <= this.lastJSONLSize) { dbg('no new data'); return null; }

    // Read only the new portion of the file
    const newData = await this.readFileTail(jsonlPath, this.lastJSONLSize, fileSize);
    this.lastJSONLSize = fileSize;

    if (!newData) { dbg('readFileTail returned null'); return null; }
    dbg('newData length', newData.length, 'first 200 chars:', newData.slice(0, 200));

    // Parse file-history-snapshot entries from the new data
    const snapshotEntries = this.parseSnapshotEntries(newData);
    dbg('snapshotEntries found:', snapshotEntries.length);
    if (snapshotEntries.length === 0) { dbg('no snapshot entries found'); return null; }

    // Merge all snapshot entries into a single backup map.
    // Later entries override earlier ones (isSnapshotUpdate = true updates).
    const mergedBackups: Record<string, FileCheckpointBackup> = {};
    const claudeBackupDir = join(claudeHome, 'file-history', claudeSessionId);

    for (const entry of snapshotEntries) {
      for (const [trackingPath, claudeBackup] of Object.entries(
        entry.snapshot.trackedFileBackups,
      )) {
        if (claudeBackup.backupFileName === null) {
          // File didn't exist — store null backup
          mergedBackups[trackingPath] = {
            backupFileName: null,
            version: claudeBackup.version,
            backupTime: new Date(claudeBackup.backupTime).getTime(),
          };
          continue;
        }

        // Copy Claude's backup file into our checkpoint dir
        // Rename: @v{N} → @s{N} to avoid naming conflicts
        const ourBackupFileName = claudeBackup.backupFileName.replace(
          '@v',
          '@s',
        );
        const srcPath = join(claudeBackupDir, claudeBackup.backupFileName);
        const dstPath = join(checkpointDir, ourBackupFileName);

        try {
          try {
            await copyFile(srcPath, dstPath);
          } catch (e) {
            if (isENOENT(e)) {
              await mkdir(checkpointDir, { recursive: true });
              await copyFile(srcPath, dstPath);
            } else {
              throw e;
            }
          }

          mergedBackups[trackingPath] = {
            backupFileName: ourBackupFileName,
            version: claudeBackup.version,
            backupTime: new Date(claudeBackup.backupTime).getTime(),
          };
        } catch (e) {
          if (isENOENT(e)) {
            // Claude's backup file doesn't exist (cleaned or failed to create)
            // Store null backup — we can't restore this file
            mergedBackups[trackingPath] = {
              backupFileName: null,
              version: claudeBackup.version,
              backupTime: Date.now(),
            };
          } else {
            throw e;
          }
        }
      }
    }

    return Object.keys(mergedBackups).length > 0 ? mergedBackups : null;
  }

  dispose(): void {
    // No resources to clean up
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Reads a portion of a file from startByte to endByte.
   */
  private async readFileTail(
    filePath: string,
    startByte: number,
    endByte: number,
  ): Promise<string | null> {
    try {
      const fd = await import('node:fs/promises').then((m) =>
        m.open(filePath, 'r'),
      );
      try {
        const buffer = Buffer.alloc(endByte - startByte);
        await fd.read(buffer, 0, buffer.length, startByte);
        return buffer.toString('utf-8');
      } finally {
        await fd.close();
      }
    } catch (e) {
      if (isENOENT(e)) return null;
      throw e;
    }
  }

  /**
   * Parses file-history-snapshot entries from raw JSONL text.
   */
  private parseSnapshotEntries(data: string): ClaudeSnapshotEntry[] {
    const entries: ClaudeSnapshotEntry[] = [];
    const lines = data.split('\n');

    for (const line of lines) {
      if (!line.includes('"file-history-snapshot"')) continue;

      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Claude's JSONL format
        const parsed = JSON.parse(line) as ClaudeSnapshotEntry;
        if (parsed.type === 'file-history-snapshot') {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return entries;
  }
}
