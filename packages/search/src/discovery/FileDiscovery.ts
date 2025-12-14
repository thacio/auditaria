/**
 * File discovery system.
 * Finds files to index while respecting .gitignore and configuration.
 */

import { readFile, stat } from 'node:fs/promises';
import { join, relative, basename, extname, resolve } from 'node:path';
import fg from 'fast-glob';
// The 'ignore' module has complex ESM/CJS interop - use dynamic type handling
import ignoreFactory from 'ignore';

// Define the Ignore interface for type safety
interface Ignore {
  add(pattern: string | string[]): Ignore;
  ignores(path: string): boolean;
}

// Create a factory function that handles ESM/CJS interop at runtime
function createIgnore(): Ignore {
  const factory =
    (ignoreFactory as unknown as { default?: () => Ignore }).default ||
    ignoreFactory;
  if (typeof factory === 'function') {
    return (factory as () => Ignore)();
  }
  throw new Error('ignore module not properly loaded');
}
import type { DiscoveredFile } from '../types.js';

// ============================================================================
// Types
// ============================================================================

export interface DiscoveryOptions {
  /** Root directory to search */
  rootPath: string;
  /** Additional paths to ignore (glob patterns) */
  ignorePaths?: string[];
  /** If set, only index files matching these patterns */
  includePatterns?: string[];
  /** File extensions to include (with leading dot) */
  fileTypes?: string[];
  /** Skip files larger than this (in bytes) */
  maxFileSize?: number;
  /** Respect .gitignore file */
  respectGitignore?: boolean;
}

