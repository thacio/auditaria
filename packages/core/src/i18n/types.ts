/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type SupportedLanguage = 'en' | 'pt';

export interface LanguageInfo {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
}

/**
 * SINGLE SOURCE OF TRUTH for available languages
 * When adding a new language:
 * 1. Add it here
 * 2. Add the translation file in locales/
 * 3. Import it in loader.ts
 */
export const AVAILABLE_LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
];

/**
 * Get list of available languages (synchronous)
 */
export function getAvailableLanguages(): LanguageInfo[] {
  return AVAILABLE_LANGUAGES;
}

/**
 * Check if a language code is supported
 */
export function isLanguageSupported(code: string): code is SupportedLanguage {
  return AVAILABLE_LANGUAGES.some((lang) => lang.code === code);
}

/**
 * Get language info by code
 */
export function getLanguageInfo(
  code: SupportedLanguage,
): LanguageInfo | undefined {
  return AVAILABLE_LANGUAGES.find((lang) => lang.code === code);
}

export interface TranslationKey {
  key: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface TranslationData {
  [key: string]: string | string[] | TranslationData;
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
