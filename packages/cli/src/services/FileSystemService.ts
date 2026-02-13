/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';

/**
 * Tree node representing a file or folder
 */
export interface TreeNode {
  label: string;           // File/folder name
  path: string;            // Relative path from workspace root
  type: 'file' | 'folder';
  size?: number;           // File size in bytes
  modified?: number;       // Last modified timestamp (ms)
  children?: TreeNode[];   // Child nodes for folders
  hasChildren?: boolean;   // For lazy loading: folder has children but not loaded yet
  totalChildren?: number;  // Total count when truncated
  truncated?: boolean;     // Children list was capped at maxChildren
}

/**
 * File content with metadata
 */
export interface FileContent {
  path: string;            // Relative path from workspace root
  content: string;         // File content as UTF-8 string
  size: number;            // File size in bytes
  modified?: number;       // Last modified timestamp (ms)
}

/**
 * File system service for web interface
 *
 * Provides secure file system operations for the web interface:
 * - Directory tree traversal
 * - File reading with binary detection
 * - File writing with validation
 * - Path validation to prevent directory traversal attacks
 * - File size limits to prevent memory exhaustion
 *
 * Security features:
 * - All paths are validated to stay within workspace
 * - Binary files are detected and rejected
 * - File size limits enforced (10MB default)
 * - Common IDE folders are ignored (.git, node_modules, etc.)
 */
export class FileSystemService {
  private workspaceRoot: string;
  private maxFileSize: number;
  private ignoredPatterns: string[];
  private rgPath: string | null = null;

  /**
   * Create a new FileSystemService
   * @param workspaceRoot - Absolute path to workspace root directory
   * @param options - Optional configuration
   */
  constructor(
    workspaceRoot: string,
    options: {
      maxFileSize?: number;
      ignoredPatterns?: string[];
    } = {}
  ) {
    // Resolve workspace root to absolute path
    this.workspaceRoot = path.resolve(workspaceRoot);

    // Default max file size: 10MB
    this.maxFileSize = options.maxFileSize ?? (10 * 1024 * 1024);

    // Default ignored patterns
    this.ignoredPatterns = options.ignoredPatterns ?? [
      '.git',
      'node_modules',
      '.DS_Store',
      'Thumbs.db',
      '.idea',
      '.vscode',
      '__pycache__',
      '*.pyc',
      'dist',
      'build',
      '.cache',
      '.next',
      '.nuxt',
      'coverage',
      '.nyc_output',
      '.auditaria', // Config directory - contains knowledge-base.db with rapidly changing WAL files
      '.gemini', // Upstream config directory
      'tmp',
      'temp'
    ];
  }

  /**
   * Set ripgrep binary path for fast file search.
   * When set, searchFiles() uses ripgrep with BFS fallback.
   * @param rgPath - Absolute path to rg binary
   */
  setRgPath(rgPath: string): void {
    this.rgPath = rgPath;
  }

  /**
   * Get workspace root path
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /**
   * Get ignored patterns
   * Used by DirectoryWatcherService to match ignore rules
   * @returns Copy of ignored patterns array
   */
  getIgnoredPatterns(): string[] {
    return [...this.ignoredPatterns];
  }

  /**
   * Options for lazy tree loading
   */
  static readonly TREE_DEFAULTS = {
    maxDepth: 1,
    maxChildren: 500,
    searchMaxResults: 200,
    searchMaxDirsVisited: 5000,
  };

