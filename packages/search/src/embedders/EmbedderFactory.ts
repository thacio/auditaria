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
import { PythonEmbedder } from './PythonEmbedder.js';
import { detectPython } from './python-detection.js';
import {
  debugLog,
  resolveDevice,
  resolveQuantization,
  isGpuDevice,
  type ResolvedEmbedderConfig,
} from './gpu-detection.js';

// ============================================================================
// Bun Detection
// ============================================================================

/**
 * Check if we're running inside a Bun compiled executable.
 * Worker threads don't work properly in Bun executables.
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
    if (metaUrl.includes('/$bunfs/') || metaUrl.includes('/~BUN/') || metaUrl.includes('%7EBUN')) {
      return true;
    }
  } catch {
    // Ignore errors
  }

  return false;
}

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
  /** Worker thread heap size in MB. Default: 4096 (4GB) */
  workerHeapSizeMb?: number;
  /**
   * Whether to prefer Python embedder over Node.js. Default: false
   * When true and Python 3.8+ is available with required packages,
   * embeddings will be generated using Python's ONNX runtime.
   * Produces IDENTICAL embeddings to Node.js implementation.
   */
  preferPythonEmbedder?: boolean;
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
  // Step 0a: Check if running in Bun executable - disable workers if so
  const isBunExe = isRunningInBunExecutable();
  let effectiveUseWorkerThread = config.useWorkerThread;
  let effectivePreferPythonEmbedder = config.preferPythonEmbedder;

  if (isBunExe) {
    console.log(
      '[EmbedderFactory] Running in Bun executable - disabling worker threads and Python embedder',
    );
    debugLog('Factory: Bun executable detected, disabling worker threads');
    effectiveUseWorkerThread = false;
    effectivePreferPythonEmbedder = false; // Python subprocess may also have issues in Bun
  }

  // Step 0b: Check if Python embedder is preferred and available
  if (effectivePreferPythonEmbedder) {
    console.log(
      '[EmbedderFactory] Python embedder preferred, checking availability...',
    );
    debugLog('Factory: Python embedder preferred, checking availability...');

    const pythonResult = await detectPython();
    if (pythonResult.available) {
      console.log(
        `[EmbedderFactory] Python ${pythonResult.version} found (${pythonResult.command}), initializing Python embedder...`,
      );
      debugLog(
        `Factory: Python ${pythonResult.version} available, using Python embedder`,
      );

      try {
        const pythonEmbedder = new PythonEmbedder({
          modelId: config.model,
          quantization:
            config.quantization === 'auto' ? 'q8' : config.quantization,
          cacheDir: config.cacheDir,
          batchSize: config.batchSize,
        });

        await pythonEmbedder.initialize(onProgress);

        const resolvedConfig: ResolvedEmbedderConfig = {
          device: 'cpu',
          quantization:
            config.quantization === 'auto' ? 'q8' : config.quantization,
          gpuDetected: false,
          gpuUsedForIndexing: false,
          pythonEmbedder: true,
        };

        console.log(
          '[EmbedderFactory] Python embedder initialized successfully',
        );
        debugLog('Factory: Python embedder initialized successfully');

        return {
          indexingEmbedder: pythonEmbedder,
          searchEmbedder: pythonEmbedder,
          resolvedConfig,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.warn(
          `[EmbedderFactory] Python embedder initialization failed: ${errorMessage}. Falling back to Node.js.`,
        );
        debugLog(
          `Factory: Python embedder initialization failed: ${errorMessage}. Falling back to Node.js.`,
        );
        // Fall through to Node.js embedder
      }
    } else {
      console.log(
        `[EmbedderFactory] Python not available (${pythonResult.error}), falling back to Node.js`,
      );
      debugLog(
        `Factory: Python not available (${pythonResult.error}), falling back to Node.js`,
      );
    }
  } else {
    console.log(
      '[EmbedderFactory] Using Node.js embedder (preferPythonEmbedder=false)',
    );
  }

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

  if (shouldTryGpu && effectiveUseWorkerThread) {
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
        workerHeapSizeMb: config.workerHeapSizeMb,
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
        workerHeapSizeMb: config.workerHeapSizeMb,
      });

      await indexingEmbedder.initialize(onProgress);
      actualDevice = 'cpu';
    }
  } else if (effectiveUseWorkerThread) {
    // CPU with worker thread
    debugLog(`Factory: Creating CPU worker embedder`);

    indexingEmbedder = new WorkerEmbedder({
      modelId: config.model,
      device: 'cpu',
      quantization: targetQuantization,
      cacheDir: config.cacheDir,
      batchSize: config.batchSize,
      workerHeapSizeMb: config.workerHeapSizeMb,
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

  console.log(
    `[EmbedderFactory] Node.js embedder ready: device=${actualDevice}, quantization=${targetQuantization}`,
  );
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
