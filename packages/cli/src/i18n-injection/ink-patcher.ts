/**
 * Ink Text component patcher for automatic translation
 */

import { translationManager } from './TranslationManager.js';
import { debug } from './debug.js';

// Track recursion depth to prevent infinite loops
let translationDepth = 0;
const MAX_TRANSLATION_DEPTH = 3;

/**
 * Check if we're in a context where translation should be disabled
 */
function isTranslationDisabled(): boolean {
  // Check environment variable
  if (process.env.DISABLE_I18N_INJECTION === 'true') {
    return true;
  }

  // Check if we're in a chat/tool context (this would need to be set by the app)
  if ((global as any).__i18n_context === 'chat' || (global as any).__i18n_context === 'tool') {
    return true;
  }

  return false;
}

/**
 * Translate text if it's a string
 */
export function translateText(children: any): any {
  // Early returns for non-translatable content
  if (isTranslationDisabled()) {
    return children;
  }

  // Prevent infinite recursion
  if (translationDepth >= MAX_TRANSLATION_DEPTH) {
    debug.error('Max translation depth reached, returning original');
    return children;
  }

  // Only translate strings
  if (typeof children !== 'string') {
    return children;
  }

  // Empty or whitespace-only strings
  if (!children || !children.trim()) {
    return children;
  }

  translationDepth++;

  try {
    // Initialize if needed (should be done at app startup, but just in case)
    if (!translationManager.isInitialized()) {
      // Don't wait for async initialization, return original
      translationManager.initialize().catch(err => {
        debug.error('Failed to initialize translation manager', err);
      });
      return children;
    }

    // Perform translation
    const translated = translationManager.translate(children);

    return translated;
  } catch (error) {
    debug.error('Translation error', error);
    return children;
  } finally {
    translationDepth--;
  }
}

/**
 * Initialize the i18n injection system
 * This should be called early in the application startup
 */
export async function initializeI18nInjection(): Promise<void> {
  debug.log('Initializing i18n injection system');

  try {
    await translationManager.initialize();
    debug.log('i18n injection system initialized successfully');
  } catch (error) {
    debug.error('Failed to initialize i18n injection system', error);
  }
}

// Export for global access if needed
if (typeof global !== 'undefined') {
  (global as any).__i18n_translate = translateText;
  (global as any).__i18n_manager = translationManager;
}