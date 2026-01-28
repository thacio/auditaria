/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterface,
} from '@electric-sql/pglite';
import type {
  StorageAdapter,
  CreateDocumentInput,
  UpdateDocumentInput,
  CreateChunkInput,
  UpdateChunkEmbeddingInput,
  CreateQueueItemInput,
  UpdateQueueItemInput,
  HybridSearchWeights,
  KeywordSearchOptions,
} from './types.js';
import type {
  Document,
  DocumentChunk,
  SearchFilters,
  SearchResult,
  SearchStats,
  TagCount,
  QueueItem,
  QueuePriority,
  QueueStatus,
} from '../types.js';
import {
  SCHEMA_SQL,
  FTS_INDEX_SQL,
  HNSW_INDEX_SQL,
  UPDATE_FTS_VECTOR_SQL,
} from './schema.js';
import type { DatabaseConfig } from '../config.js';
import { createModuleLogger } from '../core/Logger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const log = createModuleLogger('PGliteStorage');

// ============================================================================
// Backup Constants
// ============================================================================

/** Maximum database size for automatic backup (300MB) */
const BACKUP_MAX_SIZE_BYTES = 300 * 1024 * 1024;

/** Suffix for backup directory */
const BACKUP_SUFFIX = '.backup';

// ============================================================================
// Corruption Detection
// ============================================================================

/**
 * Check if an error is likely due to database corruption.
 * These errors typically occur when PGlite can't recover from WAL.
 */
function isLikelyCorruptionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('PANIC:') ||
    message.includes('could not locate a valid checkpoint record') ||
    (message.includes('Aborted') && message.includes('-sASSERTIONS'))
  );
}

// ============================================================================
// Bun Executable Detection and Asset Management
// ============================================================================

/**
 * Check if we're running inside a Bun compiled executable.
 * In Bun executables, import.meta.url points to the virtual filesystem.
 */
function isRunningInBunExecutable(): boolean {
  // Check for Bun runtime
  if (typeof (globalThis as Record<string, unknown>).Bun === 'undefined') {
    return false;
  }

  // Check for embedded assets indicator (set by build script)
  if ((globalThis as Record<string, unknown>).__PGLITE_EMBEDDED_ASSETS) {
    return true;
  }

  // Check for Bun's virtual filesystem path patterns
  try {
    const metaUrl = import.meta.url;
    if (
      metaUrl.includes('/$bunfs/') ||
      metaUrl.includes('/~BUN/') ||
      metaUrl.includes('%7EBUN')
    ) {
      return true;
    }
  } catch {
    // Ignore errors
  }

  return false;
}

/**
 * Get the path where PGlite assets should be extracted/stored.
 * Uses .auditaria/pglite-assets/ in the user's home directory.
 */
function getPGliteAssetsPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
  return path.join(homeDir, '.auditaria', 'pglite-assets');
}

/**
 * Extract embedded PGlite assets to the filesystem.
 * This is needed for Bun compiled executables where the assets
 * can't be loaded from the virtual filesystem.
 */
async function extractPGliteAssets(): Promise<{
  wasmPath: string;
  dataPath: string;
  vectorPath: string;
} | null> {
  const assetsPath = getPGliteAssetsPath();

  // Check for embedded assets from build script
  const embeddedAssets = (globalThis as Record<string, unknown>)
    .__PGLITE_EMBEDDED_ASSETS as
    | {
        wasm?: string; // Base64 encoded
        data?: string; // Base64 encoded
        vector?: string; // Base64 encoded
      }
    | undefined;

  if (!embeddedAssets) {
    log.warn('extractPGliteAssets:noEmbeddedAssets', {});
    return null;
  }

  // Ensure the assets directory exists
  if (!fs.existsSync(assetsPath)) {
    fs.mkdirSync(assetsPath, { recursive: true });
  }

  const wasmPath = path.join(assetsPath, 'pglite.wasm');
  const dataPath = path.join(assetsPath, 'pglite.data');
  const vectorPath = path.join(assetsPath, 'vector.tar.gz');

  // Extract assets if they don't exist or are outdated
  const versionFile = path.join(assetsPath, 'version.txt');
  const currentVersion = embeddedAssets.wasm?.substring(0, 32) || 'unknown';
  let needsExtraction = true;

  if (fs.existsSync(versionFile)) {
    try {
      const storedVersion = fs.readFileSync(versionFile, 'utf-8').trim();
      if (
        storedVersion === currentVersion &&
        fs.existsSync(wasmPath) &&
        fs.existsSync(dataPath) &&
        fs.existsSync(vectorPath)
      ) {
        needsExtraction = false;
        log.debug('extractPGliteAssets:cached', { assetsPath });
      }
    } catch {
      // Ignore errors, will re-extract
    }
  }

  if (needsExtraction) {
    log.info('extractPGliteAssets:extracting', { assetsPath });

    try {
      if (embeddedAssets.wasm) {
        fs.writeFileSync(wasmPath, Buffer.from(embeddedAssets.wasm, 'base64'));
      }
      if (embeddedAssets.data) {
        fs.writeFileSync(dataPath, Buffer.from(embeddedAssets.data, 'base64'));
      }
      if (embeddedAssets.vector) {
        fs.writeFileSync(
          vectorPath,
          Buffer.from(embeddedAssets.vector, 'base64'),
        );
      }
      fs.writeFileSync(versionFile, currentVersion);

      log.info('extractPGliteAssets:complete', { assetsPath });
    } catch (error) {
      log.error('extractPGliteAssets:failed', { error: String(error) });
      return null;
    }
  }

  return { wasmPath, dataPath, vectorPath };
}

/**
 * Create a custom vector extension that uses an absolute path for the bundle.
 * This is needed for Bun compiled executables.
 */
function createCustomVectorExtension(bundlePath: string): Extension {
  const setup = async (
    _pg: PGliteInterface,
    emscriptenOpts: unknown,
  ): Promise<ExtensionSetupResult> => ({
    emscriptenOpts,
    bundlePath: new URL(`file://${bundlePath.replace(/\\/g, '/')}`),
  });

  return {
    name: 'pgvector',
    setup,
  };
}

/**
 * Load PGlite options for Bun executable environment.
 * Returns wasmModule and fsBundle loaded from extracted assets.
 */
