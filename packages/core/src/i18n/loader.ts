/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SupportedLanguage,
  TranslationData,
  LoadedTranslations,
} from './types.js';

// Import translations directly - esbuild will inline these JSON files
// Note: English doesn't need a file - the key IS the English text (used as fallback)
// eslint-disable-next-line import/no-internal-modules
import ptTranslations from './locales/pt.json' with { type: 'json' };

// Bundled translations available synchronously
// English returns empty object - t() uses key as fallback
const bundledTranslations: Record<string, TranslationData> = {
  en: { _exactStrings: {} } as TranslationData,
  pt: ptTranslations as TranslationData,
};

class TranslationLoader {
  private loadedTranslations: LoadedTranslations = {};
  private initialized = false;

  /**
   * Initialize translations synchronously from bundled data
   * This is the preferred method for build-time i18n
   */
  initializeSync(): void {
    if (this.initialized) return;

    // Load all bundled translations synchronously
    for (const [lang, translations] of Object.entries(bundledTranslations)) {
      this.loadedTranslations[lang as SupportedLanguage] = translations;
    }
    this.initialized = true;
  }

  /**
   * Get translations for a specific language synchronously
   * Auto-initializes if not already done
   */
  getTranslationsSync(language: SupportedLanguage): TranslationData {
    if (!this.initialized) {
      this.initializeSync();
    }
    return this.loadedTranslations[language] || bundledTranslations['en'];
  }

  /**
   * @deprecated Use initializeSync() instead - kept for backwards compatibility
   */
  async loadLanguage(language: SupportedLanguage): Promise<TranslationData> {
    if (!this.initialized) {
      this.initializeSync();
    }
    return this.loadedTranslations[language] || ({} as TranslationData);
  }

  /**
   * @deprecated Use initializeSync() instead - kept for backwards compatibility
   */
  async loadAllLanguages(): Promise<LoadedTranslations> {
    this.initializeSync();
    return this.loadedTranslations;
  }

  getLoadedTranslations(): LoadedTranslations {
    if (!this.initialized) {
      this.initializeSync();
    }
    return this.loadedTranslations;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  clearCache(): void {
    this.loadedTranslations = {};
    this.initialized = false;
  }
}

export const translationLoader = new TranslationLoader();
