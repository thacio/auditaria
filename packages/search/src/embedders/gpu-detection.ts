/**
 * GPU Detection and Configuration Resolution.
 *
 * Provides utilities for detecting GPU availability and resolving
 * optimal device/quantization settings for embeddings.
 */

import type { EmbedderDevice, EmbedderQuantization } from './types.js';

// ============================================================================
// Debug Logging
// ============================================================================

const DEBUG =
  process.env.DEBUG?.includes('auditaria:embedder') ||
  process.env.DEBUG?.includes('auditaria:*');

/**
 * Log debug messages for embedder operations.
 * Only outputs when DEBUG=auditaria:embedder or DEBUG=auditaria:* is set.
 */
export function debugLog(message: string): void {
  if (DEBUG) {
    console.log(`[Embedder] ${message}`);
  }
}

// ============================================================================
// GPU Detection Result
// ============================================================================

/**
 * Result of GPU detection.
 */
export interface GpuDetectionResult {
  /** Whether a GPU is available for use */
  available: boolean;
  /** The detected device type, or null if none available */
  device: 'dml' | 'cuda' | null;
  /** Reason why GPU is not available (for debugging) */
  reason?: string;
  /** GPU capabilities if detected */
  capabilities?: {
    deviceName?: string;
    memoryMB?: number;
  };
}

// ============================================================================
// Resolution Functions
// ============================================================================

/**
 * Resolve 'auto' device to the best available option for the current platform.
 *
 * - Windows: 'dml' (DirectML, built into Windows)
 * - Linux: 'cuda' (will fallback if CUDA not available)
 * - macOS: 'cpu' (no GPU acceleration available)
 *
 * @param device - The configured device ('auto' or specific device)
 * @returns The resolved device type
 */
export function resolveDevice(device: 'auto' | EmbedderDevice): EmbedderDevice {
  if (device !== 'auto') {
    return device;
  }

  // Auto-detection based on platform
  if (process.platform === 'win32') {
    debugLog('Platform: Windows - will try DirectML');
    return 'dml';
  }

  if (process.platform === 'linux') {
    debugLog('Platform: Linux - will try CUDA');
    return 'cuda';
  }

  debugLog(`Platform: ${process.platform} - using CPU (no GPU acceleration)`);
  return 'cpu';
}

/**
 * Resolve 'auto' quantization based on the target device.
 *
 * - GPU (dml/cuda): 'fp16' - GPUs excel at half-precision
 * - CPU: 'q8' - INT8 is optimized for CPU with VNNI/AVX
 *
 * @param quantization - The configured quantization ('auto' or specific)
 * @param device - The resolved device type
 * @returns The resolved quantization type
 */
export function resolveQuantization(
  quantization: 'auto' | EmbedderQuantization,
  device: EmbedderDevice,
): EmbedderQuantization {
  if (quantization !== 'auto') {
    return quantization;
  }

  // Auto resolution based on device
  if (device === 'dml' || device === 'cuda') {
    debugLog('GPU device detected - using fp16 quantization');
    return 'fp16';
  }

  debugLog('CPU device - using q8 quantization');
  return 'q8';
}

/**
 * Check if a device is a GPU device.
 */
export function isGpuDevice(device: EmbedderDevice): boolean {
  return device === 'dml' || device === 'cuda';
}

// ============================================================================
// Resolved Configuration
// ============================================================================

/**
 * Fully resolved embedder configuration after auto-detection.
 */
export interface ResolvedEmbedderConfig {
  /** The actual device being used */
  device: EmbedderDevice;
  /** The actual quantization being used */
  quantization: EmbedderQuantization;
  /** Whether a GPU was detected as potentially available */
  gpuDetected: boolean;
  /** Whether GPU is actually being used for indexing */
  gpuUsedForIndexing: boolean;
  /** Reason for fallback if GPU was detected but not used */
  fallbackReason?: string;
}

/**
 * Create initial resolved config based on detection.
 *
 * @param device - Target device ('auto' or specific)
 * @param quantization - Target quantization ('auto' or specific)
 * @param preferGpu - Whether to prefer GPU for indexing
 */
export function createResolvedConfig(
  device: 'auto' | EmbedderDevice,
  quantization: 'auto' | EmbedderQuantization,
  preferGpu: boolean,
): ResolvedEmbedderConfig {
  const resolvedDevice = resolveDevice(device);
  const gpuDetected = isGpuDevice(resolvedDevice);

  // If user doesn't prefer GPU or no GPU detected, use CPU
  const effectiveDevice = preferGpu && gpuDetected ? resolvedDevice : 'cpu';

  // Resolve quantization based on the INTENDED device (for consistency)
  // Even if we fall back to CPU later, we keep fp16 for consistency
  const resolvedQuantization = resolveQuantization(
    quantization,
    preferGpu && gpuDetected ? resolvedDevice : 'cpu',
  );

  return {
    device: effectiveDevice,
    quantization: resolvedQuantization,
    gpuDetected,
    gpuUsedForIndexing: preferGpu && gpuDetected,
    fallbackReason: undefined,
  };
}

/**
 * Update resolved config after a fallback occurs.
 */
export function applyFallback(
  config: ResolvedEmbedderConfig,
  reason: string,
): ResolvedEmbedderConfig {
  debugLog(`GPU fallback: ${reason}`);

  return {
    ...config,
    device: 'cpu',
    gpuUsedForIndexing: false,
    fallbackReason: reason,
    // NOTE: quantization stays the same for consistency
  };
}
