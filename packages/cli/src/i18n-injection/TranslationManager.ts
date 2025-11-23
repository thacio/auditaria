/**
 * Core translation manager for i18n injection system
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type {
  TranslationData,
  TranslationPattern,
  TranslationStats,
  Language,
  TranslationManagerConfig
} from './types.js';
import { debug } from './debug.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class TranslationManager {
  private static instance: TranslationManager | null = null;
  private translationData: TranslationData | null = null;
  private cache: Map<string, string> = new Map();
  private weakCache: WeakMap<object, string> = new WeakMap();
  private stats: TranslationStats = {
    cacheHits: 0,
    cacheMisses: 0,
    totalTranslations: 0,
    memoryUsed: 0,
    loadTime: 0
  };
  private config: TranslationManagerConfig;
  private initialized: boolean = false;
  private language: Language = 'en';
  private excludePatterns: RegExp[] = [];

  private constructor() {
    this.config = {
      debugMode: process.env.DEBUG_I18N === 'true',
      cacheSize: 5000,
      language: 'en',
      translationPath: undefined
    };
    debug.log('TranslationManager instance created');
  }

  public static getInstance(): TranslationManager {
    if (!TranslationManager.instance) {
      TranslationManager.instance = new TranslationManager();
    }
    return TranslationManager.instance;
  }

  public async initialize(language?: Language): Promise<void> {
    const startTime = Date.now();
    debug.log('Initializing TranslationManager');

    try {
      // Detect language from settings or use provided
      this.language = language || await this.detectLanguage();
      debug.log(`Language detected/set: ${this.language}`);

      // Load translation data only if not English
      if (this.language !== 'en') {
        await this.loadTranslations();
        this.compilePatterns();
        this.compileExclusions();
      } else {
        debug.log('English selected, skipping translation loading');
      }

      this.initialized = true;
      this.stats.loadTime = Date.now() - startTime;
      debug.log(`Initialization complete in ${this.stats.loadTime}ms`);

      if (this.translationData) {
        debug.stats({
          language: this.language,
          exactCount: Object.keys(this.translationData.exact).length,
          patternCount: this.translationData.patterns.length,
          loadTime: `${this.stats.loadTime}ms`
        });
      }
    } catch (error) {
      debug.error('Failed to initialize TranslationManager', error);
      this.initialized = true; // Set as initialized even on error to prevent retries
    }
  }

  private async detectLanguage(): Promise<Language> {
    try {
      // Try to read from settings file
      const settingsPath = path.join(process.env.HOME || process.env.USERPROFILE || '', '.gemini', 'settings.json');
      if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (settings.ui?.language) {
          debug.log(`Language detected from settings: ${settings.ui.language}`);
          return settings.ui.language as Language;
        }
      }

      // Check environment variable
      const envLang = process.env.AUDITARIA_LANGUAGE || process.env.LANGUAGE;
      if (envLang?.startsWith('pt')) {
        debug.log('Portuguese detected from environment');
        return 'pt';
      }

      debug.log('Defaulting to English');
      return 'en';
    } catch (error) {
      debug.error('Error detecting language', error);
      return 'en';
    }
  }

  private async loadTranslations(): Promise<void> {
    debug.log('Loading translation data');
    debug.log(`Current __dirname: ${__dirname}`);
    debug.log(`process.execPath: ${process.execPath}`);
    debug.log(`process.argv[1]: ${process.argv[1]}`);

    // Try multiple paths to find the translation file
    const possiblePaths = [
      // Direct path in same directory (compiled code location)
      path.join(__dirname, `en-${this.language}.json`),
      // Bundle directory (when running from local build)
      path.join(__dirname, 'i18n-injection', `en-${this.language}.json`),
      // In local packages structure
      path.join(__dirname, '..', '..', '..', '..', 'packages', 'cli', 'src', 'i18n-injection', `en-${this.language}.json`),
      // Global npm installation - Windows
      path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@thacio', 'auditaria-cli', 'packages', 'cli', 'dist', 'src', 'i18n-injection', `en-${this.language}.json`),
      // Global npm installation - Linux/Mac
      path.join('/usr', 'local', 'lib', 'node_modules', '@thacio', 'auditaria-cli', 'packages', 'cli', 'dist', 'src', 'i18n-injection', `en-${this.language}.json`),
      // Relative to process.argv[1] (the executed script)
      process.argv[1] ? path.join(path.dirname(process.argv[1]), '..', 'node_modules', '@thacio', 'auditaria-cli', 'packages', 'cli', 'dist', 'src', 'i18n-injection', `en-${this.language}.json`) : undefined,
      // Custom path from config
      this.config.translationPath
    ].filter(Boolean);

    for (const filePath of possiblePaths as string[]) {
      debug.log(`Trying path: ${filePath}`);
      if (fs.existsSync(filePath)) {
        debug.log(`✓ Loading translations from: ${filePath}`);
        const data = fs.readFileSync(filePath, 'utf-8');
        this.translationData = JSON.parse(data) as TranslationData;
        debug.log(`Loaded ${Object.keys(this.translationData.exact).length} exact translations`);
        debug.log(`Loaded ${this.translationData.patterns.length} pattern translations`);
        return;
      }
    }

    debug.error(`Translation file not found for language: ${this.language}`);
    debug.log('Attempted paths:', possiblePaths);
  }

  private compilePatterns(): void {
    if (!this.translationData) return;

    for (const pattern of this.translationData.patterns) {
      try {
        pattern.regex = new RegExp(pattern.pattern, pattern.flags || '');
      } catch (error) {
        debug.error(`Failed to compile pattern: ${pattern.pattern}`, error);
      }
    }
  }

  private compileExclusions(): void {
    if (!this.translationData?.exclusions) return;

    const { patterns } = this.translationData.exclusions;
    if (!patterns) return;

    this.excludePatterns = patterns
      .map(pattern => {
        try {
          return new RegExp(pattern);
        } catch (error) {
          debug.error(`Failed to compile exclusion pattern: ${pattern}`, error);
          return null;
        }
      })
      .filter(Boolean) as RegExp[];
  }

  private isExcluded(text: string): boolean {
    if (!this.translationData?.exclusions) return false;

    const { prefixes } = this.translationData.exclusions;

    // Check prefixes
    if (prefixes) {
      for (const prefix of prefixes) {
        if (text.startsWith(prefix)) {
          debug.translation(text, text, 'excluded');
          return true;
        }
      }
    }

    // Check exclusion patterns
    for (const pattern of this.excludePatterns) {
      if (pattern.test(text)) {
        debug.translation(text, text, 'excluded');
        return true;
      }
    }

    return false;
  }

  public translate(text: string): string {
    // Passthrough if not initialized or English
    if (!this.initialized || this.language === 'en' || !this.translationData) {
      return text;
    }

    // Empty or whitespace-only strings
    if (!text || !text.trim()) {
      return text;
    }

    this.stats.totalTranslations++;

    // Check cache
    if (this.cache.has(text)) {
      this.stats.cacheHits++;
      const cached = this.cache.get(text)!;
      debug.translation(text, cached, 'cache');
      return cached;
    }

    this.stats.cacheMisses++;

    // Check if excluded
    if (this.isExcluded(text)) {
      this.cache.set(text, text);
      return text;
    }

    // Try exact match
    const exact = this.translationData.exact[text];
    if (exact) {
      this.cache.set(text, exact);
      debug.translation(text, exact, 'exact');
      this.maintainCacheSize();
      return exact;
    }

    // Try pattern matching
    for (const pattern of this.translationData.patterns) {
      if (!pattern.regex) continue;

      if (pattern.regex.test(text)) {
        const translated = text.replace(pattern.regex, pattern.replacement);
        this.cache.set(text, translated);
        debug.translation(text, translated, 'pattern');
        this.maintainCacheSize();
        return translated;
      }
    }

    // No translation found, return original
    this.cache.set(text, text);
    this.maintainCacheSize();
    return text;
  }

  private maintainCacheSize(): void {
    if (this.cache.size > this.config.cacheSize) {
      // Remove oldest entries (FIFO)
      const entriesToRemove = this.cache.size - this.config.cacheSize + 100;
      const keys = Array.from(this.cache.keys());
      for (let i = 0; i < entriesToRemove; i++) {
        this.cache.delete(keys[i]);
      }
      debug.log(`Cache trimmed: removed ${entriesToRemove} entries`);
    }
  }

  public getStats(): TranslationStats {
    return {
      ...this.stats,
      memoryUsed: this.cache.size * 100 // Rough estimate
    };
  }

  public clearCache(): void {
    this.cache.clear();
    debug.log('Cache cleared');
  }

  public setLanguage(language: Language): void {
    if (this.language !== language) {
      this.language = language;
      this.clearCache();
      this.initialize(language);
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  public getLanguage(): Language {
    return this.language;
  }
}

// Singleton export
export const translationManager = TranslationManager.getInstance();