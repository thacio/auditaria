/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { EventEmitter } from 'events';
import { watch, promises as fs } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import type { WebSocket } from 'ws';
import path from 'node:path';

/**
 * File watch entry tracking watch state for a specific file
 */
interface FileWatch {
  path: string;
  absolutePath: string;
  watcher: FSWatcher | null;
  clients: Set<WebSocket>;
  lastKnownContent: string;
  lastKnownStats: {
    size: number;
    mtime: number;
  };
  expectedChangeHashes: Set<string>;
  debounceTimeout: NodeJS.Timeout | null;
}

/**
 * File statistics returned from stat operations
 */
interface FileStats {
  size: number;
  mtime: number;
}

/**
 * File Watcher Service
 *
 * Watches files for external changes using native fs.watch
 * - Tracks which files are being watched by which clients
 * - Detects external changes (not from web interface saves)
 * - Distinguishes internal vs external changes using content hashing
 * - Debounces rapid file changes (100ms)
 * - Emits events when external changes detected
 *
 * Events emitted:
 * - 'file-external-change': { path, diskContent, diskStats, clients }
 * - 'file-external-delete': { path, clients }
 * - 'watch-error': { path, error, clients }
 */
export class FileWatcherService extends EventEmitter {
  private workspaceRoot: string;
  private watches: Map<string, FileWatch>;
  private readonly MAX_DIFF_FILE_SIZE = 10 * 1024 * 1024; // 10MB limit for diff
  private readonly DEBOUNCE_DELAY = 100; // 100ms debounce
  private readonly EXPECTED_CHANGE_TTL = 2000; // 2 seconds TTL for expected changes

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.watches = new Map();
  }

  /**
   * Start watching a file for a specific client
   *
   * @param filePath - Relative path from workspace root
   * @param client - WebSocket client watching this file
   * @param initialContent - Initial content of the file
   */
  async watchFile(filePath: string, client: WebSocket, initialContent: string): Promise<void> {
    try {
      // Resolve to absolute path
      const absolutePath = this.resolveAbsolutePath(filePath);

      // Check if file exists and get stats
      const stats = await this.getFileStats(absolutePath);
      if (!stats) {
        throw new Error(`File not found: ${filePath}`);
      }

      // Check file size
      if (stats.size > this.MAX_DIFF_FILE_SIZE) {
        console.warn(`File too large for diff watching: ${filePath} (${stats.size} bytes)`);
        this.emit('watch-error', {
          path: filePath,
          error: `File too large for diff (max ${this.MAX_DIFF_FILE_SIZE / 1024 / 1024}MB)`,
          clients: [client]
        });
        return;
      }

      // Get or create watch entry
      let watchEntry = this.watches.get(filePath);

      if (!watchEntry) {
        // Create new watch entry
        watchEntry = {
          path: filePath,
          absolutePath,
          watcher: null,
          clients: new Set(),
          lastKnownContent: initialContent,
          lastKnownStats: {
            size: stats.size,
            mtime: stats.mtime
          },
          expectedChangeHashes: new Set(),
          debounceTimeout: null
        };

        // Start fs.watch
        try {
          watchEntry.watcher = watch(absolutePath, (eventType, filename) => {
            this.handleFileChange(filePath);
          });

          watchEntry.watcher.on('error', (error) => {
            console.error(`File watcher error for ${filePath}:`, error);
            this.handleWatchError(filePath, error);
          });
        } catch (error) {
          console.error(`Failed to start watching ${filePath}:`, error);
          throw error;
        }

        this.watches.set(filePath, watchEntry);
      }

      // Add client to watch entry
      watchEntry.clients.add(client);

      // Silently start watching (no log noise)
    } catch (error: any) {
      console.error(`Error watching file ${filePath}:`, error);
      this.emit('watch-error', {
        path: filePath,
        error: error.message,
        clients: [client]
      });
    }
  }

  /**
   * Stop watching a file for a specific client
   *
   * @param filePath - Relative path from workspace root
   * @param client - WebSocket client to remove
   */
  unwatchFile(filePath: string, client: WebSocket): void {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    // Remove client
    watchEntry.clients.delete(client);

    // If no more clients, stop watching
    if (watchEntry.clients.size === 0) {
      this.stopWatching(filePath);
    }
  }

  /**
   * Stop watching all files for a specific client (e.g., on disconnect)
   *
   * @param client - WebSocket client to remove from all watches
   */
  unwatchAllForClient(client: WebSocket): void {
    const pathsToCheck = Array.from(this.watches.keys());

    for (const filePath of pathsToCheck) {
      this.unwatchFile(filePath, client);
    }
  }

  /**
   * Mark an expected change (from web interface save)
   * This prevents the change from being treated as external
   *
   * @param filePath - Relative path from workspace root
   * @param content - New content that will be written
   */
  markExpectedChange(filePath: string, content: string): void {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    const hash = this.computeContentHash(content);
    watchEntry.expectedChangeHashes.add(hash);

    // Remove hash after TTL to prevent memory leak
    setTimeout(() => {
      watchEntry.expectedChangeHashes.delete(hash);
    }, this.EXPECTED_CHANGE_TTL);
  }

  /**
   * Handle file change event (debounced)
   *
   * @param filePath - Relative path from workspace root
   */
  private handleFileChange(filePath: string): void {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    // Clear existing debounce timeout
    if (watchEntry.debounceTimeout) {
      clearTimeout(watchEntry.debounceTimeout);
    }

    // Debounce: wait 100ms before processing change
    watchEntry.debounceTimeout = setTimeout(async () => {
      await this.processFileChange(filePath);
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * Process file change after debounce
   *
   * @param filePath - Relative path from workspace root
   */
  private async processFileChange(filePath: string): Promise<void> {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    try {
      // Check if file still exists
      const stats = await this.getFileStats(watchEntry.absolutePath);
      if (!stats) {
        // File was deleted
        this.handleFileDelete(filePath);
        return;
      }

      // Read new content
      const newContent = await fs.readFile(watchEntry.absolutePath, 'utf-8');
      const newHash = this.computeContentHash(newContent);

      // Check if this change was expected (internal save)
      if (watchEntry.expectedChangeHashes.has(newHash)) {
        // Internal change - update last known content and ignore
        watchEntry.lastKnownContent = newContent;
        watchEntry.lastKnownStats = {
          size: stats.size,
          mtime: stats.mtime
        };
        watchEntry.expectedChangeHashes.delete(newHash);
        console.log(`Internal change detected for ${filePath}, ignoring`);
        return;
      }

      // Check if content actually changed
      const oldHash = this.computeContentHash(watchEntry.lastKnownContent);
      if (newHash === oldHash) {
        // Content hasn't changed (maybe just timestamp update)
        watchEntry.lastKnownStats = {
          size: stats.size,
          mtime: stats.mtime
        };
        return;
      }

      // External change detected!
      console.log(`External change detected for ${filePath}`);

      // Emit event with client list
      this.emit('file-external-change', {
        path: filePath,
        diskContent: newContent,
        diskStats: {
          size: stats.size,
          modified: stats.mtime
        },
        clients: Array.from(watchEntry.clients)
      });

      // Update last known content
      watchEntry.lastKnownContent = newContent;
      watchEntry.lastKnownStats = {
        size: stats.size,
        mtime: stats.mtime
      };
    } catch (error: any) {
      // Check if it's a "file not found" error (deletion)
      if (error.code === 'ENOENT') {
        this.handleFileDelete(filePath);
      } else {
        console.error(`Error processing file change for ${filePath}:`, error);
        this.emit('watch-error', {
          path: filePath,
          error: error.message,
          clients: Array.from(watchEntry.clients)
        });
      }
    }
  }

  /**
   * Handle file deletion
   *
   * @param filePath - Relative path from workspace root
   */
  private handleFileDelete(filePath: string): void {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    console.log(`File deleted: ${filePath}`);

    // Emit delete event
    this.emit('file-external-delete', {
      path: filePath,
      clients: Array.from(watchEntry.clients)
    });

    // Stop watching
    this.stopWatching(filePath);
  }

  /**
   * Handle watch error
   *
   * @param filePath - Relative path from workspace root
   * @param error - Error object
   */
  private handleWatchError(filePath: string, error: Error): void {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    this.emit('watch-error', {
      path: filePath,
      error: error.message,
      clients: Array.from(watchEntry.clients)
    });

    // Stop watching on error
    this.stopWatching(filePath);
  }

  /**
   * Stop watching a file
   *
   * @param filePath - Relative path from workspace root
   */
  private stopWatching(filePath: string): void {
    const watchEntry = this.watches.get(filePath);
    if (!watchEntry) {
      return;
    }

    // Clear debounce timeout
    if (watchEntry.debounceTimeout) {
      clearTimeout(watchEntry.debounceTimeout);
      watchEntry.debounceTimeout = null;
    }

    // Close fs.watch
    if (watchEntry.watcher) {
      watchEntry.watcher.close();
      watchEntry.watcher = null;
    }

    // Remove from map
    this.watches.delete(filePath);

    // Silently stop watching (no log noise)
  }

  /**
   * Compute SHA256 hash of content
   *
   * @param content - File content
   * @returns SHA256 hash as hex string
   */
  private computeContentHash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get file stats (size, mtime)
   *
   * @param absolutePath - Absolute file path
   * @returns File stats or null if file doesn't exist
   */
  private async getFileStats(absolutePath: string): Promise<FileStats | null> {
    try {
      const stats = await fs.stat(absolutePath);
      return {
        size: stats.size,
        mtime: stats.mtimeMs
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Resolve relative path to absolute path within workspace
   *
   * @param relativePath - Relative path from workspace root
   * @returns Absolute path
   */
  private resolveAbsolutePath(relativePath: string): string {
    return path.resolve(this.workspaceRoot, relativePath);
  }

  /**
   * Get current watch statistics
   *
   * @returns Watch statistics
   */
  getStats(): {
    watchedFiles: number;
    totalClients: number;
    files: Array<{ path: string; clients: number }>;
  } {
    const files = Array.from(this.watches.entries()).map(([path, watch]) => ({
      path,
      clients: watch.clients.size
    }));

    return {
      watchedFiles: this.watches.size,
      totalClients: files.reduce((sum, f) => sum + f.clients, 0),
      files
    };
  }

  /**
   * Clean up all watches (on service shutdown)
   */
  destroy(): void {
    const paths = Array.from(this.watches.keys());
    for (const path of paths) {
      this.stopWatching(path);
    }
    this.removeAllListeners();
  }
}
