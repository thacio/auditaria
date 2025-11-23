/**
 * Main entry point for i18n injection system
 */

import { translationManager } from './TranslationManager.js';
import { initializeI18nInjection, translateText } from './ink-patcher.js';
import { wrapConsole, unwrapConsole, setConsoleContext } from './console-wrapper.js';
import { debug } from './debug.js';

// Export all components
export {
  translationManager,
  translateText,
  initializeI18nInjection,
  wrapConsole,
  unwrapConsole,
  setConsoleContext,
  debug
};

/**
 * Initialize the entire i18n injection system
 */
export async function initialize(): Promise<void> {
  debug.log('=== Starting i18n injection initialization ===');

  try {
    // Initialize translation manager
    await initializeI18nInjection();

    // Wrap console methods (only if not disabled)
    if (process.env.DISABLE_CONSOLE_I18N !== 'true') {
      wrapConsole();
    }

    // Set up global translation function for ink patch
    if (typeof global !== 'undefined') {
      (global as any).__i18n_translate = translateText;
      (global as any).__i18n_manager = translationManager;
      debug.log('Global translation functions registered');
    }

    debug.log('=== i18n injection initialization complete ===');

    // Log statistics
    const stats = translationManager.getStats();
    debug.stats({
      language: translationManager.getLanguage(),
      initialized: translationManager.isInitialized(),
      loadTime: `${stats.loadTime}ms`
    });
  } catch (error) {
    debug.error('Failed to initialize i18n injection system', error);
  }
}

// Auto-initialize if DEBUG_I18N is set
if (process.env.DEBUG_I18N === 'true' || process.env.AUTO_INIT_I18N === 'true') {
  initialize().catch(err => {
    console.error('Auto-initialization failed:', err);
  });
}