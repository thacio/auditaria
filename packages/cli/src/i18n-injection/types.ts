/**
 * Types for the i18n injection system
 */

export interface TranslationPattern {
  pattern: string;
  replacement: string;
  flags?: string;
  regex?: RegExp;
}

export interface TranslationExclusions {
  prefixes?: string[];
  components?: string[];
  contexts?: string[];
  patterns?: string[];
}

export interface TranslationMetadata {
  version: string;
  generated: string;
  exact_count: number;
  pattern_count: number;
  language_pair: string;
}

export interface TranslationData {
  metadata: TranslationMetadata;
  exact: Record<string, string>;
  patterns: TranslationPattern[];
  exclusions: TranslationExclusions;
}

export interface TranslationStats {
  cacheHits: number;
  cacheMisses: number;
  totalTranslations: number;
  memoryUsed: number;
  loadTime: number;
}

export type Language = 'en' | 'pt';

export interface TranslationManagerConfig {
  debugMode: boolean;
  cacheSize: number;
  language: Language;
  translationPath?: string;
}