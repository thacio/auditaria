/**
 * StartupSync - Detects file changes since last sync.
 * Compares discovered files on disk with stored hashes in the database.
 */

import type { StorageAdapter } from '../storage/types.js';
import type { FileDiscovery } from '../discovery/FileDiscovery.js';
import type { SyncResult, SyncOptions } from './types.js';
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
    const currentMap = new Map(currentFiles.map((f) => [f.absolutePath, f]));

    void this.emit('sync:started', { totalFiles: currentFiles.length });

    // 2. Get stored file hashes from database
    const storedHashes = await this.storage.getFileHashes();

    // 3. Compare and categorize
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    let unchanged = 0;

    // Find added and modified files
    let checked = 0;
    for (const [filePath, file] of currentMap) {
      checked++;

      if (checked % 100 === 0) {
        void this.emit('sync:progress', {
          checked,
          total: currentFiles.length,
        });
      }

      const storedHash = storedHashes.get(filePath);

      if (!storedHash) {
        // New file
        added.push(filePath);
        void this.emit('sync:file:added', { filePath });
      } else if (storedHash !== file.hash) {
        // Modified file
        modified.push(filePath);
        void this.emit('sync:file:modified', { filePath });
      } else {
        unchanged++;
      }
    }

    // Find deleted files
    for (const [filePath] of storedHashes) {
      if (!currentMap.has(filePath)) {
        deleted.push(filePath);
        void this.emit('sync:file:deleted', { filePath });
      }
    }

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
    const priority = options.priority ?? 'normal';

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
      for (const filePath of modified) {
        const doc = await this.storage.getDocumentByPath(filePath);
        if (doc) {
          // Delete existing chunks
          await this.storage.deleteChunks(doc.id);
          // Update document status
          await this.storage.updateDocument(doc.id, { status: 'pending' });
        }
      }

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

      // Sample check: verify a few random files
      const sampleSize = Math.min(10, currentFiles.length);
      const sample = currentFiles.slice(0, sampleSize);

      for (const file of sample) {
        const storedHash = storedHashes.get(file.absolutePath);
        if (!storedHash || storedHash !== file.hash) {
          return true;
        }
      }

      return false;
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
