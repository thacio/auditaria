/**
 * Types for the sync module.
 */

// ============================================================================
// Sync Result Types
// ============================================================================

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  /** Files added since last sync */
  added: string[];
  /** Files modified since last sync */
  modified: string[];
  /** Files deleted since last sync */
  deleted: string[];
  /** Number of unchanged files */
  unchanged: number;
  /** Duration of sync operation in milliseconds */
  duration: number;
}

/**
 * Options for sync operations.
 */
export interface SyncOptions {
  /** Don't actually make changes, just report what would happen */
  dryRun?: boolean;
  /** Priority for queued items */
  priority?: 'high' | 'normal' | 'low';
  /** Force reindexing even for unchanged files */
  force?: boolean;
}

// ============================================================================
// File Watcher Types
// ============================================================================

/**
 * Configuration for file watcher.
 */
export interface FileWatcherConfig {
  /** Enable/disable the file watcher */
  enabled: boolean;
  /** Debounce delay in milliseconds */
  debounceMs: number;
  /** Additional paths to ignore */
  ignorePaths: string[];
  /** Maximum file size to watch */
  maxFileSize: number;
}

/**
 * File change event types.
 */
export type FileChangeType = 'add' | 'change' | 'unlink';

/**
 * File change event.
 */
export interface FileChangeEvent {
  type: FileChangeType;
  filePath: string;
  absolutePath: string;
}

/**
 * Queue flushed event data.
 */
export interface QueueFlushedEvent {
  /** Number of items flushed to queue */
  count: number;
}

/**
 * Events emitted by FileWatcher.
 */
export interface FileWatcherEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;
  'file:added': FileChangeEvent;
  'file:changed': FileChangeEvent;
  'file:deleted': FileChangeEvent;
  /** Emitted after changes are flushed to the queue */
  'queue:flushed': QueueFlushedEvent;
  error: Error;
  ready: void;
}
