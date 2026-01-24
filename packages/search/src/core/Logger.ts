/**
 * Logger - Production-grade logging system for the search package.
 *
 * Features:
 * - Log levels: DEBUG, INFO, WARN, ERROR, FATAL
 * - Multiple outputs: console, file, or both
 * - Structured logging (JSON) or human-readable format
 * - Module-based filtering
 * - Performance timing utilities
 * - Memory usage tracking
 * - Benchmarking support
 *
 * Industry best practices implemented:
 * - RFC 5424 severity levels
 * - Structured logging for machine parsing
 * - Context propagation (module, function, data)
 * - Non-blocking file writes
 * - Configurable at runtime
 */

import { appendFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ============================================================================
// Types and Enums
// ============================================================================

/**
 * Log severity levels (RFC 5424 inspired).
 * Lower number = more verbose.
 */
export enum LogLevel {
  DEBUG = 0, // Detailed debugging information
  INFO = 1, // General operational information
  WARN = 2, // Warning conditions
  ERROR = 3, // Error conditions
  FATAL = 4, // Critical errors causing shutdown
  SILENT = 5, // Disable all logging
}

/** String names for log levels */
const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
  [LogLevel.FATAL]: 'FATAL',
  [LogLevel.SILENT]: 'SILENT',
};

/** Console colors for log levels */
const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: '\x1b[36m', // Cyan
  [LogLevel.INFO]: '\x1b[32m', // Green
  [LogLevel.WARN]: '\x1b[33m', // Yellow
  [LogLevel.ERROR]: '\x1b[31m', // Red
  [LogLevel.FATAL]: '\x1b[35m', // Magenta
  [LogLevel.SILENT]: '',
};

const RESET_COLOR = '\x1b[0m';

/**
 * Memory usage snapshot.
 */
export interface MemorySnapshot {
  /** Heap used in MB */
  heapUsed: number;
  /** Heap total in MB */
  heapTotal: number;
  /** External memory in MB */
  external: number;
  /** Array buffers in MB */
  arrayBuffers: number;
  /** RSS (Resident Set Size) in MB */
  rss: number;
}

/**
 * A single log entry.
 */
export interface LogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Numeric level */
  level: LogLevel;
  /** Level name (DEBUG, INFO, etc.) */
  levelName: string;
  /** Module/component name */
  module: string;
  /** Log message */
  message: string;
  /** Additional structured data */
  data?: Record<string, unknown>;
  /** Memory snapshot (if enabled) */
  memory?: MemorySnapshot;
  /** Duration in ms (for timed operations) */
  durationMs?: number;
}

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  /** Minimum level to log (default: INFO) */
  level: LogLevel;
  /** Enable console output (default: true) */
  console: boolean;
  /** File path for log output (default: undefined = no file) */
  filePath?: string;
  /** Use JSON format (default: false = human readable) */
  json: boolean;
  /** Include memory stats in every log (default: false) */
  includeMemory: boolean;
  /** Only log these modules (empty = all modules) */
  modules: string[];
  /** Use colors in console output (default: true) */
  colors: boolean;
  /** Include timestamp in console output (default: true) */
  timestamps: boolean;
}

/**
 * Timer entry for benchmarking.
 */
interface TimerEntry {
  startTime: number;
  startMemory?: MemorySnapshot;
}

/**
 * Benchmark statistics.
 */
export interface BenchmarkStats {
  /** Number of calls */
  count: number;
  /** Total duration in ms */
  totalMs: number;
  /** Average duration in ms */
  avgMs: number;
  /** Minimum duration in ms */
  minMs: number;
  /** Maximum duration in ms */
  maxMs: number;
  /** Last duration in ms */
  lastMs: number;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_CONFIG: LoggerConfig = {
  level: LogLevel.INFO,
  console: true,
  filePath: undefined,
  json: false,
  includeMemory: false,
  modules: [],
  colors: true,
  timestamps: true,
};

// ============================================================================
// Logger Class
// ============================================================================

/**
 * Production-grade logger with timing, memory tracking, and benchmarking.
 */
export class Logger {
  private config: LoggerConfig;
  private timers: Map<string, TimerEntry> = new Map();
  private benchmarks: Map<string, BenchmarkStats> = new Map();
  private initialized = false;

