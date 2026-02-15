/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import { EventEmitter } from 'events';
import { watch, promises as fs } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import path from 'node:path';

/**
 * Directory Watcher Service
 *
 * Watches workspace directory for file/folder changes using native fs.watch
 * - Monitors file/folder additions and deletions (rename events)
 * - Ignores content modifications (change events) - they don't affect tree structure
 * - Debounces rapid changes to prevent excessive tree refreshes
 * - Respects ignore patterns (node_modules, .git, etc.)
 *
 * Events emitted:
 * - 'directory-change': { type, path } - When workspace structure changes
 * - 'error': Error - When watcher encounters errors
 *
 * Note: On Windows, fs.watch triggers 'change' events when files are read
 * (due to access time updates). We intentionally ignore these to prevent
 * memory bloat during operations like indexing that read many files.
 */
export class DirectoryWatcherService extends EventEmitter {
  private workspaceRoot: string;
  private watcher: FSWatcher | null = null;
  private isWatching: boolean = false;
  private ignoredPatterns: string[];
  private debounceTimeout: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_DELAY = 300; // 300ms debounce for tree refresh

  constructor(workspaceRoot: string, ignoredPatterns?: string[]) {
    super();
    this.workspaceRoot = path.resolve(workspaceRoot);
    // Only skip always-hidden items — ignored files are now visible in the tree
    // and need change events to trigger tree refreshes
    this.ignoredPatterns = ignoredPatterns || [
      '.git',
      '.DS_Store',
      'Thumbs.db',
    ];
  }

  /**
   * Start watching the workspace directory
   */
  async start(): Promise<void> {
    if (this.isWatching) {
      return;
    }

    try {
      // Use native fs.watch with recursive option
      // recursive: true works on Windows and macOS natively
      // On Linux, it watches only the root directory (still useful for most changes)
      this.watcher = watch(
        this.workspaceRoot,
        { recursive: true },
        (eventType, filename) => {
          this.handleChange(eventType, filename);
        }
      );

      // Handle watcher errors
      this.watcher.on('error', (error) => {
        console.error('Directory watcher error:', error);
        this.emit('error', error);
      });

      this.isWatching = true;
    } catch (error: any) {
      console.error('Failed to start directory watcher:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Handle file system change events
   *
   * @param eventType - 'rename' (add/delete) or 'change' (modify)
   * @param filename - Relative filename that changed (null on some platforms)
   */
  private handleChange(eventType: string, filename: string | null): void {
    // If filename is null, we can't determine what changed
    // This can happen on some platforms/configurations
    if (!filename) {
      // Trigger a generic refresh only for rename events
      if (eventType === 'rename') {
        this.scheduleRefresh('rename', '.');
      }
      return;
    }

    // Check if this path should be ignored
    if (this.shouldIgnore(filename)) {
      return;
    }

    // Only refresh tree on 'rename' events (file/folder add/delete)
    // 'change' events (file content modified) don't affect tree structure
    // This prevents memory bloat during indexing when files are being read
    // (Windows fs.watch triggers 'change' events on file reads due to access time updates)
    if (eventType === 'rename') {
      this.scheduleRefresh(eventType, filename);
    }
  }

  /**
   * Schedule a debounced tree refresh
   * Multiple rapid changes will only trigger one refresh
   *
   * @param eventType - Type of change event
   * @param filename - File that changed
   */
  private scheduleRefresh(eventType: string, filename: string): void {
    // Clear existing timeout
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
    }

    // Schedule new refresh after debounce delay
    this.debounceTimeout = setTimeout(() => {
      // console.log(`Directory change detected: ${eventType} - ${filename}`);

      // Emit directory-change event
      // WebInterfaceService will listen to this and trigger tree refresh
      this.emit('directory-change', {
        type: eventType,
        path: filename
      });

      this.debounceTimeout = null;
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * Check if a file/folder should be ignored
   *
   * @param filename - Relative path from workspace root
   * @returns true if should be ignored
   */
  private shouldIgnore(filename: string): boolean {
    // Normalize path separators for cross-platform compatibility
    const normalized = filename.replace(/\\/g, '/');
    const parts = normalized.split('/');

    // Check each part of the path against ignore patterns
    return parts.some(part => {
      return this.ignoredPatterns.some(pattern => {
        if (pattern.includes('*')) {
          // Handle wildcard patterns (e.g., "*.pyc")
          const regex = new RegExp(
            '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
          );
          return regex.test(part);
        }
        // Exact match
        return part === pattern;
      });
    });
  }

  /**
   * Stop watching the directory
   */
  async stop(): Promise<void> {
    if (!this.isWatching || !this.watcher) {
      return;
    }

    // Clear any pending debounce
    if (this.debounceTimeout) {
      clearTimeout(this.debounceTimeout);
      this.debounceTimeout = null;
    }

    // Close the watcher
    this.watcher.close();
    this.watcher = null;
    this.isWatching = false;
  }

  /**
   * Get current watcher status
   */
  getStatus(): { isWatching: boolean; workspaceRoot: string } {
    return {
      isWatching: this.isWatching,
      workspaceRoot: this.workspaceRoot
    };
  }

  /**
   * Clean up and remove all listeners
   */
  destroy(): void {
    this.stop();
    this.removeAllListeners();
  }
}
