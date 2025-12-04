/**
 * Simple logger for browser-agent with log level support.
 *
 * Control via BROWSER_AGENT_LOG_LEVEL environment variable:
 *   - 'debug' → shows everything (debug, info, warn, error)
 *   - 'info'  → shows info, warn, error
 *   - 'warn'  → shows warn + error (default)
 *   - 'error' → shows only errors
 *
 * Example: BROWSER_AGENT_LOG_LEVEL=debug auditaria
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const getLogLevel = (): number => {
  const envLevel = process.env.BROWSER_AGENT_LOG_LEVEL?.toLowerCase() as LogLevel;
  return LEVELS[envLevel] ?? LEVELS.warn;
};

const currentLevel = getLogLevel();

const shouldLog = (level: LogLevel): boolean => LEVELS[level] >= currentLevel;

export const logger = {
  debug: (...args: unknown[]): void => {
    if (shouldLog('debug')) console.log(...args);
  },
  info: (...args: unknown[]): void => {
    if (shouldLog('info')) console.log(...args);
  },
  warn: (...args: unknown[]): void => {
    if (shouldLog('warn')) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    if (shouldLog('error')) console.error(...args);
  },
};
