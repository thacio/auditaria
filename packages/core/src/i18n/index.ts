/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SupportedLanguage,
  TranslationData,
  TranslationConfig,
} from './types.js';
import { isLanguageSupported } from './types.js';
import { translationLoader } from './loader.js';

/**
 * Detect language from environment variables or system locale
 * Note: User settings are handled at the CLI level, not here
 * Priority: 1. AUDITARIA_LANG env, 2. System locale, 3. Default 'en'
 */
function detectLanguage(): SupportedLanguage {
  // 1. Check explicit environment variable
  const envLang = process.env.AUDITARIA_LANG;
  if (envLang && isLanguageSupported(envLang)) {
    return envLang;
  }

  // 2. Check system locale environment variables
  const locale =
    process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || '';

  // Simple detection - if locale contains 'pt', use Portuguese
  if (locale.toLowerCase().includes('pt')) {
    return 'pt';
  }

  // 3. Default to English
  return 'en';
}

class I18nManager {
  private config: TranslationConfig = {
    defaultLanguage: 'en',
    currentLanguage: 'en',
    fallbackLanguage: 'en',
  };

  private initialized = false;

  /**
   * Initialize synchronously using bundled translations
   * Auto-detects language from environment if not specified
   */
  initializeSync(language?: SupportedLanguage): void {
    if (this.initialized) return;

    // Use provided language or detect from environment
    this.config.currentLanguage = language || detectLanguage();

    // Load bundled translations synchronously
    translationLoader.initializeSync();
    this.initialized = true;
  }

  /**
   * @deprecated Use initializeSync() - kept for backwards compatibility
   */
  async initialize(language?: SupportedLanguage): Promise<void> {
    if (language) {
      this.config.currentLanguage = language;
    }

    // Now just calls sync initialization
    this.initializeSync(language);
  }

  async setLanguage(language: SupportedLanguage): Promise<void> {
    this.config.currentLanguage = language;
    // Translations are already loaded, just update the language
    if (!this.initialized) {
      this.initializeSync();
    }
  }

  setLanguageSync(language: SupportedLanguage): void {
    this.config.currentLanguage = language;
    if (!this.initialized) {
      this.initializeSync();
    }
  }

  getCurrentLanguage(): SupportedLanguage {
    return this.config.currentLanguage;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private getNestedValue(
    obj: TranslationData,
    path: string,
  ): string | undefined {
    const keys = path.split('.');
    let current: TranslationData | string = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return typeof current === 'string' ? current : undefined;
  }

  private interpolateString(
    template: string,
    params: Record<string, string | number>,
  ): string {
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
      const value = params[key];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Main translation function with fallback support
   * Auto-initializes on first call if not already initialized
   * @param key - Translation key (e.g., 'commands.docs.description') or exact string
   * @param fallback - Fallback string to use if translation is not found
   * @param params - Parameters for string interpolation
   * @returns Translated string or fallback
   */
  translate(
    key: string,
    fallback: string,
    params?: Record<string, string | number>,
  ): string {
    // Auto-initialize on first call
    if (!this.initialized) {
      this.initializeSync();
    }

    const loadedTranslations = translationLoader.getLoadedTranslations();

    // Try current language first
    const currentLangData = loadedTranslations[this.config.currentLanguage];

    if (currentLangData) {
      // Try exact string lookup FIRST (primary for build-time transformed strings)
      if (currentLangData._exactStrings && currentLangData._exactStrings[key]) {
        const exactTranslation = currentLangData._exactStrings[key];
        return params
          ? this.interpolateString(exactTranslation, params)
          : exactTranslation;
      }

      // Try nested key lookup as legacy fallback (e.g., 'commands.model.description')
      const translation = this.getNestedValue(currentLangData, key);
      if (translation) {
        return params
          ? this.interpolateString(translation, params)
          : translation;
      }
    }

    // Try fallback language if different from current
    if (this.config.fallbackLanguage !== this.config.currentLanguage) {
      const fallbackLangData = loadedTranslations[this.config.fallbackLanguage];
      if (fallbackLangData) {
        // Try exact string lookup FIRST
        if (
          fallbackLangData._exactStrings &&
          fallbackLangData._exactStrings[key]
        ) {
          const exactTranslation = fallbackLangData._exactStrings[key];
          return params
            ? this.interpolateString(exactTranslation, params)
            : exactTranslation;
        }

        // Try nested key lookup as legacy fallback
        const translation = this.getNestedValue(fallbackLangData, key);
        if (translation) {
          return params
            ? this.interpolateString(translation, params)
            : translation;
        }
      }
    }

    // Return fallback with parameter interpolation if needed
    return params ? this.interpolateString(fallback, params) : fallback;
  }

  /**
   * Get current translation data
   */
  getCurrentTranslationData(): TranslationData | null {
    if (!this.initialized) {
      this.initializeSync();
    }

    const loadedTranslations = translationLoader.getLoadedTranslations();
    if (!loadedTranslations) {
      return null;
    }

    const currentLang = this.config.currentLanguage;
    return loadedTranslations[currentLang] || null;
  }
}

// Create singleton instance
const i18nManager = new I18nManager();

/**
 * Main translation function
 * Auto-initializes on first call - no need to wait for initI18n()
 * @param key - Translation key (also used as fallback if no fallback provided)
 * @param fallback - Optional fallback string (defaults to key)
 * @param params - Parameters for interpolation
 * @returns Translated string or fallback
 */
export const t = (
  key: string,
  fallback?: string,
  params?: Record<string, string | number>,
): string => i18nManager.translate(key, fallback ?? key, params);

/**
 * Initialize i18n system
 * @deprecated t() now auto-initializes - this is kept for explicit language setting
 * @param language - Language to initialize with
 */
export const initI18n = async (language?: SupportedLanguage): Promise<void> => {
  await i18nManager.initialize(language);
};

/**
 * Get current translation data
 * @returns Current translation data or null if not initialized
 */
export const getTranslationData = (): TranslationData | null => i18nManager.getCurrentTranslationData();

/**
 * Set current language and reload translations
 * @param language - Language to set
 */
export const setLanguage = async (
  language: SupportedLanguage,
): Promise<void> => {
  await i18nManager.setLanguage(language);
};

/**
 * Get current language
 * @returns Current language
 */
export const getCurrentLanguage = (): SupportedLanguage => i18nManager.getCurrentLanguage();

// Export types and utilities
export * from './types.js';

// Export I18nText component for nested text translations
export { I18nText } from './I18nText.js';
export type { I18nTextProps } from './I18nText.js';
