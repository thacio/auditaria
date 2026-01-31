/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin storage writer child process.
 *
 * This child process ONLY handles PGlite storage operations.
 * It does NOT include:
 * - Embedders (stay in main process with workers)
 * - IndexingPipeline (stays in main process)
 * - Parsers/Chunkers (stay in main process)
 *
 * The main process:
 * 1. Runs discovery/parsing/chunking/embedding
 * 2. Sends prepared documents (with embeddings) to this child
 * 3. This child writes them to PGlite
 * 4. This child exits after N writes, releasing WASM memory
 *
 * This solves the PGlite WASM memory issue where INSERT operations
 * cause memory to grow exponentially.
 */

import type { Interface } from 'node:readline';
import { createInterface } from 'node:readline';
import type {
  StorageWriterRequest,
  StorageWriterResponse,
  StorageInitMessage,
  WriteDocumentMessage,
  UpdateDocumentStatusMessage,
} from './storage-writer-types.js';
import {
  getMemoryUsageMb,
  serializeStorageMessage,
} from './storage-writer-types.js';

// Will be dynamically imported
import type { PGliteStorage } from '../storage/PGliteStorage.js';

// ============================================================================
// Global State
// ============================================================================

let readline: Interface | null = null;
let isShuttingDown = false;
let storage: PGliteStorage | null = null;

// Stats
let documentsWritten = 0;
let chunksWritten = 0;
let embeddingsWritten = 0;

// ============================================================================
// IPC Communication
// ============================================================================

/**
 * Send a message to the main process via stdout.
 */
function send(message: StorageWriterResponse): void {
  if (!isShuttingDown || message.type === 'error') {
    // eslint-disable-next-line no-console -- stdout is IPC channel to parent
    console.log(serializeStorageMessage(message));
  }
}

/**
 * Log to stderr (doesn't interfere with IPC).
 */
function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  data?: unknown,
): void {
  const timestamp = new Date().toISOString();
  const logLine = JSON.stringify({
    timestamp,
    level,
    process: 'storage-writer',
    message,
    data,
  });
  process.stderr.write(logLine + '\n');
}

// ============================================================================
// Message Handlers
// ============================================================================

/**
 * Handle init command - open PGlite storage.
 */
