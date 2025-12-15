/**
 * Tests for Logger class.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, readFileSync } from 'node:fs';
import {
  Logger,
  LogLevel,
  ModuleLogger,
  parseLogLevel,
  globalLogger,
  createModuleLogger,
} from './Logger.js';

describe('Logger', () => {
  let logger: Logger;
  const testLogFile = './test-logger-output.log';

  beforeEach(() => {
    logger = new Logger({
      level: LogLevel.DEBUG,
      console: false, // Disable console for tests
      json: false,
    });
  });

  afterEach(() => {
    // Clean up test log file
    if (existsSync(testLogFile)) {
      unlinkSync(testLogFile);
    }
  });

  describe('Configuration', () => {
    it('should use default configuration', () => {
      const defaultLogger = new Logger();
      const config = defaultLogger.getConfig();

      expect(config.level).toBe(LogLevel.INFO);
      expect(config.console).toBe(true);
      expect(config.json).toBe(false);
      expect(config.includeMemory).toBe(false);
      expect(config.modules).toEqual([]);
    });

    it('should accept custom configuration', () => {
      const customLogger = new Logger({
        level: LogLevel.WARN,
        console: false,
        json: true,
        includeMemory: true,
        modules: ['TestModule'],
      });
      const config = customLogger.getConfig();

      expect(config.level).toBe(LogLevel.WARN);
      expect(config.console).toBe(false);
      expect(config.json).toBe(true);
      expect(config.includeMemory).toBe(true);
      expect(config.modules).toEqual(['TestModule']);
    });

    it('should update configuration at runtime', () => {
      logger.setLevel(LogLevel.ERROR);
      expect(logger.getConfig().level).toBe(LogLevel.ERROR);

      logger.setConsole(true);
      expect(logger.getConfig().console).toBe(true);

      logger.setModules(['Module1', 'Module2']);
      expect(logger.getConfig().modules).toEqual(['Module1', 'Module2']);
    });
  });

  describe('Log Levels', () => {
    it('should respect log level filtering', () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

      logger.configure({ console: true, level: LogLevel.INFO });
      logger.debug('TestModule', 'Debug message'); // Should be filtered

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should log messages at or above configured level', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.configure({ console: true, level: LogLevel.INFO });
      logger.info('TestModule', 'Info message'); // Should pass

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should filter by module when modules are specified', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.configure({ console: true, level: LogLevel.DEBUG, modules: ['AllowedModule'] });

      logger.info('AllowedModule', 'Should appear');
      expect(consoleSpy).toHaveBeenCalledTimes(1);

      logger.info('BlockedModule', 'Should not appear');
      expect(consoleSpy).toHaveBeenCalledTimes(1); // Still 1, not 2

      consoleSpy.mockRestore();
    });
  });

  describe('Log Methods', () => {
    it('should have all log level methods', () => {
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.fatal).toBe('function');
    });

    it('should accept optional data parameter', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.configure({ console: true, level: LogLevel.DEBUG });
      logger.info('TestModule', 'Message with data', { key: 'value', count: 42 });

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('key');
      expect(output).toContain('value');

      consoleSpy.mockRestore();
    });
  });

  describe('Memory Tracking', () => {
    it('should return memory snapshot', () => {
      const memory = logger.getMemorySnapshot();

      expect(typeof memory.heapUsed).toBe('number');
      expect(typeof memory.heapTotal).toBe('number');
      expect(typeof memory.external).toBe('number');
      expect(typeof memory.arrayBuffers).toBe('number');
      expect(typeof memory.rss).toBe('number');

      // Values should be in MB (reasonable range)
      expect(memory.heapUsed).toBeGreaterThan(0);
      expect(memory.heapUsed).toBeLessThan(10000); // Less than 10GB
    });

    it('should log memory with logMemory()', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      logger.configure({ console: true, level: LogLevel.DEBUG });
      logger.logMemory('TestModule', 'Memory checkpoint');

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('heapUsedMB');

      consoleSpy.mockRestore();
    });
  });

  describe('Timing Utilities', () => {
    it('should track timer duration', async () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      logger.configure({ console: true, level: LogLevel.DEBUG });

      logger.startTimer('testOperation');
      await new Promise((resolve) => setTimeout(resolve, 50)); // Wait 50ms
      const duration = logger.endTimer('testOperation', 'TestModule', 'Operation complete');

      expect(duration).toBeGreaterThanOrEqual(40); // Allow some variance
      expect(duration).toBeLessThan(200);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should return -1 for non-existent timer', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      logger.configure({ console: true, level: LogLevel.DEBUG });

      const duration = logger.endTimer('nonExistent', 'TestModule', 'Should warn');

      expect(duration).toBe(-1);
      warnSpy.mockRestore();
    });

    it('should track memory delta when enabled', async () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      logger.configure({ console: true, level: LogLevel.DEBUG });

      logger.startTimer('memoryTest', true); // Enable memory tracking

      // Allocate some memory
      const arr = new Array(100000).fill('test');

      const duration = logger.endTimer('memoryTest', 'TestModule', 'Memory test');

      expect(duration).toBeGreaterThan(0);
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('memoryDelta');

      // Clean up to avoid memory issues
      arr.length = 0;
      consoleSpy.mockRestore();
    });

    it('should measure async function with measure()', async () => {
      const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      logger.configure({ console: true, level: LogLevel.DEBUG });

      const result = await logger.measure('asyncOp', 'TestModule', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return 'completed';
      });

      expect(result).toBe('completed');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('Benchmarking', () => {
    it('should record benchmark statistics', () => {
      logger.benchmark('testBench', 100);
      logger.benchmark('testBench', 150);
      logger.benchmark('testBench', 50);

      const stats = logger.getBenchmarkStats('testBench');

      expect(stats).toBeDefined();
      expect(stats!.count).toBe(3);
      expect(stats!.totalMs).toBe(300);
      expect(stats!.avgMs).toBe(100);
      expect(stats!.minMs).toBe(50);
      expect(stats!.maxMs).toBe(150);
      expect(stats!.lastMs).toBe(50);
    });

    it('should return undefined for non-existent benchmark', () => {
      const stats = logger.getBenchmarkStats('nonExistent');
      expect(stats).toBeUndefined();
    });

    it('should reset benchmarks', () => {
      logger.benchmark('toReset', 100);
      expect(logger.getBenchmarkStats('toReset')).toBeDefined();

      logger.resetBenchmarks();
      expect(logger.getBenchmarkStats('toReset')).toBeUndefined();
    });

    it('should get all benchmark stats', () => {
      logger.benchmark('bench1', 100);
      logger.benchmark('bench2', 200);

      const allStats = logger.getAllBenchmarkStats();

      expect(allStats.size).toBe(2);
      expect(allStats.has('bench1')).toBe(true);
      expect(allStats.has('bench2')).toBe(true);
    });
  });

  describe('File Output', () => {
    it('should write logs to file in JSON format', async () => {
      const fileLogger = new Logger({
        level: LogLevel.DEBUG,
        console: false,
        filePath: testLogFile,
        json: true,
      });

      fileLogger.info('TestModule', 'Test message', { key: 'value' });

      // Wait for async file write
      await fileLogger.close();

      expect(existsSync(testLogFile)).toBe(true);

      const content = readFileSync(testLogFile, 'utf-8');
      const entry = JSON.parse(content.trim());

      expect(entry.module).toBe('TestModule');
      expect(entry.message).toBe('Test message');
      expect(entry.levelName).toBe('INFO');
      expect(entry.data.key).toBe('value');
    });

    it('should append multiple log entries to file', async () => {
      const fileLogger = new Logger({
        level: LogLevel.DEBUG,
        console: false,
        filePath: testLogFile,
      });

      fileLogger.info('Module1', 'First message');
      fileLogger.info('Module2', 'Second message');
      fileLogger.warn('Module3', 'Third message');

      await fileLogger.close();

      const content = readFileSync(testLogFile, 'utf-8');
      const lines = content.trim().split('\n');

      expect(lines.length).toBe(3);
    });
  });

  describe('ModuleLogger', () => {
    it('should create child logger with fixed module', () => {
      const moduleLog = logger.child('FixedModule');

      expect(moduleLog).toBeInstanceOf(ModuleLogger);
    });

    it('should use fixed module name for all methods', () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      logger.configure({ console: true, level: LogLevel.DEBUG });

      const moduleLog = logger.child('FixedModule');
      moduleLog.info('Test message');

      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0];
      expect(output).toContain('FixedModule');

      consoleSpy.mockRestore();
    });

    it('should have all logging methods', () => {
      const moduleLog = logger.child('TestModule');

      expect(typeof moduleLog.debug).toBe('function');
      expect(typeof moduleLog.info).toBe('function');
      expect(typeof moduleLog.warn).toBe('function');
      expect(typeof moduleLog.error).toBe('function');
      expect(typeof moduleLog.fatal).toBe('function');
      expect(typeof moduleLog.logMemory).toBe('function');
      expect(typeof moduleLog.startTimer).toBe('function');
      expect(typeof moduleLog.endTimer).toBe('function');
      expect(typeof moduleLog.measure).toBe('function');
      expect(typeof moduleLog.benchmark).toBe('function');
    });
  });

  describe('parseLogLevel', () => {
    it('should parse log level strings', () => {
      expect(parseLogLevel('DEBUG')).toBe(LogLevel.DEBUG);
      expect(parseLogLevel('debug')).toBe(LogLevel.DEBUG);
      expect(parseLogLevel('INFO')).toBe(LogLevel.INFO);
      expect(parseLogLevel('WARN')).toBe(LogLevel.WARN);
      expect(parseLogLevel('WARNING')).toBe(LogLevel.WARN);
      expect(parseLogLevel('ERROR')).toBe(LogLevel.ERROR);
      expect(parseLogLevel('FATAL')).toBe(LogLevel.FATAL);
      expect(parseLogLevel('SILENT')).toBe(LogLevel.SILENT);
      expect(parseLogLevel('OFF')).toBe(LogLevel.SILENT);
      expect(parseLogLevel('NONE')).toBe(LogLevel.SILENT);
    });

    it('should default to INFO for unknown levels', () => {
      expect(parseLogLevel('UNKNOWN')).toBe(LogLevel.INFO);
      expect(parseLogLevel('')).toBe(LogLevel.INFO);
    });
  });

  describe('Global Logger', () => {
    it('should export global logger instance', () => {
      expect(globalLogger).toBeInstanceOf(Logger);
    });

    it('should create module logger from global instance', () => {
      const moduleLog = createModuleLogger('GlobalTest');
      expect(moduleLog).toBeInstanceOf(ModuleLogger);
    });
  });
});
