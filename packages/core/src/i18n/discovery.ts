/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SupportedLanguage, LanguageInfo } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Dynamically discovers available languages by scanning the locales directory
 */
export async function discoverAvailableLanguages(): Promise<LanguageInfo[]> {
  const localesPath = path.join(__dirname, 'locales');
  
  try {
    const files = await fs.readdir(localesPath);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    const languages: LanguageInfo[] = [];
    
    for (const file of jsonFiles) {
      const languageCode = file.replace('.json', '') as SupportedLanguage;
      const languageInfo = await getLanguageInfo(languageCode);
      if (languageInfo) {
        languages.push(languageInfo);
      }
    }
    
    // Sort by language code to ensure consistent ordering
    return languages.sort((a, b) => a.code.localeCompare(b.code));
  } catch (error) {
    console.warn('Could not discover available languages:', error);
    // Fallback to known languages
    return [
      { code: 'en', name: 'English', nativeName: 'English' },
      { code: 'pt', name: 'Portuguese', nativeName: 'Português' }
    ];
  }
}

/**
 * Gets language information for a given language code
 */
async function getLanguageInfo(languageCode: SupportedLanguage): Promise<LanguageInfo | null> {
  try {
    const localesPath = path.join(__dirname, 'locales');
    const filePath = path.join(localesPath, `${languageCode}.json`);
    
    // Check if file exists
    await fs.access(filePath);
    
    // Return language info based on known mappings
    return getLanguageInfoFromCode(languageCode);
  } catch {
    return null;
  }
}

/**
 * Maps language codes to their display information
 * This is where new languages should be added when translation files are created
 */
function getLanguageInfoFromCode(code: SupportedLanguage): LanguageInfo {
  const languageMap: Record<string, LanguageInfo> = {
    'en': { code: 'en', name: 'English', nativeName: 'English' },
    'pt': { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
    'es': { code: 'es', name: 'Spanish', nativeName: 'Español' },
    'fr': { code: 'fr', name: 'French', nativeName: 'Français' },
    'de': { code: 'de', name: 'German', nativeName: 'Deutsch' },
    'it': { code: 'it', name: 'Italian', nativeName: 'Italiano' },
    'ja': { code: 'ja', name: 'Japanese', nativeName: '日本語' },
    'ko': { code: 'ko', name: 'Korean', nativeName: '한국어' },
    'zh': { code: 'zh', name: 'Chinese', nativeName: '中文' },
    'zh-cn': { code: 'zh-cn', name: 'Chinese (Simplified)', nativeName: '简体中文' },
    'zh-tw': { code: 'zh-tw', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
    'ru': { code: 'ru', name: 'Russian', nativeName: 'Русский' },
    'ar': { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
    'hi': { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
    'nl': { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
    'sv': { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
    'no': { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
    'da': { code: 'da', name: 'Danish', nativeName: 'Dansk' },
    'fi': { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
    'pl': { code: 'pl', name: 'Polish', nativeName: 'Polski' },
    'cs': { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
    'hu': { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
    'tr': { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
    'th': { code: 'th', name: 'Thai', nativeName: 'ไทย' },
    'vi': { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
    'id': { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
    'ms': { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu' },
    'tl': { code: 'tl', name: 'Filipino', nativeName: 'Filipino' },
    'he': { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
    'bn': { code: 'bn', name: 'Bengali', nativeName: 'বাংলা' },
    'ur': { code: 'ur', name: 'Urdu', nativeName: 'اردو' },
    'fa': { code: 'fa', name: 'Persian', nativeName: 'فارسی' },
    'uk': { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
    'bg': { code: 'bg', name: 'Bulgarian', nativeName: 'Български' },
    'hr': { code: 'hr', name: 'Croatian', nativeName: 'Hrvatski' },
    'sr': { code: 'sr', name: 'Serbian', nativeName: 'Српски' },
    'sk': { code: 'sk', name: 'Slovak', nativeName: 'Slovenčina' },
    'sl': { code: 'sl', name: 'Slovenian', nativeName: 'Slovenščina' },
    'et': { code: 'et', name: 'Estonian', nativeName: 'Eesti' },
    'lv': { code: 'lv', name: 'Latvian', nativeName: 'Latviešu' },
    'lt': { code: 'lt', name: 'Lithuanian', nativeName: 'Lietuvių' },
    'ro': { code: 'ro', name: 'Romanian', nativeName: 'Română' },
    'el': { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
    'is': { code: 'is', name: 'Icelandic', nativeName: 'Íslenska' },
    'mt': { code: 'mt', name: 'Maltese', nativeName: 'Malti' },
    'ga': { code: 'ga', name: 'Irish', nativeName: 'Gaeilge' },
    'cy': { code: 'cy', name: 'Welsh', nativeName: 'Cymraeg' },
    'eu': { code: 'eu', name: 'Basque', nativeName: 'Euskera' },
    'ca': { code: 'ca', name: 'Catalan', nativeName: 'Català' },
    'gl': { code: 'gl', name: 'Galician', nativeName: 'Galego' },
    'be': { code: 'be', name: 'Belarusian', nativeName: 'Беларуская' }
  };

  return languageMap[code] || { 
    code: code as SupportedLanguage, 
    name: code.toUpperCase(), 
    nativeName: code.toUpperCase() 
  };
}

/**
 * Checks if a language is available (has translation file)
 */
export async function isLanguageAvailable(languageCode: SupportedLanguage): Promise<boolean> {
  const localesPath = path.join(__dirname, 'locales');
  const filePath = path.join(localesPath, `${languageCode}.json`);
  
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}