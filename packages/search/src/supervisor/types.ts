/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: SearchSystem Supervisor for automatic memory management
// This module provides automatic restart capabilities to prevent memory bloat.

import type { SupervisorStrategy, SearchSystemConfig, DeepPartial } from '../config.js';
import type {
  SearchOptions,
  SearchResponse,
  SearchStats,
  QueueStatus,
  DiscoveredFile,
} from '../types.js';

// ============================================================================
// Supervisor Configuration
// ============================================================================

/**
 * Configuration for the SearchSystem supervisor.
 */
export interface SupervisorConfig {
  /** Restart strategy. Default: 'in-process' */
  strategy: SupervisorStrategy;
  /** Restart after N documents processed. Default: 2000, 0 = disabled */
  restartThreshold: number;
  /** Memory threshold (MB) for early restart. Default: 4000 */
  memoryThresholdMb: number;
  /** Startup timeout for child process (ms). Default: 120000 (2 min) */
  startupTimeoutMs: number;
  /** Graceful shutdown timeout (ms). Default: 30000 (30 sec) */
  shutdownTimeoutMs: number;
  /** IPC call timeout (ms). Default: 300000 (5 min) for long operations */
  callTimeoutMs: number;
}

/**
 * Default supervisor configuration.
 */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  strategy: 'in-process',
  restartThreshold: 2000,
  memoryThresholdMb: 4000,
  startupTimeoutMs: 120000,
  shutdownTimeoutMs: 30000,
  callTimeoutMs: 300000,
};

// ============================================================================
// Supervisor State
// ============================================================================

/**
 * Supervisor status enum.
 */
export type SupervisorStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'restarting'
  | 'stopping'
  | 'error';

/**
 * Runtime state of the supervisor.
 */
export interface SupervisorState {
  /** Current status */
  status: SupervisorStatus;
  /** Documents processed since last restart */
  documentsProcessedSinceRestart: number;
  /** Total documents processed across all restarts */
  totalDocumentsProcessed: number;
  /** Number of restarts performed */
  restartCount: number;
  /** When the last restart occurred */
  lastRestartAt: Date | null;
  /** Current memory usage in MB */
  currentMemoryMb: number;
  /** Child process PID (only for child-process strategy) */
  childPid: number | null;
  /** Last error message */
  error: string | null;
  /** Whether the supervisor is ready for operations */
  isReady: boolean;
}

/**
 * Initial supervisor state.
 */
export const INITIAL_SUPERVISOR_STATE: SupervisorState = {
  status: 'idle',
  documentsProcessedSinceRestart: 0,
  totalDocumentsProcessed: 0,
  restartCount: 0,
  lastRestartAt: null,
  currentMemoryMb: 0,
  childPid: null,
  error: null,
  isReady: false,
};

// ============================================================================
// Supervisor Events
// ============================================================================

/**
 * Events emitted by the supervisor.
 * Includes forwarded SearchSystem events plus supervisor-specific events.
 */
export interface SupervisorEvents {
  /** Index signature for EventEmitter compatibility */
  [key: string]: unknown;

  // Forwarded from SearchSystem
  'search:started': { query: string };
  'search:completed': { query: string; resultCount: number; duration: number };
  'indexing:started': { fileCount: number };
  'indexing:progress': { current: number; total: number };
  'indexing:completed': { indexed: number; failed: number; duration: number };
  'ocr:started': { documentId: string; filePath: string; regions: number };
  'ocr:progress': {
    documentId: string;
    filePath: string;
    completed: number;
    total: number;
  };
  'ocr:completed': {
    documentId: string;
    filePath: string;
    text: string;
    confidence: number;
  };
  'ocr:failed': { documentId: string; filePath: string; error: Error };

  // Supervisor-specific events
  'supervisor:starting': { strategy: SupervisorStrategy };
  'supervisor:ready': { strategy: SupervisorStrategy; memoryMb: number };
  'supervisor:restart:starting': {
    reason: string;
    documentsProcessed: number;
    memoryMb: number;
  };
  'supervisor:restart:completed': {
    restartCount: number;
    durationMs: number;
    memoryBeforeMb: number;
    memoryAfterMb: number;
  };
  'supervisor:stopping': { reason: string };
  'supervisor:stopped': { totalDocumentsProcessed: number; restartCount: number };
  'supervisor:error': { error: string; fatal: boolean };
  'supervisor:memory:warning': { currentMb: number; thresholdMb: number };
}

// ============================================================================
// Index Result Types
// ============================================================================

/**
 * Result of an indexAll operation.
 */
export interface IndexAllResult {
  indexed: number;
  failed: number;
  duration: number;
}

/**
 * Options for indexAll operation.
 */
export interface IndexAllOptions {
  force?: boolean;
  useChildProcess?: boolean;
  maxDocuments?: number;
}

// ============================================================================
// Supervisor Initialization Options
// ============================================================================

/**
 * Options for initializing the supervisor.
 */
export interface SupervisorInitOptions {
  /** Root path to index */
  rootPath: string;
  /** SearchSystem configuration */
  config?: DeepPartial<SearchSystemConfig>;
  /** Override supervisor config */
  supervisorConfig?: Partial<SupervisorConfig>;
  /** Use mock embedder (for testing) */
  useMockEmbedder?: boolean;
  /** Logging configuration */
  logging?: {
    enabled?: boolean;
    level?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
    console?: boolean;
    filePath?: string;
    includeMemory?: boolean;
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get current memory usage in MB.
 */
export function getMemoryUsageMb(): number {
  const usage = process.memoryUsage();
  return Math.round(usage.heapUsed / 1024 / 1024);
}

/**
 * Create supervisor config from indexing config.
 */
export function createSupervisorConfig(
  indexingConfig: {
    supervisorStrategy?: SupervisorStrategy;
    supervisorRestartThreshold?: number;
    supervisorMemoryThresholdMb?: number;
  },
  overrides?: Partial<SupervisorConfig>,
): SupervisorConfig {
  return {
    ...DEFAULT_SUPERVISOR_CONFIG,
    strategy: indexingConfig.supervisorStrategy ?? DEFAULT_SUPERVISOR_CONFIG.strategy,
    restartThreshold:
      indexingConfig.supervisorRestartThreshold ??
      DEFAULT_SUPERVISOR_CONFIG.restartThreshold,
    memoryThresholdMb:
      indexingConfig.supervisorMemoryThresholdMb ??
      DEFAULT_SUPERVISOR_CONFIG.memoryThresholdMb,
    ...overrides,
  };
}
