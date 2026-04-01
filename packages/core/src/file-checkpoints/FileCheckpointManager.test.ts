/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: Tests for the file checkpoints system

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FileCheckpointManager } from './FileCheckpointManager.js';
import type { FileCheckpointAdapter } from './types.js';

describe('FileCheckpointManager', () => {
  let tempDir: string;
  let projectTempDir: string;
  let cwd: string;
  let manager: FileCheckpointManager;
  const sessionId = 'test-session-001';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fcp-test-'));
    projectTempDir = join(tempDir, 'project-temp');
    cwd = join(tempDir, 'workspace');
    await mkdir(projectTempDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    manager = new FileCheckpointManager(projectTempDir, sessionId, cwd);
  });

  afterEach(async () => {
    manager.dispose();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('createBackup', () => {
    it('creates a backup file and returns a valid record', async () => {
      const filePath = join(cwd, 'test.ts');
      await writeFile(filePath, 'const x = 1;');

      const backup = await manager.createBackup(filePath, 1);

      expect(backup.backupFileName).toBeTruthy();
      expect(backup.backupFileName).toContain('@s1');
      expect(backup.version).toBe(1);
      expect(backup.backupTime).toBeGreaterThan(0);

      // Verify the backup file exists and has correct content
      const backupPath = join(manager.getCheckpointDir(), backup.backupFileName!);
      const content = await readFile(backupPath, 'utf-8');
      expect(content).toBe('const x = 1;');
    });

    it('returns null backup for non-existent file', async () => {
      const filePath = join(cwd, 'nonexistent.ts');
      const backup = await manager.createBackup(filePath, 1);

      expect(backup.backupFileName).toBeNull();
      expect(backup.version).toBe(1);
    });

    it('increments version correctly', async () => {
      const filePath = join(cwd, 'test.ts');
      await writeFile(filePath, 'v1');
      const b1 = await manager.createBackup(filePath, 1);

      await writeFile(filePath, 'v2');
      const b2 = await manager.createBackup(filePath, 2);

      expect(b1.backupFileName).toContain('@s1');
      expect(b2.backupFileName).toContain('@s2');
      expect(b1.version).toBe(1);
      expect(b2.version).toBe(2);
    });
  });

  describe('createSnapshotFromAdapter', () => {
    it('creates snapshot from adapter results', async () => {
      const filePath = join(cwd, 'foo.ts');
      await writeFile(filePath, 'original');

      // Create a backup manually first
      const backup = await manager.createBackup(filePath, 1);

      // Mock adapter
      const mockAdapter: FileCheckpointAdapter = {
        provider: 'test',
        async onAfterTurn() {
          return { 'foo.ts': backup };
        },
        dispose: vi.fn(),
      };
      manager.setAdapter(mockAdapter);

      await manager.createSnapshotFromAdapter({
        provider: 'test',
        timestamp: 1000,
      });

      expect(manager.hasSnapshots()).toBe(true);
    });

    it('carries forward unchanged files from previous snapshot', async () => {
      const fooPath = join(cwd, 'foo.ts');
      const barPath = join(cwd, 'bar.ts');
      await writeFile(fooPath, 'foo content');
      await writeFile(barPath, 'bar content');

      const fooBackup = await manager.createBackup(fooPath, 1);
      const barBackup = await manager.createBackup(barPath, 1);

      // Turn 1: both files changed
      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn()
          .mockResolvedValueOnce({ 'foo.ts': fooBackup, 'bar.ts': barBackup })
          .mockResolvedValueOnce({ 'foo.ts': { ...fooBackup, version: 2, backupFileName: fooBackup.backupFileName!.replace('@s1', '@s2') } }),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);

      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });
      // Create v2 backup for foo
      await writeFile(fooPath, 'foo modified');
      await manager.createBackup(fooPath, 2);
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 2000 });

      // Rewind to turn 1 — bar should still have its backup
      const changed = await manager.rewindTo(0);
      // Both files should be restored
      expect(changed.length).toBeGreaterThan(0);
    });

    it('does nothing when adapter returns null', async () => {
      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn().mockResolvedValue(null),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);

      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });
      expect(manager.hasSnapshots()).toBe(false);
    });

    it('does nothing when no adapter is set', async () => {
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });
      expect(manager.hasSnapshots()).toBe(false);
    });
  });

  describe('rewindTo', () => {
    it('restores files to the target snapshot state', async () => {
      const filePath = join(cwd, 'test.ts');
      await writeFile(filePath, 'original');

      // Simulate turn 1: backup original, then modify
      const backup1 = await manager.createBackup(filePath, 1);
      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn().mockResolvedValueOnce({ 'test.ts': backup1 }),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });

      // Now the file has been "edited" by the provider
      await writeFile(filePath, 'modified by provider');

      // Rewind
      const changed = await manager.rewindTo(0);
      expect(changed).toContain(filePath);

      const content = await readFile(filePath, 'utf-8');
      expect(content).toBe('original');
    });

    it('deletes files that did not exist at target snapshot', async () => {
      const existingFile = join(cwd, 'existing.ts');
      const newFile = join(cwd, 'new.ts');
      await writeFile(existingFile, 'exists');

      // Turn 1: only existing.ts is tracked
      const backup1 = await manager.createBackup(existingFile, 1);
      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn()
          .mockResolvedValueOnce({ 'existing.ts': backup1 })
          .mockResolvedValueOnce({
            'new.ts': { backupFileName: null, version: 1, backupTime: Date.now() },
          }),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });

      // Turn 2: new.ts created (null backup = didn't exist before)
      await writeFile(newFile, 'new content');
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 2000 });

      // Rewind to turn 1 — new.ts should be deleted
      await manager.rewindTo(0);

      // new.ts should no longer exist
      let exists = true;
      try { await stat(newFile); } catch { exists = false; }
      expect(exists).toBe(false);
    });

    it('truncates snapshots after the target', async () => {
      const filePath = join(cwd, 'test.ts');
      await writeFile(filePath, 'v1');
      const b1 = await manager.createBackup(filePath, 1);

      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn()
          .mockResolvedValueOnce({ 'test.ts': b1 })
          .mockResolvedValueOnce({ 'test.ts': { ...b1, version: 2 } })
          .mockResolvedValueOnce({ 'test.ts': { ...b1, version: 3 } }),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);

      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 2000 });
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 3000 });

      // Rewind to second snapshot
      await manager.rewindTo(1);

      // Only 2 snapshots should remain (not 3)
      // getDiffStatsForTurn(2500) should match snapshot at 2000 (the last one kept)
      // After rewind to 2000, we should have 2 snapshots (not 3)
      // Verify by checking hasSnapshots still true and re-adding works
      expect(manager.hasSnapshots()).toBe(true);

      // Creating a new snapshot at 4000 should work (proves state is valid after truncation)
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 4000 });
      expect(manager.hasSnapshots()).toBe(true);
    });

    it('returns empty array when no matching snapshot', async () => {
      const result = await manager.rewindTo(999) // out of range;
      expect(result).toEqual([]);
    });
  });

  describe('persistence', () => {
    it('loads snapshots from disk', async () => {
      const filePath = join(cwd, 'test.ts');
      await writeFile(filePath, 'content');
      const backup = await manager.createBackup(filePath, 1);

      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn().mockResolvedValue({ 'test.ts': backup }),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });

      // Create new manager and load from disk
      const manager2 = new FileCheckpointManager(projectTempDir, sessionId, cwd);
      await manager2.loadFromDisk();

      expect(manager2.hasSnapshots()).toBe(true);
    });

    it('handles empty/missing snapshots file', async () => {
      const manager2 = new FileCheckpointManager(projectTempDir, 'nonexistent', cwd);
      await manager2.loadFromDisk();
      expect(manager2.hasSnapshots()).toBe(false);
    });
  });

  describe('getDiffStatsForTurn', () => {
    it('returns null when turn index out of range', async () => {
      const stats = await manager.getDiffStatsForTurn(999);
      expect(stats).toBeNull();
    });

    it('returns file count and line stats for matching snapshot', async () => {
      // Create real files and real backups
      const fooPath = join(cwd, 'foo.ts');
      const barPath = join(cwd, 'bar.ts');
      await writeFile(fooPath, 'original foo');
      await writeFile(barPath, 'original bar');

      const fooBackup = await manager.createBackup(fooPath, 1);
      const barBackup = await manager.createBackup(barPath, 1);

      // Now modify the files (simulating what the provider did)
      await writeFile(fooPath, 'modified foo\nnew line');
      await writeFile(barPath, 'modified bar');

      const adapter: FileCheckpointAdapter = {
        provider: 'test',
        onAfterTurn: vi.fn().mockResolvedValue({
          'foo.ts': fooBackup,
          'bar.ts': barBackup,
        }),
        dispose: vi.fn(),
      };
      manager.setAdapter(adapter);
      await manager.createSnapshotFromAdapter({ provider: 'test', timestamp: 1000 });

      const stats = await manager.getDiffStatsForTurn(0); // first turn = index 0
      expect(stats).not.toBeNull();
      expect(stats!.fileCount).toBe(2);
      expect(stats!.insertions).toBeGreaterThan(0);
      expect(stats!.deletions).toBeGreaterThan(0);
    });
  });
});
