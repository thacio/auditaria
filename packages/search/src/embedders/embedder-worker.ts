/**
 * Embedder Worker Script.
 * Runs TransformersJsEmbedder in a worker thread to avoid blocking the main thread.
 *
 * This script is spawned by WorkerEmbedder and handles embedding requests
 * via message passing.
 */

import { parentPort } from 'node:worker_threads';
import { TransformersJsEmbedder } from './TransformersJsEmbedder.js';
import type {
  WorkerRequest,
  WorkerResponse,
  InitializedResponse,
  EmbeddingResponse,
  EmbeddingBatchResponse,
  ReadyResponse,
  DisposedResponse,
  ErrorResponse,
  ProgressResponse,
  WarningResponse,
} from './worker-types.js';

// ============================================================================
// Worker State
// ============================================================================

let embedder: TransformersJsEmbedder | null = null;
let batchCounter = 0;

// ============================================================================
// Memory Logging (for debugging)
// ============================================================================

function logWorkerMemory(context: string): void {
  const mem = process.memoryUsage();
  // Send via message to main thread (console.log doesn't show from workers)
  parentPort?.postMessage({
    type: 'worker_memory',
    context,
    batch: batchCounter,
    memory: {
      heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(2),
      heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(2),
      external: (mem.external / 1024 / 1024).toFixed(2),
      rss: (mem.rss / 1024 / 1024).toFixed(2),
    },
  });
}

// ============================================================================
// Message Sending Helpers
// ============================================================================

function sendResponse(response: WorkerResponse): void {
  parentPort?.postMessage(response);
}

function sendError(id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendResponse({ type: 'error', id, error: message } as ErrorResponse);
}

function sendProgress(
  id: string,
  progress: import('./types.js').ProgressInfo,
): void {
  sendResponse({ type: 'progress', id, progress } as ProgressResponse);
}

// ============================================================================
// Request Handlers
// ============================================================================

async function handleInitialize(
  request: WorkerRequest & { type: 'initialize' },
): Promise<void> {
  try {
    const config = request.config ?? {};

    // Create embedder with device, quantization, and warning callback
    embedder = new TransformersJsEmbedder({
      ...config,
      // Explicitly pass device and quantization for GPU support
      device: config.device ?? 'cpu',
      quantization: config.quantization ?? 'q8',
      onWarning: (warning) => {
        sendResponse({
          type: 'warning',
          id: request.id,
          warning: {
            type: warning.type,
            message: warning.message,
            originalBatchSize: warning.originalBatchSize,
            newBatchSize: warning.newBatchSize,
          },
        } as WarningResponse);
      },
    });

    // Initialize with progress callback
    await embedder.initialize((progress) => {
      sendProgress(request.id, progress);
    });

    // Log baseline memory after model load
    logWorkerMemory('initialized');

    // Send success response with embedder info including device/quantization
    sendResponse({
      type: 'initialized',
      id: request.id,
      success: true,
      dimensions: embedder.dimensions,
      modelId: embedder.modelId,
      isMultilingual: embedder.isMultilingual,
      device: embedder.device,
      quantization: embedder.quantization,
    } as InitializedResponse);
  } catch (error) {
    sendResponse({
      type: 'initialized',
      id: request.id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    } as InitializedResponse);
  }
}

async function handleEmbed(
  request: WorkerRequest & { type: 'embed' },
): Promise<void> {
  if (!embedder || !embedder.isReady()) {
    sendError(request.id, 'Embedder not initialized');
    return;
  }

  try {
    const result = await embedder.embed(request.text);
    sendResponse({
      type: 'embedding',
      id: request.id,
      result,
    } as EmbeddingResponse);
  } catch (error) {
    sendError(request.id, error);
  }
}

async function handleEmbedBatch(
  request: WorkerRequest & { type: 'embedBatch' },
): Promise<void> {
  if (!embedder || !embedder.isReady()) {
    sendError(request.id, 'Embedder not initialized');
    return;
  }

  try {
    const result = await embedder.embedBatch(request.texts);
    sendResponse({
      type: 'embeddingBatch',
      id: request.id,
      result,
    } as EmbeddingBatchResponse);
  } catch (error) {
    sendError(request.id, error);
  }
}