export interface FileDiscoveryStats {
  /** Total files discovered */
  totalFiles: number;
  /** Files skipped due to size */
  skippedBySize: number;
  /** Files skipped by gitignore */
  skippedByGitignore: number;
  /** Total size of discovered files */
  totalSize: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_IGNORE_PATHS = [
  'node_modules',
  '.git',
  '.auditaria',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  'venv',
  '.venv',
  'env',
  '.env.local',
  '*.log',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

const DEFAULT_FILE_TYPES = [
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
  '.msg',
  '.eml',
];

const DEFAULT_MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// ============================================================================
// FileDiscovery Class
// ============================================================================

/**
 * Discovers files for indexing while respecting ignore rules.
 */
export class FileDiscovery {
  private readonly rootPath: string;
  private readonly ignorePaths: string[];
  private readonly includePatterns: string[];
  private readonly fileTypes: Set<string>;
  private readonly maxFileSize: number;
  private readonly respectGitignore: boolean;
  private gitignore: Ignore | null = null;

  constructor(options: DiscoveryOptions) {
    this.rootPath = resolve(options.rootPath);
    this.ignorePaths = [
      ...DEFAULT_IGNORE_PATHS,
      ...(options.ignorePaths ?? []),
    ];
    this.includePatterns = options.includePatterns ?? [];
    this.fileTypes = new Set(
      (options.fileTypes ?? DEFAULT_FILE_TYPES).map((t) =>
        t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`,
      ),
    );
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.respectGitignore = options.respectGitignore ?? true;
  }

  /**
   * Load .gitignore rules if present.
   */
  private async loadGitignore(): Promise<void> {
    if (!this.respectGitignore || this.gitignore !== null) {
      return;
    }

    try {
      const gitignorePath = join(this.rootPath, '.gitignore');
      const content = await readFile(gitignorePath, 'utf-8');
      this.gitignore = createIgnore().add(content);
    } catch {
      // No .gitignore or can't read it - that's fine
      this.gitignore = createIgnore();
    }
  }

  /**
   * Check if a file should be ignored.
   */
  private shouldIgnore(relativePath: string): boolean {
    if (this.gitignore && this.gitignore.ignores(relativePath)) {
      return true;
    }
    return false;
  }

  /**
   * Check if a file matches the allowed file types.
   */
  private isAllowedFileType(filePath: string): boolean {
    if (this.fileTypes.size === 0) return true;

    const ext = extname(filePath).toLowerCase();
    return this.fileTypes.has(ext);
  }

  /**
   * Calculate file hash using xxhash.
   */
  private async calculateHash(filePath: string): Promise<string> {
    try {
      const xxhashModule = (await import('xxhash-wasm')) as unknown as {
        default?: {
          xxhash64: () => Promise<{
            update(data: Buffer): { digest(enc: string): string };
          }>;
        };
        xxhash64?: () => Promise<{
          update(data: Buffer): { digest(enc: string): string };
        }>;
      };
      const xxhash64 = xxhashModule.default?.xxhash64 || xxhashModule.xxhash64;
      if (!xxhash64) throw new Error('xxhash64 not available');
      const content = await readFile(filePath);
      const hasher = await xxhash64();
      return hasher.update(content).digest('hex');
    } catch {
      // Fallback to file size + modified time as a pseudo-hash
      const stats = await stat(filePath);
      return `${stats.size}-${stats.mtimeMs}`;
    }
  }

  /**
   * Discover all files to index.
   *
   * @returns Array of discovered files
   */
  async discoverAll(): Promise<DiscoveredFile[]> {
    await this.loadGitignore();

    const files: DiscoveredFile[] = [];
    const stats: FileDiscoveryStats = {
      totalFiles: 0,
      skippedBySize: 0,
      skippedByGitignore: 0,
      totalSize: 0,
    };

    // Build glob pattern
    const patterns =
      this.includePatterns.length > 0 ? this.includePatterns : ['**/*'];

    // Run glob search
    const entries = await fg(patterns, {
      cwd: this.rootPath,
      absolute: true,
      onlyFiles: true,
      ignore: this.ignorePaths,
      dot: false, // Ignore hidden files by default
      followSymbolicLinks: false,
    });

    for (const absolutePath of entries) {
      stats.totalFiles++;

      const relativePath = relative(this.rootPath, absolutePath);

      // Check gitignore
      if (this.shouldIgnore(relativePath)) {
        stats.skippedByGitignore++;
        continue;
      }

      // Check file type
      if (!this.isAllowedFileType(absolutePath)) {
        continue;
      }

      // Get file stats
      let fileStats;
      try {
        fileStats = await stat(absolutePath);
      } catch {
        // Can't stat file - skip
        continue;
      }

      // Check file size
      if (fileStats.size > this.maxFileSize) {
        stats.skippedBySize++;
        continue;
      }

      // Calculate hash
      const hash = await this.calculateHash(absolutePath);

      files.push({
        absolutePath,
        relativePath,
        fileName: basename(absolutePath),
        extension: extname(absolutePath).toLowerCase(),
        size: fileStats.size,
        modifiedAt: fileStats.mtime,
        hash,
      });

      stats.totalSize += fileStats.size;
    }

    return files;
  }

  /**
   * Discover files as an async generator (for streaming).
   */
  async *discover(): AsyncGenerator<DiscoveredFile> {
    await this.loadGitignore();

    const patterns =
      this.includePatterns.length > 0 ? this.includePatterns : ['**/*'];

    const stream = fg.stream(patterns, {
      cwd: this.rootPath,
      absolute: true,
      onlyFiles: true,
      ignore: this.ignorePaths,
      dot: false,
      followSymbolicLinks: false,
    });

    for await (const entry of stream) {
      const absolutePath = entry.toString();
      const relativePath = relative(this.rootPath, absolutePath);

      // Check gitignore
      if (this.shouldIgnore(relativePath)) {
        continue;
      }

      // Check file type
      if (!this.isAllowedFileType(absolutePath)) {
        continue;
      }

      // Get file stats
      let fileStats;
      try {
        fileStats = await stat(absolutePath);
      } catch {
        continue;
      }

      // Check file size
      if (fileStats.size > this.maxFileSize) {
        continue;
      }

      // Calculate hash
      const hash = await this.calculateHash(absolutePath);

      yield {
        absolutePath,
        relativePath,
        fileName: basename(absolutePath),
        extension: extname(absolutePath).toLowerCase(),
        size: fileStats.size,
        modifiedAt: fileStats.mtime,
        hash,
      };
    }
  }

  /**
   * Get the root path being searched.
   */
  getRootPath(): string {
    return this.rootPath;
  }

  /**
   * Get the list of file types being searched.
   */
  getFileTypes(): string[] {
    return Array.from(this.fileTypes);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new FileDiscovery instance.
 */
export function createFileDiscovery(options: DiscoveryOptions): FileDiscovery {
  return new FileDiscovery(options);
}
