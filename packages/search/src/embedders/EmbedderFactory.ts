/**
 * EmbedderFactory - Factory for creating embedders with GPU support.
 *
 * This factory handles:
 * - GPU detection and auto-configuration
 * - Creating separate embedders for indexing and search
 * - Graceful fallback to CPU with debug logging
 * - Ensuring dtype consistency between indexing and search
 */

import type {
  TextEmbedder,
  ProgressCallback,
  EmbedderDevice,
  EmbedderQuantization,
} from './types.js';
import { TransformersJsEmbedder } from './TransformersJsEmbedder.js';
import { WorkerEmbedder } from './WorkerEmbedder.js';
import {
  debugLog,
  resolveDevice,
  resolveQuantization,
  isGpuDevice,
  type ResolvedEmbedderConfig,
} from './gpu-detection.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Configuration for the embedder factory.
 */
export interface EmbedderFactoryConfig {
  /** Model ID (e.g., 'Xenova/multilingual-e5-small') */
  model: string;
  /** Device selection ('auto', 'cpu', 'dml', 'cuda') */
  device: 'auto' | EmbedderDevice;
  /** Quantization ('auto', 'fp32', 'fp16', 'q8', 'q4') */
  quantization: 'auto' | EmbedderQuantization;
  /** Whether to prefer GPU for indexing */
  preferGpuForIndexing: boolean;
  /** Whether to use worker thread for indexing */
  useWorkerThread: boolean;
  /** Model cache directory */
  cacheDir?: string;
  /** Batch size for embedding operations. Default: 16 */
  batchSize?: number;
}

/**
 * Result from creating embedders via the factory.
 */
