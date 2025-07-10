/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type SupportedLanguage = 'en' | 'pt';

export interface TranslationKey {
  key: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface TranslationData {
  [key: string]: string | TranslationData;
}

export interface LoadedTranslations {
  en?: TranslationData;
  pt?: TranslationData;
}

export interface TranslationConfig {
  defaultLanguage: SupportedLanguage;
  currentLanguage: SupportedLanguage;
  fallbackLanguage: SupportedLanguage;
}