async function handleEmbedQuery(
  request: WorkerRequest & { type: 'embedQuery' },
): Promise<void> {
  if (!embedder || !embedder.isReady()) {
    sendError(request.id, 'Embedder not initialized');
    return;
  }

  try {
    const result = await embedder.embedQuery(request.query);
    sendResponse({
      type: 'embedding',
      id: request.id,
      result,
    } as EmbeddingResponse);
  } catch (error) {
    sendError(request.id, error);
  }
}

async function handleEmbedDocument(
  request: WorkerRequest & { type: 'embedDocument' },
): Promise<void> {
  if (!embedder || !embedder.isReady()) {
    sendError(request.id, 'Embedder not initialized');
    return;
  }

  try {
    const result = await embedder.embedDocument(request.text);
    sendResponse({
      type: 'embedding',
      id: request.id,
      result,
    } as EmbeddingResponse);
  } catch (error) {
    sendError(request.id, error);
  }
}

async function handleEmbedBatchDocuments(
  request: WorkerRequest & { type: 'embedBatchDocuments' },
): Promise<void> {
  if (!embedder || !embedder.isReady()) {
    sendError(request.id, 'Embedder not initialized');
    return;
  }

  try {
    batchCounter++;
    // Log memory every 10 batches to avoid flooding
    if (batchCounter % 10 === 0) {
      logWorkerMemory('before');
    }

    const result = await embedder.embedBatchDocuments(request.texts);

    if (batchCounter % 10 === 0) {
      logWorkerMemory('after');
    }

    sendResponse({
      type: 'embeddingBatch',
      id: request.id,
      result,
    } as EmbeddingBatchResponse);
  } catch (error) {
    sendError(request.id, error);
  }
}

function handleIsReady(request: WorkerRequest & { type: 'isReady' }): void {
  const isReady = embedder?.isReady() ?? false;
  sendResponse({ type: 'ready', id: request.id, isReady } as ReadyResponse);
}

async function handleDispose(
  request: WorkerRequest & { type: 'dispose' },
): Promise<void> {
  try {
    if (embedder) {
      await embedder.dispose();
      embedder = null;
    }
    sendResponse({ type: 'disposed', id: request.id } as DisposedResponse);
  } catch (error) {
    sendError(request.id, error);
  }
}

// ============================================================================
// Message Handler
// ============================================================================

async function handleMessage(request: WorkerRequest): Promise<void> {
  switch (request.type) {
    case 'initialize':
      await handleInitialize(request);
      break;
    case 'embed':
      await handleEmbed(request);
      break;
    case 'embedBatch':
      await handleEmbedBatch(request);
      break;
    case 'embedQuery':
      await handleEmbedQuery(request);
      break;
    case 'embedDocument':
      await handleEmbedDocument(request);
      break;
    case 'embedBatchDocuments':
      await handleEmbedBatchDocuments(request);
      break;
    case 'isReady':
      handleIsReady(request);
      break;
    case 'dispose':
      await handleDispose(request);
      break;
    default:
      // Type guard - should never happen
      sendError(
        (request as WorkerRequest).id,
        `Unknown request type: ${(request as { type: string }).type}`,
      );
  }
}

// ============================================================================
// Worker Initialization
// ============================================================================

if (parentPort) {
  parentPort.on('message', (request: WorkerRequest) => {
    handleMessage(request).catch((error) => {
      // Catch any unhandled errors in the message handler
      console.error('[EmbedderWorker] Unhandled error:', error);
      sendError(request.id, error);
    });
  });

  // Signal that worker is ready to receive messages
  parentPort.postMessage({ type: 'worker_ready' });
} else {
  console.error(
    '[EmbedderWorker] No parentPort available - not running as worker thread',
  );
}
