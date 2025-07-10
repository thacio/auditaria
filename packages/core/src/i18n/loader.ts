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
    const languages: SupportedLanguage[] = ['en', 'pt'];
    
    await Promise.all(
      languages.map(async (lang) => {
        await this.loadLanguage(lang);
      })
    );

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