async function handleInit(msg: StorageInitMessage): Promise<void> {
  log('info', 'Initializing storage', {
    databasePath: msg.databasePath,
    rootPath: msg.rootPath,
  });

  try {
    // Dynamic import to avoid loading until needed
    const { PGliteStorage: PGliteStorageClass } = await import(
      '../storage/PGliteStorage.js'
    );

    // Create PGlite storage (child process always uses PGlite for indexing)
    storage = new PGliteStorageClass({
      backend: 'pglite',
      path: msg.databasePath,
      inMemory: false,
      backupEnabled: msg.config.database?.backupEnabled ?? true,
    });

    await storage.initialize();

    log('info', 'Storage initialized', { memoryMb: getMemoryUsageMb() });

    send({
      type: 'init_complete',
      id: msg.id,
      success: true,
      memoryUsageMb: getMemoryUsageMb(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to initialize storage', { error: errorMessage });

    send({
      type: 'init_complete',
      id: msg.id,
      success: false,
      error: errorMessage,
      memoryUsageMb: getMemoryUsageMb(),
    });
  }
}

/**
 * Handle write_document command - write document, chunks, and embeddings.
 */
async function handleWriteDocument(msg: WriteDocumentMessage): Promise<void> {
  if (!storage) {
    send({
      type: 'error',
      id: msg.id,
      error: 'Storage not initialized',
      fatal: true,
    });
    return;
  }

  try {
    // Check if document already exists (for re-indexing)
    let documentId: string;
    const existingDoc = await storage.getDocumentByPath(msg.document.filePath);

    if (existingDoc) {
      // Re-indexing: delete existing chunks first
      if (msg.isReindex) {
        await storage.deleteChunks(existingDoc.id);
      }
      documentId = existingDoc.id;

      // Update document metadata (fileModifiedAt not updateable)
      await storage.updateDocument(documentId, {
        fileHash: msg.document.fileHash,
        fileSize: msg.document.fileSize,
        title: msg.document.title,
        author: msg.document.author,
        language: msg.document.language,
        pageCount: msg.document.pageCount,
        status: 'embedding',
      });
    } else {
      // New document
      const doc = await storage.createDocument({
        ...msg.document,
        status: 'embedding',
      });
      documentId = doc.id;
    }

    // Create chunks
    const createdChunks = await storage.createChunks(documentId, msg.chunks);
    const chunkIds = createdChunks.map((c) => c.id);

    // Update embeddings
    if (msg.embeddings.length > 0) {
      const embeddingUpdates = chunkIds.map((id, index) => ({
        id,
        embedding: msg.embeddings[index],
      }));
      await storage.updateChunkEmbeddings(embeddingUpdates);
    }

    // Mark document as indexed
    await storage.updateDocument(documentId, {
      status: 'indexed',
      indexedAt: new Date(),
    });

    // Update stats
    documentsWritten++;
    chunksWritten += createdChunks.length;
    embeddingsWritten += msg.embeddings.length;

    log('info', 'Document written', {
      documentId,
      chunks: createdChunks.length,
      embeddings: msg.embeddings.length,
      totalDocs: documentsWritten,
      memoryMb: getMemoryUsageMb(),
    });

    send({
      type: 'document_written',
      id: msg.id,
      documentId,
      chunkIds,
      chunksWritten: createdChunks.length,
      embeddingsWritten: msg.embeddings.length,
      memoryUsageMb: getMemoryUsageMb(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to write document', {
      filePath: msg.document.filePath,
      error: errorMessage,
    });

    send({
      type: 'error',
      id: msg.id,
      error: `Failed to write document: ${errorMessage}`,
      fatal: false,
    });
  }
}

/**
 * Handle update_document_status command.
 */
async function handleUpdateDocumentStatus(
  msg: UpdateDocumentStatusMessage,
): Promise<void> {
  if (!storage) {
    send({
      type: 'error',
      id: msg.id,
      error: 'Storage not initialized',
      fatal: true,
    });
    return;
  }

  try {
    await storage.updateDocument(msg.documentId, {
      status: msg.status,
      indexedAt: msg.indexedAt ? new Date(msg.indexedAt) : undefined,
      metadata: msg.metadata,
    });

    send({
      type: 'document_status_updated',
      id: msg.id,
      documentId: msg.documentId,
      memoryUsageMb: getMemoryUsageMb(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to update document status', {
      documentId: msg.documentId,
      error: errorMessage,
    });

    send({
      type: 'error',
      id: msg.id,
      error: `Failed to update document status: ${errorMessage}`,
      fatal: false,
    });
  }
}

/**
 * Handle checkpoint command.
 */
async function handleCheckpoint(id: string): Promise<void> {
  if (!storage) {
    send({
      type: 'error',
      id,
      error: 'Storage not initialized',
      fatal: false,
    });
    return;
  }

  try {
    if (storage.checkpoint) {
      await storage.checkpoint();
    }

    log('info', 'Checkpoint complete', { memoryMb: getMemoryUsageMb() });

    send({
      type: 'checkpoint_complete',
      id,
      memoryUsageMb: getMemoryUsageMb(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log('warn', 'Checkpoint failed', { error: errorMessage });

    send({
      type: 'error',
      id,
      error: `Checkpoint failed: ${errorMessage}`,
      fatal: false,
    });
  }
}

/**
 * Handle stats command.
 */
function handleStats(id: string): void {
  send({
    type: 'stats_response',
    id,
    documentsWritten,
    chunksWritten,
    embeddingsWritten,
    memoryUsageMb: getMemoryUsageMb(),
  });
}

/**
 * Handle shutdown command.
 */
async function handleShutdown(id: string): Promise<void> {
  log('info', 'Shutdown requested', { id });
  isShuttingDown = true;

  // Close readline
  if (readline) {
    readline.close();
    readline = null;
  }

  // Close storage with timeout
  if (storage) {
    log('info', 'Closing storage...');

    const closeTimeout = 5000;
    let closeCompleted = false;

    const closePromise = (async () => {
      try {
        await storage!.close();
        closeCompleted = true;
        log('info', 'Storage closed successfully');
      } catch (error) {
        log('warn', 'Error closing storage', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!closeCompleted) {
          log('warn', 'Storage close timed out');
        }
        resolve();
      }, closeTimeout);
    });

    await Promise.race([closePromise, timeoutPromise]);
    storage = null;
  }

  // Small delay to flush logs
  await new Promise((resolve) => setTimeout(resolve, 50));

  log('info', 'Shutdown complete', {
    documentsWritten,
    chunksWritten,
    embeddingsWritten,
  });

  process.exit(0);
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  log('info', 'Storage writer child started', {
    pid: process.pid,
    memoryMb: getMemoryUsageMb(),
  });

  // Set up readline for IPC
  readline = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Handle incoming messages
  readline.on('line', async (line) => {
    if (isShuttingDown) return;

    try {
      const msg: StorageWriterRequest = JSON.parse(line);

      switch (msg.type) {
        case 'init':
          await handleInit(msg);
          break;
        case 'write_document':
          await handleWriteDocument(msg);
          break;
        case 'update_document_status':
          await handleUpdateDocumentStatus(msg);
          break;
        case 'checkpoint':
          await handleCheckpoint(msg.id);
          break;
        case 'stats':
          handleStats(msg.id);
          break;
        case 'shutdown':
          await handleShutdown(msg.id);
          break;
        default:
          log('warn', 'Unknown message type', { msg });
      }
    } catch (error) {
      log('error', 'Failed to process message', {
        error: error instanceof Error ? error.message : String(error),
        line: line.substring(0, 200),
      });

      send({
        type: 'error',
        error: `Failed to process message: ${error instanceof Error ? error.message : String(error)}`,
        fatal: false,
      });
    }
  });

  // Handle readline close
  readline.on('close', async () => {
    if (!isShuttingDown) {
      isShuttingDown = true;
      log('info', 'Stdin closed, shutting down...');

      if (storage) {
        try {
          await storage.close();
        } catch {
          // Ignore close errors on forced shutdown
        }
      }

      process.exit(0);
    }
  });

  // Handle signals
  process.on('SIGTERM', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'SIGTERM received');

    if (storage) {
      try {
        await storage.close();
      } catch {
        // Ignore
      }
    }

    process.exit(0);
  });

  process.on('SIGINT', async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('info', 'SIGINT received');

    if (storage) {
      try {
        await storage.close();
      } catch {
        // Ignore
      }
    }

    process.exit(0);
  });

  // Signal ready
  send({
    type: 'ready',
    memoryUsageMb: getMemoryUsageMb(),
  });
}

// Run main
main().catch(async (error) => {
  log('error', 'Uncaught error in main', {
    error: error instanceof Error ? error.message : String(error),
  });

  if (storage) {
    try {
      await storage.close();
    } catch {
      // Ignore
    }
  }

  process.exit(1);
});
