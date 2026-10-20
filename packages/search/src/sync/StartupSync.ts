/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StorageAdapter } from '../storage/types.js';
import type { FileDiscovery } from '../discovery/FileDiscovery.js';
import type { SyncResult, SyncOptions } from './types.js';
import { detectChanges } from './changes.js';
import { EventEmitter } from '../core/EventEmitter.js';

// ============================================================================
// Types
// ============================================================================

export interface StartupSyncEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;
  'sync:started': { totalFiles: number };
  'sync:progress': { checked: number; total: number };
  'sync:file:added': { filePath: string };
  'sync:file:modified': { filePath: string };
  'sync:file:deleted': { filePath: string };
  'sync:completed': SyncResult;
  'sync:error': { error: Error };
}

// ============================================================================
// StartupSync Class
// ============================================================================

/**
 * Handles startup synchronization by comparing disk state with database.
 */
export class StartupSync extends EventEmitter<StartupSyncEvents> {
  private readonly storage: StorageAdapter;
  private readonly discovery: FileDiscovery;

  constructor(storage: StorageAdapter, discovery: FileDiscovery) {
    super();
    this.storage = storage;
    this.discovery = discovery;
  }

  /**
   * Perform sync operation.
   * Compares files on disk with stored hashes to detect changes.
   *
   * @param options - Sync options
   * @returns Sync result with lists of added, modified, and deleted files
   */
  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    const startTime = Date.now();

    // 1. Get current file states from disk
    const currentFiles = await this.discovery.discoverAll();
    // Use relativePath as key for DB comparison
    const currentMap = new Map(currentFiles.map((f) => [f.relativePath, f]));

    void this.emit('sync:started', { totalFiles: currentFiles.length });

    // 2. Get stored file hashes from database (keyed by relativePath)
    const storedHashes = await this.storage.getFileHashes();

    const { added, modified, deleted } = detectChanges(
      currentFiles,
      storedHashes,
    );
    const unchanged = currentMap.size - added.length - modified.length;
    for (const filePath of added)
      void this.emit('sync:file:added', { filePath });
    for (const filePath of modified)
      void this.emit('sync:file:modified', { filePath });
    for (const filePath of deleted)
      void this.emit('sync:file:deleted', { filePath });
    void this.emit('sync:progress', {
      checked: currentFiles.length,
      total: currentFiles.length,
    });

    // 4. Apply changes (unless dry run)
    if (!options.dryRun) {
      await this.applyChanges(added, modified, deleted, options);
    }

    const result: SyncResult = {
      added,
      modified,
      deleted,
      unchanged,
      duration: Date.now() - startTime,
    };

    void this.emit('sync:completed', result);

    return result;
  }

  /**
   * Apply detected changes to the database.
   */
  private async applyChanges(
    added: string[],
    modified: string[],
    deleted: string[],
    options: SyncOptions,
  ): Promise<void> {
    const priority = options.priority ?? 'markup';

    // Queue new files for indexing
    if (added.length > 0) {
      await this.storage.enqueueItems(
        added.map((filePath) => ({
          filePath,
          priority,
        })),
      );
    }

    // Handle modified files
    if (modified.length > 0) {
      // Queue modified files for re-indexing
      await this.storage.enqueueItems(
        modified.map((filePath) => ({
          filePath,
          priority,
        })),
      );
    }

    // Delete removed files from database
    if (deleted.length > 0) {
      for (const filePath of deleted) {
        const doc = await this.storage.getDocumentByPath(filePath);
        if (doc) {
          await this.storage.deleteDocument(doc.id);
        }
      }
    }
  }

  /**
   * Quick check if sync is needed.
   * Compares file count and a few random hashes.
   *
   * @returns true if sync appears to be needed
   */
  async needsSync(): Promise<boolean> {
    try {
      // Get stored stats
      const stats = await this.storage.getStats();
      const storedHashes = await this.storage.getFileHashes();

      // If no documents indexed yet, definitely needs sync
      if (stats.totalDocuments === 0) {
        return true;
      }

      // Quick check: discover files and compare count
      const currentFiles = await this.discovery.discoverAll();

      // Different count = needs sync
      if (currentFiles.length !== storedHashes.size) {
        return true;
      }

      const changes = detectChanges(currentFiles, storedHashes);
      return (
        changes.added.length +
          changes.modified.length +
          changes.deleted.length >
        0
      );
    } catch {
      // If we can't check, assume sync is needed
      return true;
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new StartupSync instance.
 */
export function createStartupSync(
  storage: StorageAdapter,
  discovery: FileDiscovery,
): StartupSync {
  return new StartupSync(storage, discovery);
}
