/**
 * FileWatcher - Real-time file watching using chokidar.
 * Optional component for detecting file changes during a session.
 */

import { resolve, relative, extname } from 'node:path';
import { stat } from 'node:fs/promises';
import { EventEmitter } from '../core/EventEmitter.js';
import type { StorageAdapter } from '../storage/types.js';
import type {
  FileWatcherConfig,
  FileChangeEvent,
  FileWatcherEvents,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const DEFAULT_IGNORE_PATHS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.auditaria/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/venv/**',
  '**/.venv/**',
  '**/env/**',
  '**/*.log',
  '**/*.lock',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
];

const DEFAULT_FILE_TYPES = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.xlsx',
  '.xls',
  '.txt',
  '.md',
  '.markdown',
  '.rst',
  '.html',
  '.htm',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.csv',
  '.ipynb',
]);

// ============================================================================
// FileWatcher Class
// ============================================================================

/**
 * Watches files for real-time changes using chokidar.
 * Queues changed files for re-indexing.
 */
export class FileWatcher extends EventEmitter<FileWatcherEvents> {
  private readonly rootPath: string;
  private readonly storage: StorageAdapter;
  private readonly config: Required<FileWatcherConfig>;
  private readonly allowedFileTypes: Set<string>;

  private watcher: import('chokidar').FSWatcher | null = null;
  private pendingChanges: Map<string, FileChangeEvent> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isReady: boolean = false;

  constructor(
    rootPath: string,
    storage: StorageAdapter,
    config?: Partial<FileWatcherConfig>,
    fileTypes?: string[],
  ) {
    super();
    this.rootPath = resolve(rootPath);
    this.storage = storage;
    this.config = {
      enabled: config?.enabled ?? true,
      debounceMs: config?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      ignorePaths: [...DEFAULT_IGNORE_PATHS, ...(config?.ignorePaths ?? [])],
      maxFileSize: config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    };
    this.allowedFileTypes = new Set(
      (fileTypes ?? Array.from(DEFAULT_FILE_TYPES)).map((t) =>
        t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`,
      ),
    );
  }

  /**
   * Start watching files.
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (this.watcher) {
      return; // Already watching
    }

    try {
      // Dynamic import chokidar (optional dependency)
      const chokidar = await import('chokidar');

      this.watcher = chokidar.watch(this.rootPath, {
        ignored: this.config.ignorePaths,
        persistent: true,
        ignoreInitial: true, // Don't emit events for existing files
        followSymlinks: false,
        depth: 99,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      });

      this.watcher
        .on('add', (path) => this.handleChange('add', path))
        .on('change', (path) => this.handleChange('change', path))
        .on('unlink', (path) => this.handleChange('unlink', path))
        .on('error', (error: unknown) => {
          void this.emit(
            'error',
            error instanceof Error ? error : new Error(String(error)),
          );
        })
        .on('ready', () => {
          this.isReady = true;
          void this.emit('ready', undefined);
        });
    } catch (error) {
      // chokidar might not be installed (optional dependency)
      console.warn(
        'FileWatcher: chokidar not available, real-time watching disabled',
      );
      void this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Stop watching files.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.isReady = false;
    this.pendingChanges.clear();
  }

  /**
   * Check if watcher is running.
   */
  isWatching(): boolean {
    return this.watcher !== null && this.isReady;
  }

  /**
   * Handle file change event.
   */
  private handleChange(
    type: 'add' | 'change' | 'unlink',
    absolutePath: string,
  ): void {
    // Check file type
    const ext = extname(absolutePath).toLowerCase();
    if (!this.allowedFileTypes.has(ext)) {
      return;
    }

    const relativePath = relative(this.rootPath, absolutePath);

    const event: FileChangeEvent = {
      type,
      filePath: relativePath,
      absolutePath,
    };

    // Store pending change
    this.pendingChanges.set(absolutePath, event);

    // Emit individual event
    switch (type) {
      case 'add':
        void this.emit('file:added', event);
        break;
      case 'change':
        void this.emit('file:changed', event);
        break;
      case 'unlink':
        void this.emit('file:deleted', event);
        break;
      default:
        // Exhaustive check - should never reach here
        break;
    }

    // Schedule debounced flush
    this.scheduleFlush();
  }

  /**
   * Schedule debounced flush of pending changes.
   */
  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.config.debounceMs);
  }

  /**
   * Flush pending changes to database.
   */
  private async flush(): Promise<void> {
    const changes = new Map(this.pendingChanges);
    this.pendingChanges.clear();

    let processedCount = 0;

    for (const [absolutePath, event] of changes) {
      try {
        switch (event.type) {
          case 'add':
          case 'change':
            await this.handleFileAddOrChange(absolutePath);
            processedCount++;
            break;
          case 'unlink':
            await this.handleFileDelete(absolutePath);
            processedCount++;
            break;
          default:
            // Exhaustive check - should never reach here
            break;
        }
      } catch (error) {
        console.error(
          `FileWatcher: Error handling ${event.type} for ${absolutePath}:`,
          error,
        );
      }
    }

    // Emit queue:flushed event to signal that items have been queued
    if (processedCount > 0) {
      void this.emit('queue:flushed', { count: processedCount });
    }
  }

  /**
   * Handle file add or change.
   */
  private async handleFileAddOrChange(absolutePath: string): Promise<void> {
    // Check file size
    try {
      const stats = await stat(absolutePath);
      if (stats.size > this.config.maxFileSize) {
        return; // File too large
      }
    } catch {
      return; // File doesn't exist anymore
    }

    // Check if document already exists
    const existingDoc = await this.storage.getDocumentByPath(absolutePath);

    if (existingDoc) {
      // Delete existing chunks and mark for re-indexing
      await this.storage.deleteChunks(existingDoc.id);
      await this.storage.updateDocument(existingDoc.id, { status: 'pending' });
    }

    // Queue for indexing
    const existingQueueItem =
      await this.storage.getQueueItemByPath(absolutePath);
    if (!existingQueueItem) {
      await this.storage.enqueueItem({
        filePath: absolutePath,
        priority: 'normal',
      });
    }
  }

  /**
   * Handle file deletion.
   */
  private async handleFileDelete(absolutePath: string): Promise<void> {
    const doc = await this.storage.getDocumentByPath(absolutePath);
    if (doc) {
      await this.storage.deleteDocument(doc.id);
    }
  }

  /**
   * Get watched paths count.
   */
  getWatchedPathsCount(): number {
    if (!this.watcher) return 0;
    const watched = this.watcher.getWatched();
    return Object.keys(watched).reduce(
      (count, dir) => count + watched[dir].length,
      0,
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new FileWatcher instance.
 * Note: chokidar is an optional dependency. If not installed,
 * the watcher will emit an error and disable itself.
 */
export function createFileWatcher(
  rootPath: string,
  storage: StorageAdapter,
  config?: Partial<FileWatcherConfig>,
  fileTypes?: string[],
): FileWatcher {
  return new FileWatcher(rootPath, storage, config, fileTypes);
}
