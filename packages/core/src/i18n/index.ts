/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SupportedLanguage, TranslationData, TranslationConfig, LoadedTranslations } from './types.js';
import { translationLoader } from './loader.js';

class I18nManager {
  private config: TranslationConfig = {
    defaultLanguage: 'en',
    currentLanguage: 'en',
    fallbackLanguage: 'en',
  };

  private initialized = false;

  async initialize(language?: SupportedLanguage): Promise<void> {
    if (this.initialized) return;

    if (language) {
      this.config.currentLanguage = language;
    }

    await translationLoader.loadAllLanguages();
    this.initialized = true;
  }

  setLanguage(language: SupportedLanguage): void {
    this.config.currentLanguage = language;
  }

  getCurrentLanguage(): SupportedLanguage {
    return this.config.currentLanguage;
  }

  private getNestedValue(obj: TranslationData, path: string): string | undefined {
    const keys = path.split('.');
    let current: any = obj;

    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }

    return typeof current === 'string' ? current : undefined;
  }

  private interpolateString(template: string, params: Record<string, string | number>): string {
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
      const value = params[key];
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * Main translation function with fallback support
   * @param key - Translation key (e.g., 'commands.docs.description')
   * @param fallback - Fallback string to use if translation is not found
   * @param params - Parameters for string interpolation
   * @returns Translated string or fallback
   */
  translate(key: string, fallback: string, params?: Record<string, string | number>): string {
    if (!this.initialized) {
      return params ? this.interpolateString(fallback, params) : fallback;
    }

    const loadedTranslations = translationLoader.getLoadedTranslations();
    
    // Try current language first
    const currentLangData = this.config.currentLanguage === 'en' ? loadedTranslations.en : loadedTranslations.pt;
    if (currentLangData) {
      const translation = this.getNestedValue(currentLangData, key);
      if (translation) {
        return params ? this.interpolateString(translation, params) : translation;
      }
    }

    // Try fallback language if different from current
    if (this.config.fallbackLanguage !== this.config.currentLanguage) {
      const fallbackLangData = this.config.fallbackLanguage === 'en' ? loadedTranslations.en : loadedTranslations.pt;
      if (fallbackLangData) {
        const translation = this.getNestedValue(fallbackLangData, key);
        if (translation) {
          return params ? this.interpolateString(translation, params) : translation;
        }
      }
    }

    // Return fallback with parameter interpolation if needed
    return params ? this.interpolateString(fallback, params) : fallback;
  }
}

// Create singleton instance
const i18nManager = new I18nManager();

/**
 * Main translation function
 * @param key - Translation key
 * @param fallback - Fallback string
 * @param params - Parameters for interpolation
 * @returns Translated string or fallback
 */
export const t = (key: string, fallback: string, params?: Record<string, string | number>): string => {
  return i18nManager.translate(key, fallback, params);
};

/**
 * Initialize i18n system
 * @param language - Language to initialize with
 */
export const initI18n = async (language?: SupportedLanguage): Promise<void> => {
  await i18nManager.initialize(language);
};

/**
 * Set current language
 * @param language - Language to set
 */
export const setLanguage = (language: SupportedLanguage): void => {
  i18nManager.setLanguage(language);
};

/**
 * Get current language
 * @returns Current language
 */
export const getCurrentLanguage = (): SupportedLanguage => {
  return i18nManager.getCurrentLanguage();
};

// Export types for use in other files
export * from './types.js';