  // File write queue - uses array + processor pattern to avoid promise chain accumulation
  private pendingWrites: string[] = [];
  private isWriting = false;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /**
   * Update logger configuration at runtime.
   */
  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<LoggerConfig> {
    return { ...this.config };
  }

  /**
   * Set log level.
   */
  setLevel(level: LogLevel): void {
    this.config.level = level;
  }

  /**
   * Enable/disable console output.
   */
  setConsole(enabled: boolean): void {
    this.config.console = enabled;
  }

  /**
   * Set file output path.
   */
  setFilePath(path: string | undefined): void {
    this.config.filePath = path;
  }

  /**
   * Filter to specific modules.
   */
  setModules(modules: string[]): void {
    this.config.modules = modules;
  }

  // -------------------------------------------------------------------------
  // Core Logging Methods
  // -------------------------------------------------------------------------

  /**
   * Log a debug message.
   */
  debug(module: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, module, message, data);
  }

  /**
   * Log an info message.
   */
  info(module: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, module, message, data);
  }

  /**
   * Log a warning message.
   */
  warn(module: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, module, message, data);
  }

  /**
   * Log an error message.
   */
  error(module: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, module, message, data);
  }

  /**
   * Log a fatal error message.
   */
  fatal(module: string, message: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.FATAL, module, message, data);
  }

  /**
   * Core log method.
   */
  private log(
    level: LogLevel,
    module: string,
    message: string,
    data?: Record<string, unknown>,
    durationMs?: number,
  ): void {
    // Check if logging is enabled for this level
    if (level < this.config.level) return;

    // Check module filter
    if (
      this.config.modules.length > 0 &&
      !this.config.modules.includes(module)
    ) {
      return;
    }

    // Build log entry
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      levelName: LOG_LEVEL_NAMES[level],
      module,
      message,
    };

    if (data && Object.keys(data).length > 0) {
      entry.data = data;
    }

    if (durationMs !== undefined) {
      entry.durationMs = durationMs;
    }

    if (this.config.includeMemory) {
      entry.memory = this.getMemorySnapshot();
    }

    // Output to console
    if (this.config.console) {
      this.writeConsole(entry);
    }

    // Output to file
    if (this.config.filePath) {
      this.writeFile(entry);
    }
  }

  // -------------------------------------------------------------------------
  // Memory Tracking
  // -------------------------------------------------------------------------

  /**
   * Get current memory snapshot.
   */
  getMemorySnapshot(): MemorySnapshot {
    const mem = process.memoryUsage();
    return {
      heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
      arrayBuffers: Math.round((mem.arrayBuffers / 1024 / 1024) * 100) / 100,
      rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    };
  }

  /**
   * Log current memory usage.
   */
  logMemory(module: string, message: string): void {
    const memory = this.getMemorySnapshot();
    this.log(LogLevel.INFO, module, message, {
      heapUsedMB: memory.heapUsed,
      heapTotalMB: memory.heapTotal,
      externalMB: memory.external,
      arrayBuffersMB: memory.arrayBuffers,
      rssMB: memory.rss,
    });
  }

  // -------------------------------------------------------------------------
  // Timing Utilities
  // -------------------------------------------------------------------------

  /**
   * Start a timer for measuring duration.
   * @param name - Unique timer name
   * @param trackMemory - Also track memory delta (default: false)
   */
  startTimer(name: string, trackMemory = false): void {
    const entry: TimerEntry = {
      startTime: performance.now(),
    };
    if (trackMemory) {
      entry.startMemory = this.getMemorySnapshot();
    }
    this.timers.set(name, entry);
  }

  /**
   * End a timer and log the duration.
   * @param name - Timer name (must match startTimer)
   * @param module - Module name for logging
   * @param message - Log message
   * @param data - Additional data
   * @returns Duration in milliseconds, or -1 if timer not found
   */
  endTimer(
    name: string,
    module: string,
    message: string,
    data?: Record<string, unknown>,
  ): number {
    const entry = this.timers.get(name);
    if (!entry) {
      this.warn('Logger', `Timer '${name}' not found`);
      return -1;
    }

    const durationMs =
      Math.round((performance.now() - entry.startTime) * 100) / 100;
    this.timers.delete(name);

    // Build log data
    const logData: Record<string, unknown> = {
      ...data,
      durationMs,
    };

    // Add memory delta if tracked
    if (entry.startMemory) {
      const endMemory = this.getMemorySnapshot();
      logData.memoryDelta = {
        heapUsedMB:
          Math.round((endMemory.heapUsed - entry.startMemory.heapUsed) * 100) /
          100,
        externalMB:
          Math.round((endMemory.external - entry.startMemory.external) * 100) /
          100,
        rssMB: Math.round((endMemory.rss - entry.startMemory.rss) * 100) / 100,
      };
    }

    this.log(LogLevel.DEBUG, module, message, logData, durationMs);
    return durationMs;
  }

  /**
   * Measure an async function's execution time.
   * @param name - Operation name for logging
   * @param module - Module name
   * @param fn - Async function to measure
   * @returns The function's return value
   */
  async measure<T>(
    name: string,
    module: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.startTimer(name, true);
    try {
      return await fn();
    } finally {
      this.endTimer(name, module, `${name} completed`);
    }
  }

  // -------------------------------------------------------------------------
  // Benchmarking
  // -------------------------------------------------------------------------

  /**
   * Record a benchmark measurement.
   * Use this to track statistics over multiple calls.
   */
  benchmark(name: string, durationMs: number): void {
    let stats = this.benchmarks.get(name);
    if (!stats) {
      stats = {
        count: 0,
        totalMs: 0,
        avgMs: 0,
        minMs: Infinity,
        maxMs: 0,
        lastMs: 0,
      };
      this.benchmarks.set(name, stats);
    }

    stats.count++;
    stats.totalMs += durationMs;
    stats.avgMs = Math.round((stats.totalMs / stats.count) * 100) / 100;
    stats.minMs = Math.min(stats.minMs, durationMs);
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    stats.lastMs = durationMs;
  }

  /**
   * Get benchmark statistics.
   */
  getBenchmarkStats(name: string): BenchmarkStats | undefined {
    return this.benchmarks.get(name);
  }

  /**
   * Get all benchmark statistics.
   */
  getAllBenchmarkStats(): Map<string, BenchmarkStats> {
    return new Map(this.benchmarks);
  }

  /**
   * Log all benchmark statistics.
   */
  logBenchmarks(module: string): void {
    if (this.benchmarks.size === 0) {
      this.info(module, 'No benchmarks recorded');
      return;
    }

    const benchmarks: Record<string, BenchmarkStats> = {};
    for (const [name, stats] of this.benchmarks) {
      benchmarks[name] = { ...stats };
    }

    this.info(module, 'Benchmark summary', { benchmarks });
  }

  /**
   * Reset benchmark statistics.
   */
  resetBenchmarks(): void {
    this.benchmarks.clear();
  }

  // -------------------------------------------------------------------------
  // Output Formatting
  // -------------------------------------------------------------------------

  /**
   * Write log entry to console.
   */
  private writeConsole(entry: LogEntry): void {
    let output: string;

    if (this.config.json) {
      output = JSON.stringify(entry);
    } else {
      output = this.formatHumanReadable(entry);
    }

    // Use appropriate console method
    switch (entry.level) {
      case LogLevel.DEBUG:
        console.debug(output);
        break;
      case LogLevel.INFO:
        console.info(output);
        break;
      case LogLevel.WARN:
        console.warn(output);
        break;
      case LogLevel.ERROR:
      case LogLevel.FATAL:
        console.error(output);
        break;
      default:
        console.log(output);
    }
  }

  /**
   * Format log entry for human reading.
   */
  private formatHumanReadable(entry: LogEntry): string {
    const parts: string[] = [];

    // Timestamp
    if (this.config.timestamps) {
      parts.push(`[${entry.timestamp}]`);
    }

    // Level with color
    if (this.config.colors) {
      const color = LOG_LEVEL_COLORS[entry.level];
      parts.push(`${color}${entry.levelName.padEnd(5)}${RESET_COLOR}`);
    } else {
      parts.push(entry.levelName.padEnd(5));
    }

    // Module
    parts.push(`[${entry.module}]`);

    // Message
    parts.push(entry.message);

    // Duration
    if (entry.durationMs !== undefined) {
      parts.push(`(${entry.durationMs}ms)`);
    }

    // Data
    if (entry.data) {
      parts.push(JSON.stringify(entry.data));
    }

    // Memory
    if (entry.memory) {
      parts.push(
        `[heap: ${entry.memory.heapUsed}/${entry.memory.heapTotal}MB, rss: ${entry.memory.rss}MB]`,
      );
    }

    return parts.join(' ');
  }

  /**
   * Write log entry to file (non-blocking).
   * Uses an array queue with a single processor to avoid promise chain memory accumulation.
   */
  private writeFile(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';

    // Add to queue
    this.pendingWrites.push(line);

    // Start processor if not already running
    if (!this.isWriting) {
      void this.processWriteQueue();
    }
  }

  /**
   * Process pending writes sequentially.
   * Uses a simple loop that drains the queue, avoiding promise chain accumulation.
   */
  private async processWriteQueue(): Promise<void> {
    if (this.isWriting || !this.config.filePath) return;

    this.isWriting = true;

    try {
      while (this.pendingWrites.length > 0) {
        const line = this.pendingWrites.shift()!;

        try {
          if (!this.initialized && !existsSync(this.config.filePath)) {
            // Ensure parent directory exists before first write
            const dir = dirname(this.config.filePath);
            if (!existsSync(dir)) {
              await mkdir(dir, { recursive: true });
            }
            await writeFile(this.config.filePath, line);
            this.initialized = true;
          } else {
            await appendFile(this.config.filePath, line);
            this.initialized = true;
          }
        } catch (err) {
          // Log to console if file write fails
          console.error('[Logger] Failed to write to file:', err);
        }
      }
    } finally {
      this.isWriting = false;

      // Check if more writes were added while we were processing
      if (this.pendingWrites.length > 0) {
        void this.processWriteQueue();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Flush pending writes and close the logger.
   */
  async close(): Promise<void> {
    // Wait for all pending writes to complete
    while (this.pendingWrites.length > 0 || this.isWriting) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Create a child logger with a fixed module name.
   */
  child(module: string): ModuleLogger {
    return new ModuleLogger(this, module);
  }
}

// ============================================================================
// Module Logger (Convenience Wrapper)
// ============================================================================

/**
 * A logger instance bound to a specific module.
 * Provides cleaner API without repeating module name.
 */
export class ModuleLogger {
  constructor(
    private readonly logger: Logger,
    private readonly module: string,
  ) {}

  debug(message: string, data?: Record<string, unknown>): void {
    this.logger.debug(this.module, message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.logger.info(this.module, message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.logger.warn(this.module, message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.logger.error(this.module, message, data);
  }

  fatal(message: string, data?: Record<string, unknown>): void {
    this.logger.fatal(this.module, message, data);
  }

  logMemory(message: string): void {
    this.logger.logMemory(this.module, message);
  }

  startTimer(name: string, trackMemory = false): void {
    this.logger.startTimer(`${this.module}:${name}`, trackMemory);
  }

  endTimer(
    name: string,
    message: string,
    data?: Record<string, unknown>,
  ): number {
    return this.logger.endTimer(
      `${this.module}:${name}`,
      this.module,
      message,
      data,
    );
  }

  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return this.logger.measure(`${this.module}:${name}`, this.module, fn);
  }

  benchmark(name: string, durationMs: number): void {
    this.logger.benchmark(`${this.module}:${name}`, durationMs);
  }
}

// ============================================================================
// Global Logger Instance
// ============================================================================

/**
 * Global logger instance.
 * Configure once at application startup, use everywhere.
 */
export const globalLogger = new Logger();

/**
 * Create a module logger from the global instance.
 */
export function createModuleLogger(module: string): ModuleLogger {
  return globalLogger.child(module);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Parse log level from string.
 */
export function parseLogLevel(level: string): LogLevel {
  const upper = level.toUpperCase();
  switch (upper) {
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'INFO':
      return LogLevel.INFO;
    case 'WARN':
    case 'WARNING':
      return LogLevel.WARN;
    case 'ERROR':
      return LogLevel.ERROR;
    case 'FATAL':
      return LogLevel.FATAL;
    case 'SILENT':
    case 'OFF':
    case 'NONE':
      return LogLevel.SILENT;
    default:
      return LogLevel.INFO;
  }
}
