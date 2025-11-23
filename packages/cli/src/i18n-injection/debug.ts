/**
 * Debug utilities for i18n injection system
 */

const DEBUG_PREFIX = '[i18n-inject]';
const DEBUG_ENABLED = true;
// const DEBUG_ENABLED = process.env.DEBUG_I18N === 'true' || process.env.DEBUG_I18N === '1';

// Always log initialization to confirm module is loaded
if (DEBUG_ENABLED) {
  console.log(`${DEBUG_PREFIX} Debug logging ENABLED (DEBUG_I18N=${process.env.DEBUG_I18N})`);
}

export class DebugLogger {
  private static instance: DebugLogger;
  private startTime: number;
  private enabled: boolean;

  private constructor() {
    this.startTime = Date.now();
    this.enabled = DEBUG_ENABLED;
  }

  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }

  log(message: string, ...args: any[]): void {
    if (!this.enabled) return;

    const elapsed = Date.now() - this.startTime;
    const timestamp = new Date().toISOString();
    console.log(`${DEBUG_PREFIX} [${timestamp}] [${elapsed}ms] ${message}`, ...args);
  }

  error(message: string, error?: any): void {
    if (!this.enabled) return;

    const elapsed = Date.now() - this.startTime;
    const timestamp = new Date().toISOString();
    console.error(`${DEBUG_PREFIX} [${timestamp}] [${elapsed}ms] ERROR: ${message}`, error || '');
  }

  stats(stats: Record<string, any>): void {
    if (!this.enabled) return;

    const statsStr = Object.entries(stats)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
    this.log(`Stats - ${statsStr}`);
  }

  translation(original: string, translated: string, method: 'exact' | 'pattern' | 'cache' | 'excluded'): void {
    if (!this.enabled) return;

    if (method === 'excluded') {
      this.log(`Excluded: "${original}"`);
    } else {
      this.log(`Translation (${method}): "${original}" → "${translated}"`);
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const debug = DebugLogger.getInstance();