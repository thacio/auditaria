/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import type { WebSocket } from 'ws';
import { resolveRipgrepPath } from '@google/gemini-cli-core';
import { FileSystemService } from '../../FileSystemService.js';
import { FileWatcherService } from '../../FileWatcherService.js';
import { DirectoryWatcherService } from '../../DirectoryWatcherService.js';
import { WebFeature } from '../core/webFeature.js';
import type { WebFeatureContext, WebLogger } from '../core/types.js';
import { readBoolean, readString, type ClientMessage } from '../protocol.js';

interface FileWatchEvent {
  path: string;
  clients: WebSocket[];
  diskContent?: string;
  diskStats?: unknown;
  error?: string;
}

interface DirectoryChangeEvent {
  path?: string | null;
}

/** Parent directory of a workspace-relative path, `.` at the root. */
export function parentDirOf(relativePath: string): string {
  const index = Math.max(
    relativePath.lastIndexOf('/'),
    relativePath.lastIndexOf('\\'),
  );
  return index > 0 ? relativePath.slice(0, index) : '.';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface FileBrowserServices {
  readonly fs: FileSystemService;
  readonly fileWatcher: FileWatcherService;
  readonly directoryWatcher: DirectoryWatcherService;
}

/**
 * Workspace file browser and editor backend: lazy tree, ripgrep-backed
 * search, read/write/create/delete/rename, "open with"/"reveal", plus two
 * watchers — per-file watches (so an editor tab learns about external
 * edits) and a workspace-wide directory watcher (so the tree refreshes).
 */
export class FileBrowserFeature extends WebFeature {
  readonly name = 'file-browser';
  private services: FileBrowserServices | null = null;

  protected async onAttach(ctx: WebFeatureContext): Promise<void> {
    const fs = new FileSystemService(ctx.workspaceRoot);
    this.enableRipgrepSearch(fs, ctx.logger);

    const fileWatcher = new FileWatcherService(ctx.workspaceRoot);
    this.wireFileWatcher(fileWatcher);

    const directoryWatcher = new DirectoryWatcherService(
      ctx.workspaceRoot,
      fs.getAlwaysHiddenPatterns(),
    );
    this.wireDirectoryWatcher(directoryWatcher, ctx.logger);
    await directoryWatcher.start();

    this.services = { fs, fileWatcher, directoryWatcher };
    this.registerHandlers(ctx);
  }

  protected async onDetach(): Promise<void> {
    const services = this.services;
    this.services = null;
    if (!services) return;
    services.fileWatcher.destroy();
    await services.directoryWatcher.stop();
  }

  override onClientDisconnected(ws: WebSocket): void {
    this.services?.fileWatcher.unwatchAllForClient(ws);
  }

  private requireServices(): FileBrowserServices {
    if (!this.services) {
      throw new Error('File browser services are not initialized');
    }
    return this.services;
  }

  /** Non-blocking: without rg the search falls back to a BFS walk. */
  private enableRipgrepSearch(fs: FileSystemService, logger: WebLogger): void {
    resolveRipgrepPath()
      .then((rgPath) => {
        if (rgPath && this.services?.fs === fs) fs.setRgPath(rgPath);
      })
      .catch((error: unknown) => {
        logger.debug('ripgrep unavailable, file search uses BFS:', error);
      });
  }

  private registerHandlers(ctx: WebFeatureContext): void {
    const { inbound } = ctx;
    const withPath =
      (
        handler: (path: string, message: ClientMessage, ws: WebSocket) => void,
      ) =>
      (message: ClientMessage, ws: WebSocket) => {
        const path = readString(message, 'path');
        if (path) handler(path, message, ws);
      };

    inbound.on('file_tree_request', (message) => {
      void this.sendTree(readString(message, 'relativePath'));
    });
    inbound.on(
      'file_tree_children_request',
      withPath((path) => void this.sendChildren(path)),
    );
    inbound.on('file_tree_search_request', (message) => {
      const query = readString(message, 'query');
      if (query) void this.sendSearchResults(query);
    });
    inbound.on(
      'file_read_request',
      withPath((path) => void this.readFile(path)),
    );
    inbound.on('file_write_request', (message) => {
      const path = readString(message, 'path');
      const content = readString(message, 'content');
      if (path && content !== undefined) void this.writeFile(path, content);
    });
    inbound.on(
      'file_create_request',
      withPath(
        (path, message) =>
          void this.createFile(path, readString(message, 'content')),
      ),
    );
    inbound.on(
      'file_delete_request',
      withPath(
        (path, message) =>
          void this.deleteFile(path, readBoolean(message, 'recursive')),
      ),
    );
    inbound.on('file_rename_request', (message) => {
      const oldPath = readString(message, 'oldPath');
      const newPath = readString(message, 'newPath');
      if (oldPath && newPath) void this.renameFile(oldPath, newPath);
    });
    inbound.on(
      'file_open_system',
      withPath((path) => void this.openWithSystemDefault(path)),
    );
    inbound.on(
      'file_reveal_request',
      withPath((path) => void this.revealInFileManager(path)),
    );
    inbound.on(
      'file_watch_request',
      withPath(
        (path, message, ws) =>
          void this.watchFile(path, readString(message, 'content'), ws),
      ),
    );
    inbound.on(
      'file_unwatch_request',
      withPath((path, _message, ws) => {
        this.requireServices().fileWatcher.unwatchFile(path, ws);
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Tree + search
  // ---------------------------------------------------------------------

  private async sendTree(relativePath?: string): Promise<void> {
    const { fs } = this.requireServices();
    const target = relativePath || '.';
    try {
      const tree = await fs.getFileTree(
        target,
        FileSystemService.TREE_DEFAULTS,
      );
      this.broadcast('file_tree_response', {
        tree,
        workspaceRoot: fs.getWorkspaceRoot(),
      });
    } catch (error) {
      this.reportError('tree', { path: target }, error);
    }
  }

  /** Lazy expand: children of one folder only. */
  private async sendChildren(relativePath: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      const children = await fs.getFileTree(
        relativePath,
        FileSystemService.TREE_DEFAULTS,
      );
      this.broadcast('file_tree_children_response', {
        path: relativePath,
        children,
        workspaceRoot: fs.getWorkspaceRoot(),
      });
    } catch (error) {
      this.ctx?.logger.error('Error reading folder children:', error);
      this.broadcast('file_tree_children_response', {
        path: relativePath,
        children: [],
        error: errorMessage(error),
      });
    }
  }

  private async sendSearchResults(query: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      const results = await fs.searchFiles(query);
      this.broadcast('file_tree_search_response', { query, results });
    } catch (error) {
      this.ctx?.logger.error('Error searching files:', error);
      this.broadcast('file_tree_search_response', {
        query,
        results: [],
        error: errorMessage(error),
      });
    }
  }

  // ---------------------------------------------------------------------
  // File operations
  // ---------------------------------------------------------------------

  private async readFile(path: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      this.broadcast('file_read_response', await fs.readFile(path));
    } catch (error) {
      this.reportError('read', { path }, error);
    }
  }

  private async writeFile(path: string, content: string): Promise<void> {
    const { fs, fileWatcher } = this.requireServices();
    try {
      // Tell the watcher this change is ours, not an external edit.
      fileWatcher.markExpectedChange(path, content);
      await fs.writeFile(path, content);
      this.broadcast('file_write_response', {
        success: true,
        path,
        message: 'File saved successfully',
      });
    } catch (error) {
      this.reportError('write', { path }, error);
    }
  }

  private async createFile(path: string, content?: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      await fs.createFile(path, content ?? '');
      this.broadcast('file_create_response', {
        success: true,
        path,
        message: 'File created successfully',
      });
      this.notifyDirectoryChanged(parentDirOf(path));
    } catch (error) {
      this.reportError('create', { path }, error);
    }
  }

  private async deleteFile(path: string, recursive?: boolean): Promise<void> {
    const { fs } = this.requireServices();
    try {
      await fs.deleteFile(path, recursive ?? false);
      this.broadcast('file_delete_response', {
        success: true,
        path,
        message: 'File deleted successfully',
      });
      this.notifyDirectoryChanged(parentDirOf(path));
    } catch (error) {
      this.reportError('delete', { path }, error);
    }
  }

  private async renameFile(oldPath: string, newPath: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      await fs.renameFile(oldPath, newPath);
      this.broadcast('file_rename_response', {
        success: true,
        oldPath,
        newPath,
        message: 'File renamed successfully',
      });
      const oldParent = parentDirOf(oldPath);
      const newParent = parentDirOf(newPath);
      this.notifyDirectoryChanged(oldParent);
      if (newParent !== oldParent) this.notifyDirectoryChanged(newParent);
    } catch (error) {
      this.reportError('rename', { oldPath, newPath }, error);
    }
  }

  private async openWithSystemDefault(path: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      await fs.openWithSystemDefault(path);
      this.broadcast('file_open_system_response', {
        success: true,
        path,
        message: 'File opened with system default application',
      });
    } catch (error) {
      this.reportError('open_system', { path }, error);
    }
  }

  private async revealInFileManager(path: string): Promise<void> {
    const { fs } = this.requireServices();
    try {
      await fs.revealInFileManager(path);
      this.broadcast('file_reveal_response', {
        success: true,
        path,
        message: 'File revealed in file explorer',
      });
    } catch (error) {
      this.reportError('reveal', { path }, error);
    }
  }

  private reportError(
    operation: string,
    target: Readonly<Record<string, string>>,
    error: unknown,
  ): void {
    this.ctx?.logger.error(`File ${operation} error:`, error);
    this.broadcast('file_operation_error', {
      operation,
      ...target,
      error: errorMessage(error),
    });
  }

  /** Clients re-request only the affected folder if they have it loaded. */
  private notifyDirectoryChanged(path: string): void {
    this.broadcast('directory_change_notification', { path: path || '.' });
  }

  // ---------------------------------------------------------------------
  // Watchers
  // ---------------------------------------------------------------------

  /** Watches the file for the requesting client only. */
  private async watchFile(
    path: string,
    content: string | undefined,
    ws: WebSocket,
  ): Promise<void> {
    const { fs, fileWatcher } = this.requireServices();

    let initialContent = content;
    if (initialContent === undefined || initialContent === '') {
      try {
        initialContent = (await fs.readFile(path)).content;
      } catch (error) {
        this.ctx?.logger.error(`Failed to read file for watch: ${path}`, error);
        this.send(ws, 'file_watch_error', {
          path,
          error: errorMessage(error),
        });
        return;
      }
    }

    try {
      await fileWatcher.watchFile(path, ws, initialContent);
    } catch (error) {
      this.ctx?.logger.error(`Failed to watch file ${path}:`, error);
    }
  }

  private wireFileWatcher(fileWatcher: FileWatcherService): void {
    const sendToWatchers = (
      type:
        | 'file_external_change'
        | 'file_external_delete'
        | 'file_watch_error',
      event: FileWatchEvent,
      data: Readonly<Record<string, unknown>>,
    ) => {
      this.ctx?.broadcaster.sendTo(event.clients, type, data);
    };

    fileWatcher.on('file-external-change', (event: FileWatchEvent) => {
      sendToWatchers('file_external_change', event, {
        path: event.path,
        diskContent: event.diskContent,
        diskStats: event.diskStats,
      });
    });
    fileWatcher.on('file-external-delete', (event: FileWatchEvent) => {
      sendToWatchers('file_external_delete', event, { path: event.path });
    });
    fileWatcher.on('watch-error', (event: FileWatchEvent) => {
      sendToWatchers('file_watch_error', event, {
        path: event.path,
        error: event.error,
      });
    });
  }

  private wireDirectoryWatcher(
    directoryWatcher: DirectoryWatcherService,
    logger: WebLogger,
  ): void {
    // The watcher fires for the changed entry; clients care about its folder.
    directoryWatcher.on('directory-change', (event: DirectoryChangeEvent) => {
      this.notifyDirectoryChanged(parentDirOf(event.path || '.'));
    });
    directoryWatcher.on('error', (error: Error) => {
      logger.error('Directory watcher error:', error);
    });
  }
}
