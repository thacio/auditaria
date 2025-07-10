/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type SupportedLanguage = string;

export interface LanguageInfo {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
}

export const LANGUAGE_MAP: Record<SupportedLanguage, LanguageInfo> = {
  en: {
    code: 'en',
    name: 'English',
    nativeName: 'English'
  },
  pt: {
    code: 'pt', 
    name: 'Portuguese',
    nativeName: 'Português'
  }
};

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
