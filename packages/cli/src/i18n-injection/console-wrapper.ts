/**
 * Console wrapper for automatic translation of console output
 */

import { translationManager } from './TranslationManager.js';
import { debug } from './debug.js';

// Store original console methods
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

// Track if we're already wrapping to prevent double wrapping
let isWrapped = false;

/**
 * Translate a value if it's a string
 */
function translateValue(value: any): any {
  if (typeof value !== 'string') {
    return value;
  }

  // Don't translate if we're in a disabled context
  if ((global as any).__i18n_context === 'chat' || (global as any).__i18n_context === 'tool') {
    return value;
  }

  // Don't translate debug output to prevent infinite loops
  if (value.includes('[i18n-inject]')) {
    return value;
  }

  try {
    return translationManager.translate(value);
  } catch (error) {
    debug.error('Console translation error', error);
    return value;
  }
}

/**
 * Wrap a console method with translation
 */
function wrapConsoleMethod(methodName: 'log' | 'error' | 'warn' | 'info'): void {
  const originalMethod = originalConsole[methodName];

  (console as any)[methodName] = function(...args: any[]) {
    // Translate string arguments
    const translatedArgs = args.map(arg => {
      if (typeof arg === 'string') {
        return translateValue(arg);
      }
      return arg;
    });

    // Call original method with translated arguments
    originalMethod.apply(console, translatedArgs);
  };
}

/**
 * Initialize console wrapping for i18n
 */
export function wrapConsole(): void {
  if (isWrapped) {
    debug.log('Console already wrapped, skipping');
    return;
  }

  if (process.env.DISABLE_CONSOLE_I18N === 'true') {
    debug.log('Console i18n disabled via environment variable');
    return;
  }

  debug.log('Wrapping console methods for i18n');

  try {
    // Only wrap if translation manager is initialized
    if (!translationManager.isInitialized()) {
      debug.log('Translation manager not initialized, deferring console wrapping');

      // Try again after a delay
      setTimeout(() => {
        if (translationManager.isInitialized() && !isWrapped) {
          wrapConsole();
        }
      }, 100);

      return;
    }

    wrapConsoleMethod('log');
    wrapConsoleMethod('error');
    wrapConsoleMethod('warn');
    wrapConsoleMethod('info');

    isWrapped = true;
    debug.log('Console methods wrapped successfully');
  } catch (error) {
    debug.error('Failed to wrap console methods', error);
  }
}

/**
 * Restore original console methods
 */
export function unwrapConsole(): void {
  if (!isWrapped) {
    return;
  }

  debug.log('Restoring original console methods');

  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;

  isWrapped = false;
}

/**
 * Set console context to disable translation
 */
export function setConsoleContext(context: 'chat' | 'tool' | null): void {
  (global as any).__i18n_context = context;
}