async function loadPGliteOptionsForBun(assets: {
  wasmPath: string;
  dataPath: string;
}): Promise<{
  wasmModule: WebAssembly.Module;
  fsBundle: Blob;
}> {
  const [wasmBuffer, dataBuffer] = await Promise.all([
    fs.promises.readFile(assets.wasmPath),
    fs.promises.readFile(assets.dataPath),
  ]);

  const wasmModule = await WebAssembly.compile(wasmBuffer);
  const fsBundle = new Blob([dataBuffer]);

  return { wasmModule, fsBundle };
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Yield to the event loop to prevent blocking */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** How often to yield during batch operations */
const YIELD_EVERY_N_ITEMS = 50;

function generateId(): string {
  return crypto.randomUUID();
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function formatVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

// ============================================================================
// Row Types (database representation)
// ============================================================================

interface DocumentRow {
  id: string;
  file_path: string;
  file_name: string;
  file_extension: string;
  file_size: string | number;
  file_hash: string;
  mime_type: string | null;
  title: string | null;
  author: string | null;
  language: string | null;
  page_count: number | null;
  status: string;
  ocr_status: string;
  indexed_at: string | null;
  file_modified_at: string;
  created_at: string;
  updated_at: string;
  metadata: Record<string, unknown> | string;
}

interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  embedding: string | null;
  start_offset: number;
  end_offset: number;
  page: number | null;
  section: string | null;
  token_count: number | null;
  created_at: string;
}

interface QueueItemRow {
  id: string;
  file_path: string;
  file_size: string | number;
  priority: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface TagRow {
  id: string;
  name: string;
  created_at: string;
}

interface TagCountRow {
  tag: string;
  count: string | number;
}

interface StatsRow {
  total_documents: string | number;
  indexed_documents: string | number;
  pending_documents: string | number;
  failed_documents: string | number;
  ocr_pending: string | number;
  total_file_size: string | number;
}

interface SearchResultRow {
  chunk_id: string;
  document_id: string;
  file_path: string;
  file_name: string;
  chunk_text: string;
  highlighted_text?: string; // PostgreSQL ts_headline output (keyword search only)
  page: number | null;
  section: string | null;
  score: number;
  match_type: string;
}

// ============================================================================
// PGlite Storage Adapter
// ============================================================================

export class PGliteStorage implements StorageAdapter {
  private db: PGlite | null = null;
  private config: DatabaseConfig;
  private _initialized = false;
  private timerCounter = 0; // Counter for unique timer keys in concurrent operations
  private _reconnecting = false; // Flag to indicate reconnection in progress
  private _reconnectPromise: Promise<void> | null = null; // Promise to wait for reconnection
  private _dirty = false; // Tracks if database has been modified since last backup

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a PGlite instance, handling Bun executable environments.
   * This is a helper method used by both initialize() and reconnect().
   */
  private async createPGliteInstance(): Promise<PGlite> {
    const isBunExe = isRunningInBunExecutable();

    if (isBunExe) {
      log.info('createPGliteInstance:bunExecutableDetected', {});

      // Extract embedded assets
      const assets = await extractPGliteAssets();

      if (assets) {
        // Load WASM module and filesystem bundle from extracted files
        const { wasmModule, fsBundle } = await loadPGliteOptionsForBun(assets);

        // Create custom vector extension with absolute path
        const customVector = createCustomVectorExtension(assets.vectorPath);

        // Initialize PGlite with custom options for Bun executable
        // Note: amcheck is included for integrity checks; it may not work in Bun executable
        // but will gracefully degrade in checkIntegrity()
        const db = await PGlite.create({
          dataDir: this.config.inMemory ? undefined : this.config.path,
          wasmModule,
          fsBundle,
          extensions: { vector: customVector, amcheck },
        });

        log.info('createPGliteInstance:bunExecutableInitialized', {
          assetsPath: getPGliteAssetsPath(),
        });
        return db;
      } else {
        // Fallback: Try standard initialization (may fail in Bun executable)
        log.warn('createPGliteInstance:noEmbeddedAssets:tryingStandard', {});
      }
    }

    // Standard initialization for Node.js/development
    return PGlite.create({
      dataDir: this.config.inMemory ? undefined : this.config.path,
      extensions: { vector, amcheck },
    });
  }

  async initialize(): Promise<void> {
    if (this._initialized) return;

    const dbPath = this.config.path || 'in-memory';
    const backupPath = this.config.path
      ? `${this.config.path}${BACKUP_SUFFIX}`
      : null;

    // Create PGlite instance (handles Bun executable environment)
    try {
      this.db = await this.createPGliteInstance();
    } catch (error) {
      if (isLikelyCorruptionError(error)) {
        const originalError =
          error instanceof Error ? error.message : String(error);
        log.warn('initialize:corruption_detected', { error: originalError });

        // Attempt auto-recovery from backup if available
        if (backupPath && fs.existsSync(backupPath)) {
          log.info('initialize:attempting_recovery_from_backup');
          /* eslint-disable no-console */
          console.warn('[KnowledgeBase] ⚠️  Database corruption detected!');
          console.warn(
            '[KnowledgeBase] Cause: Application was likely closed during database operations.',
          );
          console.warn(
            '[KnowledgeBase] Attempting automatic recovery from backup...',
          );
          /* eslint-enable no-console */

          try {
            // Remove corrupted database and restore from backup
            await this.removeDirectory(dbPath);
            await this.copyDirectory(backupPath, dbPath);
            log.info('initialize:backup_restored');

            // Retry initialization with restored database
            try {
              this.db = await this.createPGliteInstance();
              /* eslint-disable no-console */
              console.warn(
                '[KnowledgeBase] ✓ Successfully recovered from backup!',
              );
              console.warn(
                '[KnowledgeBase] Note: Some recent changes may have been lost. Run `/knowledge-base init` to reindex.',
              );
              /* eslint-enable no-console */
              log.info('initialize:recovery_successful');
            } catch (retryError) {
              // Recovery failed - backup might also be corrupted
              const retryErrorMsg =
                retryError instanceof Error
                  ? retryError.message
                  : String(retryError);
              log.error('initialize:recovery_failed', { error: retryErrorMsg });
              throw new Error(
                `Knowledge base database is corrupted and recovery from backup failed.\n\n` +
                  `This may happen if the backup was also corrupted.\n\n` +
                  `To fix this issue:\n` +
                  `  1. Delete the database folder: ${dbPath}\n` +
                  `  2. Delete the backup folder: ${backupPath}\n` +
                  `  3. Run '/knowledge-base init' to rebuild the index\n\n` +
                  `Original error: ${originalError}\n` +
                  `Recovery error: ${retryErrorMsg}`,
              );
            }
          } catch (restoreError) {
            // Failed to restore backup files
            const restoreErrorMsg =
              restoreError instanceof Error
                ? restoreError.message
                : String(restoreError);
            log.error('initialize:restore_failed', { error: restoreErrorMsg });
            throw new Error(
              `Knowledge base database is corrupted and failed to restore backup.\n\n` +
                `To fix this issue:\n` +
                `  1. Delete the database folder: ${dbPath}\n` +
                `  2. Run '/knowledge-base init' to rebuild the index\n\n` +
                `Original error: ${originalError}\n` +
                `Restore error: ${restoreErrorMsg}`,
            );
          }
        } else {
          // No backup available
          throw new Error(
            `Knowledge base database appears to be corrupted.\n\n` +
              `This usually happens when the application was forcefully closed during database operations.\n` +
              `No backup is available for automatic recovery.\n\n` +
              `To fix this issue:\n` +
              `  1. Delete the database folder: ${dbPath}\n` +
              `  2. Run '/knowledge-base init' to rebuild the index\n\n` +
              `Original error: ${originalError}`,
          );
        }
      } else {
        throw error;
      }
    }

    // Run schema SQL
    await this.db.exec(SCHEMA_SQL);

    // Create FTS index
    try {
      await this.db.exec(FTS_INDEX_SQL);
    } catch {
      // FTS index might fail on first run, that's ok
    }

    // Create HNSW index
    try {
      await this.db.exec(HNSW_INDEX_SQL);
    } catch {
      // HNSW index creation might fail if no data, that's ok
    }

    // Mark as initialized (must be set before using methods that call ensureInitialized)
    this._initialized = true;

    // Store initialization timestamp
    await this.setConfigValue('initialized_at', new Date().toISOString());

    log.info('initialize:complete');
    log.logMemory('initialize:memoryAfter');
  }

  async close(): Promise<void> {
    if (this.db) {
      // Create backup before closing (non-blocking on failure)
      try {
        await this.createBackup();
      } catch (error) {
        log.warn('close:backup_failed', { error: String(error) });
      }

      // Close the database with timeout and defensive error handling
      // PGlite/WASM can sometimes hang or throw unusual values during shutdown
      const CLOSE_TIMEOUT_MS = 5000; // 5 second timeout
      try {
        await Promise.race([
          this.db.close(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('PGlite close() timed out')),
              CLOSE_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (error) {
        // Handle unusual error types (like Infinity from WASM) or timeout
        const errorMsg =
          error instanceof Error
            ? error.message
            : typeof error === 'number'
              ? `WASM numeric error: ${error}`
              : String(error);
        log.warn('close:db_close_error', { error: errorMsg });
        // Don't rethrow - we still want to clean up state
      }

      this.db = null;
      this._initialized = false;
      this._dirty = false;
    }
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Force a WAL checkpoint to flush data to disk and release memory.
   * Should be called periodically during long-running indexing operations.
   * Also runs VACUUM to reclaim space and ANALYZE to update statistics.
   */
  async checkpoint(): Promise<void> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `checkpoint-${timerId}`;
    log.startTimer(timerKey, true);
    log.logMemory('checkpoint:memoryBefore');

    try {
      // CHECKPOINT forces WAL to be written to disk
      await this.db!.exec('CHECKPOINT');
      // VACUUM reclaims storage and can help with memory
      await this.db!.exec('VACUUM');
      // ANALYZE updates statistics
      await this.db!.exec('ANALYZE');
      log.endTimer(timerKey, 'checkpoint:complete', {});
      log.logMemory('checkpoint:memoryAfter');
    } catch (error) {
      log.endTimer(timerKey, 'checkpoint:error', { error: String(error) });
      throw error;
    }
  }

  /**
   * Run VACUUM to reclaim space and reduce memory usage.
   * More aggressive than checkpoint, but slower.
   */
  async vacuum(): Promise<void> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `vacuum-${timerId}`;
    log.startTimer(timerKey, true);
    log.logMemory('vacuum:memoryBefore');

    try {
      await this.db!.exec('VACUUM');
      log.endTimer(timerKey, 'vacuum:complete', {});
      log.logMemory('vacuum:memoryAfter');
    } catch (error) {
      log.endTimer(timerKey, 'vacuum:error', { error: String(error) });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Backup & Recovery
  // -------------------------------------------------------------------------

  /**
   * Check if a backup exists for this database.
   */
  async backupExists(): Promise<boolean> {
    if (this.config.inMemory || !this.config.path) return false;
    const backupPath = `${this.config.path}${BACKUP_SUFFIX}`;
    return fs.existsSync(backupPath);
  }

  /**
   * Get the total size of a directory in bytes.
   */
  private async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await this.getDirectorySize(entryPath);
      } else if (entry.isFile()) {
        const stats = await fs.promises.stat(entryPath);
        totalSize += stats.size;
      }
    }

    return totalSize;
  }

  /**
   * Copy a directory recursively.
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });

    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else if (entry.isFile()) {
        await fs.promises.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * Remove a directory recursively.
   */
  private async removeDirectory(dirPath: string): Promise<void> {
    if (fs.existsSync(dirPath)) {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    }
  }

  /**
   * Check database integrity before backup.
   * Uses a hybrid approach:
   * 1. amcheck extension for structural integrity (B-tree indexes)
   * 2. Custom queries for data-level consistency
   *
   * @returns Object with valid flag and any errors found
   */
  async checkIntegrity(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check if amcheck extension is available
    let amcheckAvailable = false;
    try {
      const extResult = await this.db!.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM pg_extension WHERE extname = 'amcheck'`,
      );
      amcheckAvailable = parseInt(extResult.rows[0]?.count || '0', 10) > 0;
    } catch {
      // amcheck not available, skip structural checks
      log.debug('checkIntegrity:amcheck_not_available');
    }

    // 1. Structural integrity checks using amcheck (if available)
    if (amcheckAvailable) {
      try {
        // Check B-tree indexes on core tables (fast check)
        const indexes = await this.db!.query<{ oid: number; relname: string }>(`
          SELECT c.oid, c.relname
          FROM pg_index i
          JOIN pg_class c ON i.indexrelid = c.oid
          JOIN pg_class t ON i.indrelid = t.oid
          JOIN pg_am am ON c.relam = am.oid
          WHERE t.relname IN ('documents', 'chunks', 'index_queue', 'tags')
            AND am.amname = 'btree'
            AND c.relkind = 'i'
          LIMIT 10
        `);

        for (const idx of indexes.rows) {
          try {
            await this.db!.query(`SELECT bt_index_check($1)`, [idx.oid]);
          } catch (indexError) {
            if (isLikelyCorruptionError(indexError)) {
              errors.push(
                `Index corruption in ${idx.relname}: ${indexError instanceof Error ? indexError.message : String(indexError)}`,
              );
            }
            // Non-corruption errors (e.g., unsupported index type) are ignored
          }
        }
        log.debug('checkIntegrity:amcheck_completed', {
          indexesChecked: indexes.rows.length,
        });
      } catch (error) {
        if (isLikelyCorruptionError(error)) {
          errors.push(
            `Structural corruption detected: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // Other errors mean amcheck couldn't run, not corruption
        log.debug('checkIntegrity:amcheck_failed', { error: String(error) });
      }
    }

    // 2. Data-level consistency checks (always run)
    try {
      // Check core tables are readable (catches PANIC on corrupted data)
      await this.db!.query('SELECT 1 FROM documents LIMIT 1');
      await this.db!.query('SELECT 1 FROM chunks LIMIT 1');
      await this.db!.query('SELECT 1 FROM tags LIMIT 1');
      await this.db!.query('SELECT 1 FROM index_queue LIMIT 1');
    } catch (error) {
      if (isLikelyCorruptionError(error)) {
        errors.push(
          `Table corruption: ${error instanceof Error ? error.message : String(error)}`,
        );
      } else {
        errors.push(
          `Table read failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 3. Referential integrity: Check for orphaned chunks
    try {
      const orphanedChunks = await this.db!.query<{ count: string }>(`
        SELECT COUNT(*)::text as count FROM chunks c
        LEFT JOIN documents d ON c.document_id = d.id
        WHERE d.id IS NULL
      `);
      const orphanCount = parseInt(orphanedChunks.rows[0]?.count || '0', 10);
      if (orphanCount > 0) {
        errors.push(
          `Found ${orphanCount} orphaned chunks (no matching document)`,
        );
      }
    } catch (error) {
      if (isLikelyCorruptionError(error)) {
        errors.push(
          `Orphan check corruption: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 4. Consistency: Check indexed documents have chunks
    try {
      const missingChunks = await this.db!.query<{ count: string }>(`
        SELECT COUNT(*)::text as count FROM documents d
        WHERE d.status = 'indexed'
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_id = d.id)
      `);
      const missingCount = parseInt(missingChunks.rows[0]?.count || '0', 10);
      if (missingCount > 0) {
        // This is a warning, not necessarily corruption - could be empty files
        log.warn('checkIntegrity:indexed_docs_without_chunks', {
          count: missingCount,
        });
      }
    } catch (error) {
      if (isLikelyCorruptionError(error)) {
        errors.push(
          `Consistency check corruption: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const valid = errors.length === 0;
    if (!valid) {
      log.warn('checkIntegrity:failed', { errors });
    } else {
      log.debug('checkIntegrity:passed', { amcheckAvailable });
    }

    return { valid, errors };
  }

  /**
   * Create a backup of the database.
   * Only creates backup if:
   * - Database has been modified since last backup (dirty flag)
   * - Database is not empty (has documents)
   * - Database size is under 100MB
   * - Database passes integrity checks
   *
   * @returns true if backup was created, false if skipped
   */
  async createBackup(): Promise<boolean> {
    // Skip if backups are disabled
    if (this.config.backupEnabled === false) {
      log.debug('createBackup:skipped_disabled');
      return false;
    }

    // Skip for in-memory databases
    if (this.config.inMemory || !this.config.path) {
      log.debug('createBackup:skipped_in_memory');
      return false;
    }

    // Skip if no changes since last backup
    if (!this._dirty) {
      log.debug('createBackup:skipped_no_changes');
      return false;
    }

    // Skip if database is empty
    try {
      const docCount = await this.countDocuments();
      if (docCount === 0) {
        log.debug('createBackup:skipped_empty_database');
        return false;
      }
    } catch {
      // If we can't count documents, skip backup
      log.debug('createBackup:skipped_count_failed');
      return false;
    }

    const dbPath = this.config.path;
    const backupPath = `${dbPath}${BACKUP_SUFFIX}`;

    // Check database size
    let size: number;
    try {
      size = await this.getDirectorySize(dbPath);
      if (size > BACKUP_MAX_SIZE_BYTES) {
        log.debug('createBackup:skipped_too_large', {
          size,
          maxSize: BACKUP_MAX_SIZE_BYTES,
        });
        return false;
      }
    } catch {
      log.debug('createBackup:skipped_size_check_failed');
      return false;
    }

    // Verify database integrity before backup
    try {
      const integrity = await this.checkIntegrity();
      if (!integrity.valid) {
        log.warn('createBackup:skipped_integrity_failed', {
          errors: integrity.errors,
        });
        /* eslint-disable no-console */
        console.warn(
          '[KnowledgeBase] ⚠️  Backup skipped: database integrity check failed',
        );
        console.warn('[KnowledgeBase] Errors:', integrity.errors.join('; '));
        console.warn(
          '[KnowledgeBase] Run `/knowledge-base init` to rebuild the index.',
        );
        /* eslint-enable no-console */
        return false;
      }
    } catch (integrityError) {
      // If integrity check itself fails catastrophically, skip backup
      log.warn('createBackup:integrity_check_error', {
        error: String(integrityError),
      });
      return false;
    }

    const timerId = ++this.timerCounter;
    const timerKey = `createBackup-${timerId}`;
    log.startTimer(timerKey, true);

    try {
      // Checkpoint to flush WAL before backup
      await this.checkpoint();

      // Remove old backup and create new one
      await this.removeDirectory(backupPath);
      await this.copyDirectory(dbPath, backupPath);

      // Mark as clean (no changes since backup)
      this._dirty = false;

      log.endTimer(timerKey, 'createBackup:success', {
        size,
        path: backupPath,
      });
      return true;
    } catch (error) {
      log.endTimer(timerKey, 'createBackup:error', { error: String(error) });
      throw error;
    }
  }

  /**
   * Restore database from backup.
   * This should only be called when the main database is corrupted.
   *
   * @returns true if restored successfully, false if no backup or restore failed
   */
  async restoreFromBackup(): Promise<boolean> {
    if (this.config.inMemory || !this.config.path) {
      return false;
    }

    const dbPath = this.config.path;
    const backupPath = `${dbPath}${BACKUP_SUFFIX}`;

    if (!fs.existsSync(backupPath)) {
      log.info('restoreFromBackup:no_backup_found');
      return false;
    }

    const timerId = ++this.timerCounter;
    const timerKey = `restoreFromBackup-${timerId}`;
    log.startTimer(timerKey, true);

    try {
      // Remove corrupted database
      await this.removeDirectory(dbPath);

      // Copy backup to database location
      await this.copyDirectory(backupPath, dbPath);

      log.endTimer(timerKey, 'restoreFromBackup:success', { path: dbPath });
      return true;
    } catch (error) {
      log.endTimer(timerKey, 'restoreFromBackup:error', {
        error: String(error),
      });
      return false;
    }
  }

  /**
   * Reconnect to the database by closing and reopening the connection.
   * This is the most aggressive memory release option as it destroys the
   * WASM instance entirely, releasing all accumulated WASM memory.
   *
   * This method is safe to call even with concurrent operations - they will
   * wait for reconnection to complete before proceeding.
   */
  async reconnect(): Promise<void> {
    if (!this._initialized || !this.db) {
      // Not initialized, nothing to reconnect
      return;
    }

    // If already reconnecting, wait for that to complete
    if (this._reconnecting && this._reconnectPromise) {
      await this._reconnectPromise;
      return;
    }

    const timerId = ++this.timerCounter;
    const timerKey = `reconnect-${timerId}`;
    log.startTimer(timerKey, true);
    log.logMemory('reconnect:memoryBefore');

    // Set reconnecting flag and create a promise that others can wait on
    this._reconnecting = true;
    let resolveReconnect: () => void;
    this._reconnectPromise = new Promise<void>((resolve) => {
      resolveReconnect = resolve;
    });

    try {
      // First do a checkpoint to ensure all data is flushed
      await this.db.exec('CHECKPOINT');

      // Delay to let in-flight operations complete before closing
      // This is important because concurrent operations may be using the db
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Close the database (releases WASM memory)
      const oldDb = this.db;
      this.db = null;
      await oldDb.close();

      // Force garbage collection if available (Node.js with --expose-gc)
      if (global.gc) {
        global.gc();
      }

      log.logMemory('reconnect:afterClose');

      // Reopen the database using helper method (handles Bun executable)
      this.db = await this.createPGliteInstance();

      this._initialized = true;

      log.endTimer(timerKey, 'reconnect:complete', {});
      log.logMemory('reconnect:memoryAfter');
    } catch (error) {
      log.endTimer(timerKey, 'reconnect:error', { error: String(error) });
      // Try to recover by reinitializing
      this.db = null;
      try {
        this.db = await this.createPGliteInstance();
        this._initialized = true;
        log.info('reconnect:recovered', {});
      } catch (initError) {
        log.error('reconnect:recoveryFailed', { error: String(initError) });
        this._initialized = false;
        throw initError;
      }
    } finally {
      // Always clear reconnecting state
      this._reconnecting = false;
      this._reconnectPromise = null;
      resolveReconnect!();
    }
  }

  /**
   * Waits for any ongoing reconnection to complete, then checks initialization.
   * This is safe to call from concurrent operations during reconnect.
   */
  private async waitForReady(): Promise<void> {
    // Wait for any ongoing reconnection to complete
    if (this._reconnecting && this._reconnectPromise) {
      await this._reconnectPromise;
    }
    if (!this._initialized || !this.db) {
      throw new Error('Storage not initialized. Call initialize() first.');
    }
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  async createDocument(input: CreateDocumentInput): Promise<Document> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `createDocument-${timerId}`;
    log.startTimer(timerKey, false);

    const id = generateId();
    const now = new Date().toISOString();

    await this.db!.query(
      `INSERT INTO documents (
        id, file_path, file_name, file_extension, file_size, file_hash,
        mime_type, title, author, language, page_count, status, ocr_status,
        file_modified_at, created_at, updated_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        input.filePath,
        input.fileName,
        input.fileExtension,
        input.fileSize,
        input.fileHash,
        input.mimeType ?? null,
        input.title ?? null,
        input.author ?? null,
        input.language ?? null,
        input.pageCount ?? null,
        input.status ?? 'pending',
        input.ocrStatus ?? 'not_needed',
        input.fileModifiedAt.toISOString(),
        now,
        now,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Failed to create document');

    this._dirty = true;
    log.endTimer(timerKey, 'createDocument:complete', { documentId: id });
    return doc;
  }

  async getDocument(id: string): Promise<Document | null> {
    await this.waitForReady();

    const result = await this.db!.query<DocumentRow>(
      'SELECT * FROM documents WHERE id = $1',
      [id],
    );

    if (result.rows.length === 0) return null;
    return this.rowToDocument(result.rows[0]);
  }

  async getDocumentByPath(filePath: string): Promise<Document | null> {
    await this.waitForReady();

    const result = await this.db!.query<DocumentRow>(
      'SELECT * FROM documents WHERE file_path = $1',
      [filePath],
    );

    if (result.rows.length === 0) return null;
    return this.rowToDocument(result.rows[0]);
  }

  async updateDocument(
    id: string,
    updates: UpdateDocumentInput,
  ): Promise<Document> {
    await this.waitForReady();

    const sets: string[] = ['updated_at = CURRENT_TIMESTAMP'];
    const params: unknown[] = [];
    let paramIndex = 1;

    const fields: Array<keyof UpdateDocumentInput> = [
      'filePath',
      'fileName',
      'fileExtension',
      'fileSize',
      'fileHash',
      'mimeType',
      'title',
      'author',
      'language',
      'pageCount',
      'status',
      'ocrStatus',
      'indexedAt',
      'metadata',
    ];

    const columnMap: Record<keyof UpdateDocumentInput, string> = {
      filePath: 'file_path',
      fileName: 'file_name',
      fileExtension: 'file_extension',
      fileSize: 'file_size',
      fileHash: 'file_hash',
      mimeType: 'mime_type',
      title: 'title',
      author: 'author',
      language: 'language',
      pageCount: 'page_count',
      status: 'status',
      ocrStatus: 'ocr_status',
      indexedAt: 'indexed_at',
      metadata: 'metadata',
    };

    for (const field of fields) {
      if (updates[field] !== undefined) {
        const column = columnMap[field];
        let value = updates[field];

        if (field === 'indexedAt' && value instanceof Date) {
          value = value.toISOString();
        } else if (field === 'metadata') {
          value = JSON.stringify(value);
        }

        sets.push(`${column} = $${paramIndex}`);
        params.push(value);
        paramIndex++;
      }
    }

    params.push(id);

    await this.db!.query(
      `UPDATE documents SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
      params,
    );

    const doc = await this.getDocument(id);
    if (!doc) throw new Error('Document not found after update');
    this._dirty = true;
    return doc;
  }

  async deleteDocument(id: string): Promise<void> {
    await this.waitForReady();
    await this.db!.query('DELETE FROM documents WHERE id = $1', [id]);
    this._dirty = true;
  }

  async listDocuments(filters?: Partial<SearchFilters>): Promise<Document[]> {
    await this.waitForReady();

    const { where, params } = this.buildDocumentFilters(filters);
    const result = await this.db!.query<DocumentRow>(
      `SELECT * FROM documents ${where} ORDER BY file_path`,
      params,
    );

    return result.rows.map((row) => this.rowToDocument(row));
  }

  async countDocuments(filters?: Partial<SearchFilters>): Promise<number> {
    await this.waitForReady();

    const { where, params } = this.buildDocumentFilters(filters);
    const result = await this.db!.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM documents ${where}`,
      params,
    );

    return parseInt(result.rows[0].count, 10);
  }

  // -------------------------------------------------------------------------
  // Chunks
  // -------------------------------------------------------------------------

  async createChunks(
    documentId: string,
    chunks: CreateChunkInput[],
  ): Promise<DocumentChunk[]> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `createChunks-${timerId}`;
    log.startTimer(timerKey, true); // track memory for chunks
    log.debug('createChunks:start', { documentId, chunkCount: chunks.length });

    const createdChunks: DocumentChunk[] = [];
    const now = new Date().toISOString();

    for (let i = 0; i < chunks.length; i++) {
      // Yield to event loop periodically to prevent blocking
      if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) {
        await yieldToEventLoop();
      }

      const chunk = chunks[i];
      const id = generateId();

      await this.db!.query(
        `INSERT INTO chunks (
          id, document_id, chunk_index, text, start_offset, end_offset,
          page, section, token_count, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          documentId,
          chunk.chunkIndex,
          chunk.text,
          chunk.startOffset,
          chunk.endOffset,
          chunk.page ?? null,
          chunk.section ?? null,
          chunk.tokenCount ?? null,
          now,
        ],
      );

      // Update FTS vector
      await this.db!.query(UPDATE_FTS_VECTOR_SQL, [id]);

      createdChunks.push({
        id,
        documentId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        embedding: null,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        page: chunk.page ?? null,
        section: chunk.section ?? null,
        tokenCount: chunk.tokenCount ?? null,
        createdAt: new Date(now),
      });
    }

    this._dirty = true;
    log.endTimer(timerKey, 'createChunks:complete', {
      documentId,
      chunkCount: chunks.length,
    });
    return createdChunks;
  }

  async getChunks(documentId: string): Promise<DocumentChunk[]> {
    await this.waitForReady();

    const result = await this.db!.query<ChunkRow>(
      'SELECT * FROM chunks WHERE document_id = $1 ORDER BY chunk_index',
      [documentId],
    );

    return result.rows.map((row) => this.rowToChunk(row));
  }

  async deleteChunks(documentId: string): Promise<void> {
    await this.waitForReady();
    await this.db!.query('DELETE FROM chunks WHERE document_id = $1', [
      documentId,
    ]);
    this._dirty = true;
  }

  async updateChunkEmbeddings(
    updates: UpdateChunkEmbeddingInput[],
  ): Promise<void> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `updateChunkEmbeddings-${timerId}`;
    log.startTimer(timerKey, true);
    log.debug('updateChunkEmbeddings:start', { updateCount: updates.length });

    for (let i = 0; i < updates.length; i++) {
      // Yield to event loop periodically to prevent blocking
      if (i > 0 && i % YIELD_EVERY_N_ITEMS === 0) {
        await yieldToEventLoop();
      }

      const update = updates[i];
      await this.db!.query('UPDATE chunks SET embedding = $1 WHERE id = $2', [
        formatVector(update.embedding),
        update.id,
      ]);
    }

    this._dirty = true;
    log.endTimer(timerKey, 'updateChunkEmbeddings:complete', {
      updateCount: updates.length,
    });
  }

  async countChunks(): Promise<number> {
    await this.waitForReady();

    const result = await this.db!.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM chunks',
    );
    return parseInt(result.rows[0].count, 10);
  }

  // -------------------------------------------------------------------------
  // Tags
  // -------------------------------------------------------------------------

  async addTags(documentId: string, tags: string[]): Promise<void> {
    await this.waitForReady();

    for (const tagName of tags) {
      // Get or create tag
      const result = await this.db!.query<TagRow>(
        'SELECT id FROM tags WHERE name = $1',
        [tagName],
      );

      let tagId: string;
      if (result.rows.length === 0) {
        tagId = generateId();
        await this.db!.query('INSERT INTO tags (id, name) VALUES ($1, $2)', [
          tagId,
          tagName,
        ]);
      } else {
        tagId = result.rows[0].id;
      }

      // Link tag to document (ignore if already exists)
      await this.db!.query(
        `INSERT INTO document_tags (document_id, tag_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [documentId, tagId],
      );
    }
    this._dirty = true;
  }

  async removeTags(documentId: string, tags: string[]): Promise<void> {
    await this.waitForReady();

    for (const tagName of tags) {
      const result = await this.db!.query<TagRow>(
        'SELECT id FROM tags WHERE name = $1',
        [tagName],
      );

      if (result.rows.length > 0) {
        await this.db!.query(
          'DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2',
          [documentId, result.rows[0].id],
        );
      }
    }
    this._dirty = true;
  }

  async getDocumentTags(documentId: string): Promise<string[]> {
    await this.waitForReady();

    const result = await this.db!.query<{ name: string }>(
      `SELECT t.name FROM tags t
       JOIN document_tags dt ON t.id = dt.tag_id
       WHERE dt.document_id = $1
       ORDER BY t.name`,
      [documentId],
    );

    return result.rows.map((row) => row.name);
  }

  async getAllTags(): Promise<TagCount[]> {
    await this.waitForReady();

    const result = await this.db!.query<TagCountRow>(
      `SELECT t.name as tag, COUNT(dt.document_id) as count
       FROM tags t
       LEFT JOIN document_tags dt ON t.id = dt.tag_id
       GROUP BY t.id, t.name
       ORDER BY count DESC, t.name`,
    );

    return result.rows.map((row) => ({
      tag: row.tag,
      count:
        typeof row.count === 'string' ? parseInt(row.count, 10) : row.count,
    }));
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  async searchKeyword(
    query: string,
    filters?: SearchFilters,
    limit = 10,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `searchKeyword-${timerId}`;
    log.startTimer(timerKey, true);
    log.debug('searchKeyword:start', { queryLength: query.length, limit, useWebSearchSyntax: options?.useWebSearchSyntax });

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    // Choose tsquery function based on options:
    // - websearch_to_tsquery: Google-style syntax ("quoted phrase", OR, -exclusion)
    // - plainto_tsquery: Simple AND of all terms (default)
    const tsqueryFn = options?.useWebSearchSyntax
      ? 'websearch_to_tsquery'
      : 'plainto_tsquery';

    // Try FTS first, then fall back to ILIKE
    const ftsParams = [query, ...filterParams, limit];
    const ftsParamOffset = filterParams.length + 1;

    // Use ts_headline for native PostgreSQL highlighting with <mark> tags
    // This properly handles phrase queries (highlights "base de apoio" as a unit)
    const ftsSql = `
      SELECT
        c.id as chunk_id,
        c.document_id,
        d.file_path,
        d.file_name,
        c.text as chunk_text,
        ts_headline(
          'simple',
          c.text,
          ${tsqueryFn}('simple', $1),
          'StartSel=<mark>, StopSel=</mark>, MaxFragments=0, HighlightAll=true'
        ) as highlighted_text,
        c.page,
        c.section,
        ts_rank(c.fts_vector, ${tsqueryFn}('simple', $1)) as score,
        'keyword' as match_type
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.fts_vector @@ ${tsqueryFn}('simple', $1)
        AND d.status = 'indexed'
        ${filterWhere ? `AND ${filterWhere}` : ''}
      ORDER BY score DESC
      LIMIT $${ftsParamOffset + 1}
    `;

    try {
      const ftsResult = await this.db!.query<SearchResultRow>(
        ftsSql,
        ftsParams,
      );
      if (ftsResult.rows.length > 0) {
        const results = this.rowsToSearchResults(ftsResult.rows);
        log.endTimer(timerKey, 'searchKeyword:complete:fts', {
          resultCount: results.length,
        });
        return results;
      }
    } catch {
      // FTS might not be supported, fall through to ILIKE
    }

    // Fallback to ILIKE search for compatibility
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (searchTerms.length === 0) {
      log.endTimer(timerKey, 'searchKeyword:complete:empty', {
        resultCount: 0,
      });
      return [];
    }

    // Build ILIKE conditions for each word
    const likeConditions = searchTerms
      .map((_, i) => `LOWER(c.text) LIKE $${i + 1}`)
      .join(' AND ');

    const likeParams = [
      ...searchTerms.map((t) => `%${t}%`),
      ...filterParams,
      limit,
    ];
    const likeParamOffset = searchTerms.length + filterParams.length;

    const likeSql = `
      SELECT
        c.id as chunk_id,
        c.document_id,
        d.file_path,
        d.file_name,
        c.text as chunk_text,
        c.page,
        c.section,
        1.0 as score,
        'keyword' as match_type
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE ${likeConditions}
        AND d.status = 'indexed'
        ${filterWhere ? `AND ${filterWhere}` : ''}
      ORDER BY c.created_at DESC
      LIMIT $${likeParamOffset + 1}
    `;

    const likeResult = await this.db!.query<SearchResultRow>(
      likeSql,
      likeParams,
    );
    const results = this.rowsToSearchResults(likeResult.rows);
    log.endTimer(timerKey, 'searchKeyword:complete:ilike', {
      resultCount: results.length,
    });
    return results;
  }

  async searchSemantic(
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
  ): Promise<SearchResult[]> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `searchSemantic-${timerId}`;
    log.startTimer(timerKey, true);
    log.debug('searchSemantic:start', {
      embeddingDim: embedding.length,
      limit,
    });

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    const vectorStr = formatVector(embedding);
    log.debug('searchSemantic:vectorFormatted', {
      vectorStrLength: vectorStr.length,
    });

    const params = [vectorStr, ...filterParams, limit];
    const paramOffset = filterParams.length + 1;

    const sql = `
      SELECT
        c.id as chunk_id,
        c.document_id,
        d.file_path,
        d.file_name,
        c.text as chunk_text,
        c.page,
        c.section,
        1 - (c.embedding <=> $1) as score,
        'semantic' as match_type
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.embedding IS NOT NULL
        AND d.status = 'indexed'
        ${filterWhere ? `AND ${filterWhere}` : ''}
      ORDER BY c.embedding <=> $1
      LIMIT $${paramOffset + 1}
    `;

    const result = await this.db!.query<SearchResultRow>(sql, params);
    const results = this.rowsToSearchResults(result.rows);
    log.endTimer(timerKey, 'searchSemantic:complete', {
      resultCount: results.length,
    });
    return results;
  }

  async searchHybrid(
    query: string,
    embedding: number[],
    filters?: SearchFilters,
    limit = 10,
    weights: HybridSearchWeights = { semantic: 0.5, keyword: 0.5 },
    rrfK = 60,
    options?: KeywordSearchOptions,
  ): Promise<SearchResult[]> {
    await this.waitForReady();
    const timerId = ++this.timerCounter;
    const timerKey = `searchHybrid-${timerId}`;
    log.startTimer(timerKey, false);

    const { where: filterWhere, params: filterParams } =
      this.buildSearchFilters(filters);

    const vectorStr = formatVector(embedding);
    const filterClause = filterWhere ? `AND ${filterWhere}` : '';

    // Choose tsquery function based on options
    const tsqueryFn = options?.useWebSearchSyntax
      ? 'websearch_to_tsquery'
      : 'plainto_tsquery';

    // Build parameter list
    const params = [
      vectorStr,
      query,
      weights.semantic,
      weights.keyword,
      rrfK,
      ...filterParams,
      limit,
    ];

    // Use ts_headline for native PostgreSQL highlighting with <mark> tags
    // Hybrid search combines semantic and keyword results with RRF fusion
    const sql = `
      WITH semantic_results AS (
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          c.page,
          c.section,
          ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1) as rank
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.embedding IS NOT NULL
          AND d.status = 'indexed'
          ${filterClause}
        ORDER BY c.embedding <=> $1
        LIMIT 50
      ),
      keyword_results AS (
        SELECT
          c.id as chunk_id,
          c.document_id,
          d.file_path,
          d.file_name,
          c.text as chunk_text,
          ts_headline(
            'simple',
            c.text,
            ${tsqueryFn}('simple', $2),
            'StartSel=<mark>, StopSel=</mark>, MaxFragments=0, HighlightAll=true'
          ) as highlighted_text,
          c.page,
          c.section,
          ROW_NUMBER() OVER (
            ORDER BY ts_rank(c.fts_vector, ${tsqueryFn}('simple', $2)) DESC
          ) as rank
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE c.fts_vector @@ ${tsqueryFn}('simple', $2)
          AND d.status = 'indexed'
          ${filterClause}
        ORDER BY ts_rank(c.fts_vector, ${tsqueryFn}('simple', $2)) DESC
        LIMIT 50
      ),
      combined AS (
        SELECT
          COALESCE(s.chunk_id, k.chunk_id) as chunk_id,
          COALESCE(s.document_id, k.document_id) as document_id,
          COALESCE(s.file_path, k.file_path) as file_path,
          COALESCE(s.file_name, k.file_name) as file_name,
          COALESCE(s.chunk_text, k.chunk_text) as chunk_text,
          -- Use highlighted text when we have a keyword match
          k.highlighted_text as highlighted_text,
          COALESCE(s.page, k.page) as page,
          COALESCE(s.section, k.section) as section,
          COALESCE($3::float / ($5::float + s.rank), 0) +
          COALESCE($4::float / ($5::float + k.rank), 0) as score,
          CASE
            WHEN s.chunk_id IS NOT NULL AND k.chunk_id IS NOT NULL THEN 'hybrid'
            WHEN s.chunk_id IS NOT NULL THEN 'semantic'
            ELSE 'keyword'
          END as match_type
        FROM semantic_results s
        FULL OUTER JOIN keyword_results k ON s.chunk_id = k.chunk_id
      )
      SELECT * FROM combined
      ORDER BY score DESC
      LIMIT $${params.length}
    `;

    const result = await this.db!.query<SearchResultRow>(sql, params);
    const results = this.rowsToSearchResults(result.rows);

    log.endTimer(timerKey, 'searchHybrid:complete', {
      resultCount: results.length,
    });
    return results;
  }

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  async enqueueItem(input: CreateQueueItemInput): Promise<QueueItem> {
    await this.waitForReady();

    const id = generateId();
    const now = new Date().toISOString();

    await this.db!.query(
      `INSERT INTO index_queue (id, file_path, file_size, priority, status, attempts, created_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5)
       ON CONFLICT (file_path) DO UPDATE SET
         file_size = EXCLUDED.file_size,
         priority = EXCLUDED.priority,
         status = 'pending',
         attempts = 0,
         last_error = NULL,
         started_at = NULL,
         completed_at = NULL`,
      [
        id,
        input.filePath,
        input.fileSize ?? 0,
        input.priority ?? 'markup',
        now,
      ],
    );

    const item = await this.getQueueItemByPath(input.filePath);
    if (!item) throw new Error('Failed to create queue item');
    this._dirty = true;
    return item;
  }

  async enqueueItems(inputs: CreateQueueItemInput[]): Promise<QueueItem[]> {
    const items: QueueItem[] = [];
    for (const input of inputs) {
      items.push(await this.enqueueItem(input));
    }
    return items;
  }

  async dequeueItem(): Promise<QueueItem | null> {
    await this.waitForReady();

    // Order: text files first (fastest), then by file size (smallest first)
    // Priority: text=1, markup=2, pdf=3, image=4, ocr=5
    const result = await this.db!.query<QueueItemRow>(
      `UPDATE index_queue
       SET status = 'processing', started_at = CURRENT_TIMESTAMP, attempts = attempts + 1
       WHERE id = (
         SELECT id FROM index_queue
         WHERE status = 'pending'
         ORDER BY
           CASE priority
             WHEN 'text' THEN 1
             WHEN 'markup' THEN 2
             WHEN 'pdf' THEN 3
             WHEN 'image' THEN 4
             WHEN 'ocr' THEN 5
           END,
           file_size ASC,
           created_at ASC
         LIMIT 1
       )
       RETURNING *`,
    );

    if (result.rows.length === 0) return null;
    return this.rowToQueueItem(result.rows[0]);
  }

  async updateQueueItem(
    id: string,
    updates: UpdateQueueItemInput,
  ): Promise<QueueItem> {
    await this.waitForReady();

    const sets: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      sets.push(`status = $${paramIndex}`);
      params.push(updates.status);
      paramIndex++;
    }
    if (updates.attempts !== undefined) {
      sets.push(`attempts = $${paramIndex}`);
      params.push(updates.attempts);
      paramIndex++;
    }
    if (updates.lastError !== undefined) {
      sets.push(`last_error = $${paramIndex}`);
      params.push(updates.lastError);
      paramIndex++;
    }
    if (updates.startedAt !== undefined) {
      sets.push(`started_at = $${paramIndex}`);
      params.push(updates.startedAt?.toISOString() ?? null);
      paramIndex++;
    }
    if (updates.completedAt !== undefined) {
      sets.push(`completed_at = $${paramIndex}`);
      params.push(updates.completedAt?.toISOString() ?? null);
      paramIndex++;
    }

    params.push(id);

    if (sets.length > 0) {
      await this.db!.query(
        `UPDATE index_queue SET ${sets.join(', ')} WHERE id = $${paramIndex}`,
        params,
      );
    }

    const result = await this.db!.query<QueueItemRow>(
      'SELECT * FROM index_queue WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) throw new Error('Queue item not found');
    this._dirty = true;
    return this.rowToQueueItem(result.rows[0]);
  }

  async deleteQueueItem(id: string): Promise<void> {
    await this.waitForReady();
    await this.db!.query('DELETE FROM index_queue WHERE id = $1', [id]);
    this._dirty = true;
  }

  async getQueueItemByPath(filePath: string): Promise<QueueItem | null> {
    await this.waitForReady();

    const result = await this.db!.query<QueueItemRow>(
      'SELECT * FROM index_queue WHERE file_path = $1',
      [filePath],
    );

    if (result.rows.length === 0) return null;
    return this.rowToQueueItem(result.rows[0]);
  }

  async getQueueStatus(): Promise<QueueStatus> {
    await this.waitForReady();

    const statusResult = await this.db!.query<{
      status: string;
      count: string;
    }>(`SELECT status, COUNT(*) as count FROM index_queue GROUP BY status`);

    const priorityResult = await this.db!.query<{
      priority: string;
      count: string;
    }>(
      `SELECT priority, COUNT(*) as count FROM index_queue
       WHERE status = 'pending' GROUP BY priority`,
    );

    const statusCounts: Record<string, number> = {};
    for (const row of statusResult.rows) {
      statusCounts[row.status] = parseInt(row.count, 10);
    }

    const priorityCounts: Record<QueuePriority, number> = {
      text: 0,
      markup: 0,
      pdf: 0,
      image: 0,
      ocr: 0,
    };
    for (const row of priorityResult.rows) {
      priorityCounts[row.priority as QueuePriority] = parseInt(row.count, 10);
    }

    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    return {
      total,
      pending: statusCounts['pending'] ?? 0,
      processing: statusCounts['processing'] ?? 0,
      completed: statusCounts['completed'] ?? 0,
      failed: statusCounts['failed'] ?? 0,
      byPriority: priorityCounts,
    };
  }

  async clearCompletedQueueItems(): Promise<number> {
    await this.waitForReady();

    const result = await this.db!.query<{ count: string }>(
      `WITH deleted AS (
        DELETE FROM index_queue WHERE status = 'completed' RETURNING *
      ) SELECT COUNT(*) as count FROM deleted`,
    );

    const count = parseInt(result.rows[0].count, 10);
    if (count > 0) this._dirty = true;
    return count;
  }

  async clearQueue(): Promise<void> {
    await this.waitForReady();
    await this.db!.query('DELETE FROM index_queue');
    this._dirty = true;
  }

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  async getFileHashes(): Promise<Map<string, string>> {
    await this.waitForReady();

    const result = await this.db!.query<{
      file_path: string;
      file_hash: string;
    }>('SELECT file_path, file_hash FROM documents');

    const map = new Map<string, string>();
    for (const row of result.rows) {
      map.set(row.file_path, row.file_hash);
    }
    return map;
  }

  async getDocumentsModifiedSince(date: Date): Promise<Document[]> {
    await this.waitForReady();

    const result = await this.db!.query<DocumentRow>(
      'SELECT * FROM documents WHERE file_modified_at > $1 ORDER BY file_path',
      [date.toISOString()],
    );

    return result.rows.map((row) => this.rowToDocument(row));
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  async getStats(): Promise<SearchStats> {
    await this.waitForReady();

    const docResult = await this.db!.query<StatsRow>(`
      SELECT
        COUNT(*) as total_documents,
        COUNT(*) FILTER (WHERE status = 'indexed') as indexed_documents,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_documents,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_documents,
        COUNT(*) FILTER (WHERE ocr_status = 'pending') as ocr_pending,
        COALESCE(SUM(file_size), 0) as total_file_size
      FROM documents
    `);

    const chunkResult = await this.db!.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM chunks',
    );

    const tagResult = await this.db!.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM tags',
    );

    const stats = docResult.rows[0];

    const result = {
      totalDocuments:
        typeof stats.total_documents === 'string'
          ? parseInt(stats.total_documents, 10)
          : stats.total_documents,
      totalChunks: parseInt(chunkResult.rows[0].count, 10),
      indexedDocuments:
        typeof stats.indexed_documents === 'string'
          ? parseInt(stats.indexed_documents, 10)
          : stats.indexed_documents,
      pendingDocuments:
        typeof stats.pending_documents === 'string'
          ? parseInt(stats.pending_documents, 10)
          : stats.pending_documents,
      failedDocuments:
        typeof stats.failed_documents === 'string'
          ? parseInt(stats.failed_documents, 10)
          : stats.failed_documents,
      ocrPending:
        typeof stats.ocr_pending === 'string'
          ? parseInt(stats.ocr_pending, 10)
          : stats.ocr_pending,
      totalTags: parseInt(tagResult.rows[0].count, 10),
      databaseSize:
        typeof stats.total_file_size === 'string'
          ? parseInt(stats.total_file_size, 10)
          : stats.total_file_size,
    };

    log.debug('getStats', result);
    log.logMemory('getStats:memory');

    return result;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  async getConfigValue<T>(key: string): Promise<T | null> {
    await this.waitForReady();

    const result = await this.db!.query<{ value: T }>(
      'SELECT value FROM search_config WHERE key = $1',
      [key],
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].value;
  }

  async setConfigValue<T>(key: string, value: T): Promise<void> {
    await this.waitForReady();

    await this.db!.query(
      `INSERT INTO search_config (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(value)],
    );
    this._dirty = true;
  }

  // -------------------------------------------------------------------------
  // Raw Query
  // -------------------------------------------------------------------------

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    await this.waitForReady();
    const result = await this.db!.query<T>(sql, params);
    return result.rows;
  }

  async execute(sql: string, params?: unknown[]): Promise<void> {
    await this.waitForReady();
    await this.db!.query(sql, params);
  }

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  /**
   * Recover documents stuck in intermediate states (parsing, chunking, embedding).
   * This handles crash recovery where indexing was interrupted mid-process.
   *
   * On crash during indexing:
   * - Document status may be 'parsing', 'chunking', or 'embedding'
   * - Chunks may be partially created (some with NULL embeddings)
   * - Queue item may still show 'processing'
   *
   * Recovery process:
   * 1. Find all documents in intermediate states
   * 2. Delete their partial chunks (will be recreated on re-index)
   * 3. Reset document status to 'pending'
   * 4. Re-queue them for indexing
   *
   * @returns Number of documents recovered
   */
  async recoverStuckDocuments(): Promise<number> {
    await this.waitForReady();

    // Find documents stuck in intermediate states
    const stuckDocs = await this.db!.query<{
      id: string;
      file_path: string;
      status: string;
    }>(
      `SELECT id, file_path, status FROM documents
       WHERE status IN ('parsing', 'chunking', 'embedding')`,
    );

    if (stuckDocs.rows.length === 0) {
      return 0;
    }

    log.info('recoverStuckDocuments:found', {
      count: stuckDocs.rows.length,
      statuses: stuckDocs.rows.map((r) => r.status),
    });

    let recoveredCount = 0;

    for (const doc of stuckDocs.rows) {
      try {
        // 1. Delete partial chunks (they may be incomplete or have NULL embeddings)
        await this.db!.query('DELETE FROM chunks WHERE document_id = $1', [
          doc.id,
        ]);

        // 2. Reset document status to 'pending'
        await this.db!.query(
          `UPDATE documents SET status = 'pending', updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [doc.id],
        );

        // 3. Re-queue for indexing (upsert to handle existing queue items)
        await this.db!.query(
          `INSERT INTO index_queue (id, file_path, priority, status, attempts, created_at)
           VALUES (gen_random_uuid(), $1, 'text', 'pending', 0, CURRENT_TIMESTAMP)
           ON CONFLICT (file_path) DO UPDATE SET
             status = 'pending',
             attempts = 0,
             last_error = NULL,
             started_at = NULL,
             completed_at = NULL`,
          [doc.file_path],
        );

        recoveredCount++;
        log.info('recoverStuckDocuments:recovered', {
          documentId: doc.id,
          filePath: doc.file_path,
          previousStatus: doc.status,
        });
      } catch (error) {
        log.error('recoverStuckDocuments:error', {
          documentId: doc.id,
          filePath: doc.file_path,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other documents
      }
    }

    if (recoveredCount > 0) {
      this._dirty = true;
    }

    log.info('recoverStuckDocuments:complete', {
      total: stuckDocs.rows.length,
      recovered: recoveredCount,
    });

    return recoveredCount;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  private rowToDocument(row: DocumentRow): Document {
    return {
      id: row.id,
      filePath: row.file_path,
      fileName: row.file_name,
      fileExtension: row.file_extension,
      fileSize:
        typeof row.file_size === 'string'
          ? parseInt(row.file_size, 10)
          : row.file_size,
      fileHash: row.file_hash,
      mimeType: row.mime_type,
      title: row.title,
      author: row.author,
      language: row.language,
      pageCount: row.page_count,
      status: row.status as Document['status'],
      ocrStatus: row.ocr_status as Document['ocrStatus'],
      indexedAt: toDate(row.indexed_at),
      fileModifiedAt: toDate(row.file_modified_at)!,
      createdAt: toDate(row.created_at)!,
      updatedAt: toDate(row.updated_at)!,
      metadata:
        typeof row.metadata === 'string'
          ? JSON.parse(row.metadata)
          : row.metadata,
      tags: [], // Tags loaded separately if needed
    };
  }

  private rowToChunk(row: ChunkRow): DocumentChunk {
    return {
      id: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      text: row.text,
      embedding: row.embedding
        ? JSON.parse(row.embedding.replace(/^\[/, '[').replace(/\]$/, ']'))
        : null,
      startOffset: row.start_offset,
      endOffset: row.end_offset,
      page: row.page,
      section: row.section,
      tokenCount: row.token_count,
      createdAt: toDate(row.created_at)!,
    };
  }

  private rowToQueueItem(row: QueueItemRow): QueueItem {
    return {
      id: row.id,
      filePath: row.file_path,
      fileSize:
        typeof row.file_size === 'string'
          ? parseInt(row.file_size, 10)
          : row.file_size,
      priority: row.priority as QueuePriority,
      status: row.status as QueueItem['status'],
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: toDate(row.created_at)!,
      startedAt: toDate(row.started_at),
      completedAt: toDate(row.completed_at),
    };
  }

  private rowsToSearchResults(rows: SearchResultRow[]): SearchResult[] {
    return rows.map((row) => ({
      documentId: row.document_id,
      chunkId: row.chunk_id,
      filePath: row.file_path,
      fileName: row.file_name,
      // Use PostgreSQL's ts_headline highlighted text when available (keyword search),
      // otherwise use the original chunk text (semantic search)
      chunkText: row.highlighted_text ?? row.chunk_text,
      score: Number(row.score) || 0,
      matchType: row.match_type as SearchResult['matchType'],
      highlights: [],
      metadata: {
        page: row.page,
        section: row.section,
        tags: [],
      },
    }));
  }

  private buildDocumentFilters(filters?: Partial<SearchFilters>): {
    where: string;
    params: unknown[];
  } {
    if (!filters) return { where: '', params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filters.folders && filters.folders.length > 0) {
      const folderConditions = filters.folders.map(() => {
        // Normalize path separators in both the stored path and the filter
        const condition = `REPLACE(file_path, '\\', '/') LIKE $${paramIndex}`;
        paramIndex++;
        return condition;
      });
      conditions.push(`(${folderConditions.join(' OR ')})`);
      // Normalize path separators and use %folder% pattern to match anywhere in path
      params.push(
        ...filters.folders.map((f) => {
          const normalized = f.replace(/\\/g, '/');
          return `%${normalized}%`;
        }),
      );
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const placeholders = filters.fileTypes.map(() => `$${paramIndex++}`);
      conditions.push(`file_extension IN (${placeholders.join(', ')})`);
      // Normalize: add leading dot if missing, convert to lowercase
      params.push(
        ...filters.fileTypes.map((t) =>
          t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`,
        ),
      );
    }

    if (filters.status && filters.status.length > 0) {
      const placeholders = filters.status.map(() => `$${paramIndex++}`);
      conditions.push(`status IN (${placeholders.join(', ')})`);
      params.push(...filters.status);
    }

    if (filters.dateFrom) {
      conditions.push(`file_modified_at >= $${paramIndex++}`);
      params.push(filters.dateFrom.toISOString());
    }

    if (filters.dateTo) {
      conditions.push(`file_modified_at <= $${paramIndex++}`);
      params.push(filters.dateTo.toISOString());
    }

    if (filters.languages && filters.languages.length > 0) {
      const placeholders = filters.languages.map(() => `$${paramIndex++}`);
      conditions.push(`language IN (${placeholders.join(', ')})`);
      params.push(...filters.languages);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return { where, params };
  }

  private buildSearchFilters(filters?: SearchFilters): {
    where: string;
    params: unknown[];
  } {
    if (!filters) return { where: '', params: [] };

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 2; // Start at 2 because $1 is used for query/embedding

    if (filters.folders && filters.folders.length > 0) {
      const folderConditions = filters.folders.map(() => {
        // Normalize path separators in both the stored path and the filter
        // REPLACE(file_path, '\', '/') normalizes Windows paths to forward slashes
        const condition = `REPLACE(d.file_path, '\\', '/') LIKE $${paramIndex}`;
        paramIndex++;
        return condition;
      });
      conditions.push(`(${folderConditions.join(' OR ')})`);
      // Normalize path separators and use %folder% pattern to match anywhere in path
      params.push(
        ...filters.folders.map((f) => {
          // Normalize to forward slashes, then wrap with % for partial match
          const normalized = f.replace(/\\/g, '/');
          return `%${normalized}%`;
        }),
      );
    }

    if (filters.fileTypes && filters.fileTypes.length > 0) {
      const placeholders = filters.fileTypes.map(() => `$${paramIndex++}`);
      conditions.push(`d.file_extension IN (${placeholders.join(', ')})`);
      // Normalize: add leading dot if missing, convert to lowercase
      params.push(
        ...filters.fileTypes.map((t) =>
          t.startsWith('.') ? t.toLowerCase() : `.${t.toLowerCase()}`,
        ),
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      const placeholders = filters.tags.map(() => `$${paramIndex++}`);
      conditions.push(`
        EXISTS (
          SELECT 1 FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id
          WHERE dt.document_id = d.id AND t.name IN (${placeholders.join(', ')})
        )
      `);
      params.push(...filters.tags);
    }

    if (filters.dateFrom) {
      conditions.push(`d.file_modified_at >= $${paramIndex++}`);
      params.push(filters.dateFrom.toISOString());
    }

    if (filters.dateTo) {
      conditions.push(`d.file_modified_at <= $${paramIndex++}`);
      params.push(filters.dateTo.toISOString());
    }

    if (filters.languages && filters.languages.length > 0) {
      const placeholders = filters.languages.map(() => `$${paramIndex++}`);
      conditions.push(`d.language IN (${placeholders.join(', ')})`);
      params.push(...filters.languages);
    }

    const where = conditions.join(' AND ');

    return { where, params };
  }
}