  /**
   * Get directory tree structure
   *
   * @param relativePath - Optional subdirectory path (relative to workspace root)
   * @param options - Lazy loading options (maxDepth, maxChildren, currentDepth)
   * @returns Array of tree nodes representing files and folders
   * @throws Error if path is invalid or outside workspace
   */
  async getFileTree(
    relativePath: string = '.',
    options: { maxDepth?: number; maxChildren?: number; currentDepth?: number } = {}
  ): Promise<TreeNode[]> {
    const maxDepth = options.maxDepth ?? Infinity;
    const maxChildren = options.maxChildren ?? Infinity;
    const currentDepth = options.currentDepth ?? 0;
    const absolutePath = this.validatePath(relativePath);

    try {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      const nodes: TreeNode[] = [];
      let totalValid = 0;

      for (const entry of entries) {
        // Skip ignored patterns
        if (this.shouldIgnore(entry.name)) {
          continue;
        }

        totalValid++;

        // If we've hit the cap, just keep counting for totalChildren
        if (nodes.length >= maxChildren) {
          continue;
        }

        const entryRelativePath = path.join(relativePath, entry.name);
        const absoluteEntryPath = path.join(absolutePath, entry.name);

        try {
          if (entry.isDirectory()) {
            if (currentDepth < maxDepth) {
              // Within depth limit — recurse
              const children = await this.getFileTree(entryRelativePath, {
                maxDepth,
                maxChildren,
                currentDepth: currentDepth + 1,
              });

              nodes.push({
                label: entry.name,
                path: entryRelativePath,
                type: 'folder',
                children,
              });
            } else {
              // At depth limit — don't recurse, just peek for children
              const hasChildren = await this.folderHasChildren(absoluteEntryPath);

              nodes.push({
                label: entry.name,
                path: entryRelativePath,
                type: 'folder',
                hasChildren,
              });
            }
          } else if (entry.isFile()) {
            // File node - get stats
            const stats = await fs.stat(absoluteEntryPath);

            nodes.push({
              label: entry.name,
              path: entryRelativePath,
              type: 'file',
              size: stats.size,
              modified: stats.mtimeMs,
            });
          }
          // Skip symlinks, sockets, etc.
        } catch (error: any) {
          // Silently skip ENOENT — file disappeared between readdir and stat (race condition with temp files)
          if (error.code !== 'ENOENT') {
            console.error(`Failed to process ${entry.name}:`, error);
          }
          continue;
        }
      }

      // Mark truncation if we capped the children list
      if (totalValid > maxChildren && nodes.length > 0) {
        // Tag the last node so the client can show "... and X more"
        const lastNode = nodes[nodes.length - 1]!;
        // We add truncation info as a synthetic node at the end instead
        nodes.push({
          label: `... and ${totalValid - maxChildren} more items`,
          path: path.join(relativePath, '__truncated__'),
          type: 'file',
          truncated: true,
          totalChildren: totalValid,
        });
      }

      // Sort: folders first, then alphabetically (but keep truncation indicator at end)
      nodes.sort((a, b) => {
        // Truncation indicator always goes last
        if (a.truncated) return 1;
        if (b.truncated) return -1;
        if (a.type !== b.type) {
          return a.type === 'folder' ? -1 : 1;
        }
        return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
      });

      return nodes;

    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Directory not found: ${relativePath}`);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error(`Permission denied: ${relativePath}`);
      }
      throw new Error(`Failed to read directory: ${error.message}`);
    }
  }

  /**
   * Lightweight check: does a folder contain any non-ignored children?
   * Used at depth limit to decide if the expand arrow should show.
   */
  private async folderHasChildren(absoluteFolderPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(absoluteFolderPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!this.shouldIgnore(entry.name) && (entry.isFile() || entry.isDirectory())) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Search files by name. Uses ripgrep when available for speed and regex support,
   * falls back to Node.js BFS traversal otherwise.
   *
   * The query is treated as a regex pattern. If the regex is invalid, it falls
   * back to case-insensitive substring matching.
   *
   * @param query - Search string (regex or plain substring)
   * @param maxResults - Maximum results to return
   * @returns Flat array of matching TreeNode items
   */
  async searchFiles(query: string, maxResults: number = FileSystemService.TREE_DEFAULTS.searchMaxResults): Promise<TreeNode[]> {
    if (this.rgPath) {
      try {
        return await this.searchFilesWithRg(query, maxResults);
      } catch (error) {
        console.error('Ripgrep search failed, falling back to BFS:', error);
      }
    }
    return this.searchFilesBFS(query, maxResults);
  }

  /**
   * Build a name matcher from a query string.
   * Tries regex first; falls back to case-insensitive substring.
   */
  private buildNameMatcher(query: string): (name: string) => boolean {
    try {
      const regex = new RegExp(query, 'i');
      return (name) => regex.test(name);
    } catch {
      const lower = query.toLowerCase();
      return (name) => name.toLowerCase().includes(lower);
    }
  }

  /**
   * Search files using ripgrep (fast, multi-threaded, respects .gitignore).
   * Spawns `rg --files` and filters output by name.
   *
   * Note: rg --files only lists files, not directories. This is acceptable
   * since users typically search for files. Directories matching the query
   * are found via BFS fallback when rg is unavailable.
   */
  private searchFilesWithRg(query: string, maxResults: number): Promise<TreeNode[]> {
    const matcher = this.buildNameMatcher(query);

    const args = [
      '--files',        // List files only (no content search)
      '--hidden',       // Include hidden files (we exclude specific ones below)
      '--threads', '4', // Multi-threaded for large directories
    ];

    // Add our custom ignore patterns as glob excludes
    for (const pattern of this.ignoredPatterns) {
      args.push('--glob', `!${pattern}`);
    }

    args.push(this.workspaceRoot);

    return new Promise<TreeNode[]>((resolve, reject) => {
      const results: TreeNode[] = [];
      const rg = spawn(this.rgPath!, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      let buffer = '';
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        // Process remaining buffer
        const lastLine = buffer.trim();
        if (lastLine && results.length < maxResults) {
          const basename = path.basename(lastLine);
          if (matcher(basename)) {
            results.push({
              label: basename,
              path: path.relative(this.workspaceRoot, lastLine),
              type: 'file',
            });
          }
        }
        resolve(results);
      };

      rg.stdout!.on('data', (chunk: Buffer) => {
        if (done) return;
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep last incomplete line

        for (const line of lines) {
          const filePath = line.trim();
          if (!filePath) continue;

          const basename = path.basename(filePath);
          if (matcher(basename)) {
            results.push({
              label: basename,
              path: path.relative(this.workspaceRoot, filePath),
              type: 'file',
            });

            if (results.length >= maxResults) {
              done = true;
              rg.kill();
              resolve(results);
              return;
            }
          }
        }
      });

      rg.on('close', finish);
      rg.on('error', (err) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });

      // Timeout: resolve with partial results after 10 seconds
      setTimeout(() => {
        if (!done) {
          done = true;
          rg.kill();
          resolve(results);
        }
      }, 10000);
    });
  }

  /**
   * Search files by name using BFS through directories (fallback when rg is unavailable).
   * Supports regex patterns — falls back to substring match on invalid regex.
   */
  private async searchFilesBFS(query: string, maxResults: number): Promise<TreeNode[]> {
    const matcher = this.buildNameMatcher(query);
    const results: TreeNode[] = [];
    const queue: string[] = ['.'];
    const maxDirs = FileSystemService.TREE_DEFAULTS.searchMaxDirsVisited;
    let queueIdx = 0;

    while (queueIdx < queue.length && results.length < maxResults && queueIdx < maxDirs) {
      const currentRelPath = queue[queueIdx++];
      const absolutePath = this.validatePath(currentRelPath);

      let entries;
      try {
        entries = await fs.readdir(absolutePath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (this.shouldIgnore(entry.name)) continue;
        if (results.length >= maxResults) break;

        const entryRelPath = path.join(currentRelPath, entry.name);

        if (entry.isDirectory()) {
          queue.push(entryRelPath);
          if (matcher(entry.name)) {
            results.push({ label: entry.name, path: entryRelPath, type: 'folder' });
          }
        } else if (entry.isFile() && matcher(entry.name)) {
          results.push({ label: entry.name, path: entryRelPath, type: 'file' });
        }
      }
    }

    return results;
  }

  /**
   * Read file contents
   *
   * @param relativePath - File path relative to workspace root
   * @returns File content and metadata
   * @throws Error if file doesn't exist, is binary, too large, or access denied
   */
  async readFile(relativePath: string): Promise<FileContent> {
    const absolutePath = this.validatePath(relativePath);

    try {
      const stats = await fs.stat(absolutePath);

      // Verify it's a file (not directory)
      if (!stats.isFile()) {
        throw new Error('Path is not a file');
      }

      // Check file size limit
      if (stats.size > this.maxFileSize) {
        const maxSizeMB = (this.maxFileSize / 1024 / 1024).toFixed(1);
        throw new Error(`File is too large (max ${maxSizeMB}MB)`);
      }

      // Read file as buffer first
      const buffer = await fs.readFile(absolutePath);

      // Detect binary files
      if (this.isBinary(buffer)) {
        throw new Error('Binary files are not supported in the editor');
      }

      // Convert to UTF-8 string
      const content = buffer.toString('utf-8');

      return {
        path: relativePath,
        content,
        size: stats.size,
        modified: stats.mtimeMs
      };

    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`File not found: ${relativePath}`);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error(`Permission denied: ${relativePath}`);
      }
      // Re-throw our custom errors
      if (error.message.includes('too large') ||
          error.message.includes('Binary') ||
          error.message.includes('not a file')) {
        throw error;
      }
      throw new Error(`Failed to read file: ${error.message}`);
    }
  }

  /**
   * Write file contents
   *
   * @param relativePath - File path relative to workspace root
   * @param content - File content to write (UTF-8 string)
   * @throws Error if path is invalid, access denied, or disk full
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const absolutePath = this.validatePath(relativePath);

    try {
      // Ensure parent directory exists
      const directory = path.dirname(absolutePath);
      await fs.mkdir(directory, { recursive: true });

      // Write file
      await fs.writeFile(absolutePath, content, 'utf-8');

    } catch (error: any) {
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error(`Permission denied: ${relativePath}`);
      }
      if (error.code === 'ENOSPC') {
        throw new Error('No space left on device');
      }
      if (error.code === 'EROFS') {
        throw new Error('File system is read-only');
      }
      throw new Error(`Failed to write file: ${error.message}`);
    }
  }

  /**
   * Create a new file
   *
   * @param relativePath - File path relative to workspace root
   * @param content - Initial file content (optional, defaults to empty string)
   * @throws Error if file already exists or path is invalid
   */
  async createFile(relativePath: string, content: string = ''): Promise<void> {
    const absolutePath = this.validatePath(relativePath);

    try {
      // Check if file already exists
      const exists = await this.fileExists(absolutePath);
      if (exists) {
        throw new Error(`File already exists: ${relativePath}`);
      }

      // Ensure parent directory exists
      const directory = path.dirname(absolutePath);
      await fs.mkdir(directory, { recursive: true });

      // Create file
      await fs.writeFile(absolutePath, content, 'utf-8');

    } catch (error: any) {
      if (error.message.includes('already exists')) {
        throw error;
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error(`Permission denied: ${relativePath}`);
      }
      throw new Error(`Failed to create file: ${error.message}`);
    }
  }

  /**
   * Delete a file or directory
   *
   * @param relativePath - Path to delete (relative to workspace root)
   * @param recursive - If true, recursively delete directories (default: false)
   * @throws Error if path doesn't exist or access denied
   */
  async deleteFile(relativePath: string, recursive: boolean = false): Promise<void> {
    const absolutePath = this.validatePath(relativePath);

    try {
      const stats = await fs.stat(absolutePath);

      if (stats.isDirectory()) {
        await fs.rm(absolutePath, { recursive });
      } else {
        await fs.unlink(absolutePath);
      }

    } catch (error: any) {
      if (error.code === 'ENOENT') {
        throw new Error(`Path not found: ${relativePath}`);
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error(`Permission denied: ${relativePath}`);
      }
      if (error.code === 'ENOTEMPTY') {
        throw new Error('Directory is not empty (use recursive option)');
      }
      throw new Error(`Failed to delete: ${error.message}`);
    }
  }

  /**
   * Rename or move a file/directory
   *
   * @param oldPath - Current path (relative to workspace root)
   * @param newPath - New path (relative to workspace root)
   * @throws Error if source doesn't exist or destination exists
   */
  async renameFile(oldPath: string, newPath: string): Promise<void> {
    const absoluteOldPath = this.validatePath(oldPath);
    const absoluteNewPath = this.validatePath(newPath);

    try {
      // Check if source exists
      const exists = await this.fileExists(absoluteOldPath);
      if (!exists) {
        throw new Error(`Source not found: ${oldPath}`);
      }

      // Check if destination already exists
      const destExists = await this.fileExists(absoluteNewPath);
      if (destExists) {
        throw new Error(`Destination already exists: ${newPath}`);
      }

      // Ensure destination directory exists
      const directory = path.dirname(absoluteNewPath);
      await fs.mkdir(directory, { recursive: true });

      // Rename/move
      await fs.rename(absoluteOldPath, absoluteNewPath);

    } catch (error: any) {
      if (error.message.includes('not found') || error.message.includes('already exists')) {
        throw error;
      }
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        throw new Error('Permission denied');
      }
      if (error.code === 'EXDEV') {
        throw new Error('Cannot move across file systems');
      }
      throw new Error(`Failed to rename: ${error.message}`);
    }
  }

  /**
   * Validate that a path is within the workspace
   * Prevents directory traversal attacks
   *
   * @param relativePath - User-provided path (may be malicious)
   * @returns Validated absolute path
   * @throws Error if path is outside workspace or contains invalid characters
   */
  private validatePath(relativePath: string): string {
    // Security: Reject null bytes
    if (relativePath.includes('\0')) {
      throw new Error('Invalid file path: contains null bytes');
    }

    // Security: Reject empty paths
    if (!relativePath || relativePath.trim() === '') {
      throw new Error('Invalid file path: path is empty');
    }

    // Normalize path separators (handle Windows and Unix)
    const normalized = relativePath.replace(/\\/g, '/');

    // Resolve to absolute path
    const absolutePath = path.resolve(this.workspaceRoot, normalized);

    // Security: Verify path is within workspace
    // Use path.relative to detect if we need to traverse up (..)
    const relative = path.relative(this.workspaceRoot, absolutePath);

    // Check if path goes outside workspace
    const isInside = !relative.startsWith('..') && !path.isAbsolute(relative);

    if (!isInside) {
      throw new Error('Path is outside workspace boundary');
    }

    return absolutePath;
  }

  /**
   * Detect if buffer contains binary data
   * Uses null byte detection heuristic
   *
   * @param buffer - File buffer to check
   * @returns true if likely binary, false if likely text
   */
  private isBinary(buffer: Buffer): boolean {
    // Check first 8000 bytes for null bytes
    // Text files should not contain null bytes
    const chunk = buffer.slice(0, Math.min(8000, buffer.length));

    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if file/folder should be ignored
   * Matches against ignore patterns (supports wildcards)
   *
   * @param name - File or folder name
   * @returns true if should be ignored
   */
  private shouldIgnore(name: string): boolean {
    return this.ignoredPatterns.some(pattern => {
      if (pattern.includes('*')) {
        // Convert glob pattern to regex
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return regex.test(name);
      }
      // Exact match
      return name === pattern;
    });
  }

  /**
   * Check if file exists
   *
   * @param absolutePath - Absolute file path
   * @returns true if exists, false otherwise
   */
  private async fileExists(absolutePath: string): Promise<boolean> {
    try {
      await fs.access(absolutePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file statistics
   *
   * @param relativePath - File path relative to workspace root
   * @returns File stats or null if doesn't exist
   */
  async getFileStats(relativePath: string): Promise<{
    size: number;
    modified: number;
    created: number;
    isFile: boolean;
    isDirectory: boolean;
  } | null> {
    const absolutePath = this.validatePath(relativePath);

    try {
      const stats = await fs.stat(absolutePath);
      return {
        size: stats.size,
        modified: stats.mtimeMs,
        created: stats.birthtimeMs,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory()
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Open file with system default application
   *
   * @param relativePath - File path relative to workspace root
   * @throws Error if file doesn't exist, path invalid, or command fails
   */
  async openWithSystemDefault(relativePath: string): Promise<void> {
    const absolutePath = this.validatePath(relativePath);

    try {
      // Check if file exists
      const exists = await this.fileExists(absolutePath);
      if (!exists) {
        throw new Error(`File not found: ${relativePath}`);
      }

      // Use dynamic import for child_process to avoid bundling issues
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);

      // Platform-specific command
      let command: string;
      const platform = process.platform;

      if (platform === 'win32') {
        // Windows: Use 'start' command
        // Quote the path and use empty string as window title
        command = `cmd /c start "" "${absolutePath}"`;
      } else if (platform === 'darwin') {
        // macOS: Use 'open' command
        command = `open "${absolutePath}"`;
      } else {
        // Linux: Use 'xdg-open' command
        command = `xdg-open "${absolutePath}"`;
      }

      await execAsync(command);

    } catch (error: any) {
      if (error.message.includes('not found')) {
        throw error;
      }
      if (error.code === 'ENOENT' || error.message.includes('command not found')) {
        throw new Error('System command not available on this platform');
      }
      throw new Error(`Failed to open file: ${error.message}`);
    }
  }

  /**
   * Reveal file/folder in system file manager
   *
   * @param relativePath - File/folder path relative to workspace root
   * @throws Error if path doesn't exist, invalid, or command fails
   */
  async revealInFileManager(relativePath: string): Promise<void> {
    const absolutePath = this.validatePath(relativePath);

    try {
      // Check if path exists
      const exists = await this.fileExists(absolutePath);
      if (!exists) {
        throw new Error(`Path not found: ${relativePath}`);
      }

      // Platform-specific command
      const platform = process.platform;

      if (platform === 'win32') {
        // Windows: Use spawn for fire-and-forget execution (avoids stderr/exit code issues)
        const { spawn } = await import('node:child_process');
        const stats = await fs.stat(absolutePath);

        if (stats.isDirectory()) {
          // For folders: open inside the folder
          spawn('explorer', [absolutePath], { detached: true, stdio: 'ignore' });
        } else {
          // For files: select the file in its parent folder
          spawn('explorer', ['/select,', absolutePath], { detached: true, stdio: 'ignore' });
        }

        // For Windows, we don't wait for explorer to finish
        return;
      }

      // For macOS and Linux, use exec
      const { exec } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(exec);

      let command: string;

      if (platform === 'darwin') {
        // macOS: Use 'open -R' to reveal in Finder
        command = `open -R "${absolutePath}"`;
      } else {
        // Linux: Try common file managers, fallback to opening parent directory
        // Check for common file managers
        const stats = await fs.stat(absolutePath);
        const targetPath = stats.isDirectory() ? absolutePath : path.dirname(absolutePath);

        // Try nautilus (GNOME), dolphin (KDE), or xdg-open as fallback
        try {
          // Try nautilus first (GNOME)
          await execAsync(`which nautilus`);
          command = `nautilus "${targetPath}"`;
        } catch {
          try {
            // Try dolphin (KDE)
            await execAsync(`which dolphin`);
            command = `dolphin --select "${absolutePath}"`;
          } catch {
            // Fallback to xdg-open with parent directory
            command = `xdg-open "${targetPath}"`;
          }
        }
      }

      await execAsync(command);

    } catch (error: any) {
      if (error.message.includes('not found')) {
        throw error;
      }
      if (error.code === 'ENOENT' || error.message.includes('command not found')) {
        throw new Error('File manager command not available on this platform');
      }
      throw new Error(`Failed to reveal in file manager: ${error.message}`);
    }
  }
}
