/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SupportedLanguage, TranslationData, LoadedTranslations } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class TranslationLoader {
  private loadedTranslations: LoadedTranslations = {};
  private localesPath: string;

  constructor() {
    this.localesPath = path.join(__dirname, 'locales');
  }

  async loadLanguage(language: SupportedLanguage): Promise<TranslationData> {
    const existing = this.loadedTranslations[language as keyof LoadedTranslations];
    if (existing) {
      return existing;
    }

    try {
      const filePath = path.join(this.localesPath, `${language}.json`);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      const translations: TranslationData = JSON.parse(fileContent);
      
      (this.loadedTranslations as any)[language] = translations;
      return translations;
    } catch (error) {
      // If translation file doesn't exist, return empty object
      console.warn(`Could not load translations for language ${language}:`, error);
      return {};
    }
  }

  async loadAllLanguages(): Promise<LoadedTranslations> {
    try {
      // Dynamically discover available language files
      const files = await import('fs').then(fs => fs.promises.readdir(this.localesPath));
      const languageFiles = files.filter(file => file.endsWith('.json'));
      const languages = languageFiles.map(file => file.replace('.json', '') as SupportedLanguage);
      
      await Promise.all(
        languages.map(async (lang) => {
          await this.loadLanguage(lang);
        })
      );
    } catch (error) {
      // Fallback to known languages if directory reading fails
      console.warn('Could not read locales directory, falling back to defaults:', error);
      const fallbackLanguages: SupportedLanguage[] = ['en', 'pt'];
      
      await Promise.all(
        fallbackLanguages.map(async (lang) => {
          await this.loadLanguage(lang);
        })
      );
    }

    return this.loadedTranslations;
  }

  getLoadedTranslations(): LoadedTranslations {
    return this.loadedTranslations;
  }

  clearCache(): void {
    this.loadedTranslations = {};
  }
}

export const translationLoader = new TranslationLoader();