export interface EmbedderFactoryResult {
  /** Embedder for indexing operations (may use GPU) */
  indexingEmbedder: TextEmbedder;
  /** Embedder for search operations (always CPU, same dtype) */
  searchEmbedder: TextEmbedder;
  /** Resolved configuration showing what was actually used */
  resolvedConfig: ResolvedEmbedderConfig;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create embedders for indexing and search with optimal GPU configuration.
 *
 * This function:
 * 1. Resolves 'auto' device and quantization based on platform
 * 2. Tries to create GPU-enabled indexing embedder if preferred
 * 3. Falls back to CPU gracefully with debug logging
 * 4. Creates CPU search embedder with same dtype for consistency
 *
 * @param config - Factory configuration
 * @param onProgress - Optional progress callback for model loading
 * @returns Embedders and resolved configuration
 */
export async function createEmbedders(
  config: EmbedderFactoryConfig,
  onProgress?: ProgressCallback,
): Promise<EmbedderFactoryResult> {
  // Step 1: Resolve device and quantization
  const targetDevice = resolveDevice(config.device);
  const gpuDetected = isGpuDevice(targetDevice);

  // Determine if we should try GPU
  const shouldTryGpu = config.preferGpuForIndexing && gpuDetected;

  // Resolve quantization based on intended device
  // If we intend to use GPU, use fp16; otherwise use q8
  const targetQuantization = resolveQuantization(
    config.quantization,
    shouldTryGpu ? targetDevice : 'cpu',
  );

  debugLog(
    `Factory: targetDevice=${targetDevice}, targetQuantization=${targetQuantization}, ` +
      `gpuDetected=${gpuDetected}, shouldTryGpu=${shouldTryGpu}`,
  );

  // Step 2: Create indexing embedder
  let indexingEmbedder: TextEmbedder;
  let actualDevice: EmbedderDevice = 'cpu';
  let fallbackReason: string | undefined;

  if (shouldTryGpu && config.useWorkerThread) {
    // Try GPU with worker thread
    try {
      debugLog(
        `Factory: Attempting GPU initialization with device=${targetDevice}`,
      );

      indexingEmbedder = new WorkerEmbedder({
        modelId: config.model,
        device: targetDevice,
        quantization: targetQuantization,
        cacheDir: config.cacheDir,
        batchSize: config.batchSize,
      });

      await indexingEmbedder.initialize(onProgress);
      actualDevice = targetDevice;

      debugLog(`Factory: GPU embedder initialized successfully`);
    } catch (error) {
      // GPU failed, fall back to CPU
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fallbackReason = errorMessage;

      debugLog(
        `Factory: GPU initialization failed: ${errorMessage}. Falling back to CPU.`,
      );

      // Create CPU embedder with same quantization for consistency
      indexingEmbedder = new WorkerEmbedder({
        modelId: config.model,
        device: 'cpu',
        quantization: targetQuantization, // Keep same dtype!
        cacheDir: config.cacheDir,
        batchSize: config.batchSize,
      });

      await indexingEmbedder.initialize(onProgress);
      actualDevice = 'cpu';
    }
  } else if (config.useWorkerThread) {
    // CPU with worker thread
    debugLog(`Factory: Creating CPU worker embedder`);

    indexingEmbedder = new WorkerEmbedder({
      modelId: config.model,
      device: 'cpu',
      quantization: targetQuantization,
      cacheDir: config.cacheDir,
      batchSize: config.batchSize,
    });

    await indexingEmbedder.initialize(onProgress);
    actualDevice = 'cpu';
  } else {
    // CPU without worker thread (direct)
    debugLog(`Factory: Creating direct CPU embedder (no worker)`);

    indexingEmbedder = new TransformersJsEmbedder({
      modelId: config.model,
      device: 'cpu',
      quantization: targetQuantization,
      cacheDir: config.cacheDir,
      batchSize: config.batchSize,
    });

    await indexingEmbedder.initialize(onProgress);
    actualDevice = 'cpu';
  }

  // Step 3: Search embedder - USE THE SAME INSTANCE as indexing embedder
  // IMPORTANT: This is NOT optional. Two critical reasons:
  // 1. ONNX Runtime native module has shared state that causes V8 HandleScope
  //    crashes when multiple embedders run concurrently (even in separate workers)
  // 2. dtype/quantization MUST match between indexing and search embeddings,
  //    otherwise vector similarity will be broken (tested and confirmed)
  // Using the same instance guarantees both constraints are satisfied.
  debugLog(
    `Factory: Using same embedder instance for search (dtype consistency guaranteed)`,
  );

  const searchEmbedder = indexingEmbedder;

  // Step 4: Build resolved config
  const resolvedConfig: ResolvedEmbedderConfig = {
    device: actualDevice,
    quantization: targetQuantization,
    gpuDetected,
    gpuUsedForIndexing: actualDevice !== 'cpu',
    fallbackReason,
  };

  debugLog(
    `Factory: Complete. device=${actualDevice}, dtype=${targetQuantization}, ` +
      `gpuUsed=${resolvedConfig.gpuUsedForIndexing}, sharedEmbedder=true`,
  );

  return {
    indexingEmbedder,
    searchEmbedder,
    resolvedConfig,
  };
}

/**
 * Create a single embedder for simple use cases.
 * Useful when you don't need separate indexing/search embedders.
 *
 * @param config - Factory configuration
 * @param onProgress - Optional progress callback
 * @returns A single embedder with resolved config
 */
export async function createSingleEmbedder(
  config: Omit<EmbedderFactoryConfig, 'preferGpuForIndexing'> & {
    preferGpu?: boolean;
  },
  onProgress?: ProgressCallback,
): Promise<{ embedder: TextEmbedder; resolvedConfig: ResolvedEmbedderConfig }> {
  const result = await createEmbedders(
    {
      ...config,
      preferGpuForIndexing: config.preferGpu ?? false,
    },
    onProgress,
  );

  // For single embedder, use the indexing one (more capable)
  return {
    embedder: result.indexingEmbedder,
    resolvedConfig: result.resolvedConfig,
  };
}
