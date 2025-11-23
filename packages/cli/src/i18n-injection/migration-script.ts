#!/usr/bin/env node
/**
 * Migration script to convert en.json + pt.json to en-pt.json format
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { TranslationData, TranslationPattern } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths to translation files
const EN_PATH = path.join(__dirname, '..', '..', '..', 'core', 'src', 'i18n', 'locales', 'en.json');
const PT_PATH = path.join(__dirname, '..', '..', '..', 'core', 'src', 'i18n', 'locales', 'pt.json');
const OUTPUT_PATH = path.join(__dirname, 'en-pt.json');

interface NestedObject {
  [key: string]: string | NestedObject;
}

/**
 * Flatten nested object to dot-notation keys
 */
function flattenObject(obj: NestedObject, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};

  for (const key in obj) {
    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      result[newKey] = value;
    } else if (typeof value === 'object' && value !== null) {
      Object.assign(result, flattenObject(value as NestedObject, newKey));
    }
  }

  return result;
}

/**
 * Extract parameter placeholders from a string
 */
function extractParameters(str: string): string[] {
  const matches = str.match(/\{([^}]+)\}/g);
  return matches ? matches.map(m => m.slice(1, -1)) : [];
}

/**
 * Convert a parameterized string to a pattern
 */
function createPattern(enStr: string, ptStr: string): TranslationPattern | null {
  const enParams = extractParameters(enStr);
  const ptParams = extractParameters(ptStr);

  // If no parameters or mismatched parameters, return null
  if (enParams.length === 0 || enParams.length !== ptParams.length) {
    return null;
  }

  // Create regex pattern from English string
  let pattern = enStr;
  let replacement = ptStr;

  // Sort parameters by position in string to handle them in order
  const paramPositions = enParams.map(param => ({
    param,
    pos: enStr.indexOf(`{${param}}`)
  })).sort((a, b) => a.pos - b.pos);

  // Replace parameters with capture groups
  let captureIndex = 1;
  for (const { param } of paramPositions) {
    pattern = pattern.replace(`{${param}}`, '(.+)');

    // Find the parameter in Portuguese string and replace with group reference
    const ptParamIndex = ptParams.indexOf(param);
    if (ptParamIndex !== -1) {
      replacement = replacement.replace(`{${param}}`, `$${captureIndex}`);
    }
    captureIndex++;
  }

  // Escape special regex characters except for capture groups
  pattern = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, (match) => {
      if (match === '(' || match === ')' || match === '.') {
        return match; // Keep capture groups and . for matching
      }
      return '\\' + match;
    })
    .replace(/\(\\.\\+\)/g, '(.+)'); // Restore capture groups

  return {
    pattern: `^${pattern}$`,
    replacement,
    flags: ''
  };
}

/**
 * Main migration function
 */
function migrate(): void {
  console.log('Starting migration from en.json + pt.json to en-pt.json...');

  // Read source files
  if (!fs.existsSync(EN_PATH)) {
    console.error(`English translation file not found: ${EN_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(PT_PATH)) {
    console.error(`Portuguese translation file not found: ${PT_PATH}`);
    process.exit(1);
  }

  const enData = JSON.parse(fs.readFileSync(EN_PATH, 'utf-8'));
  const ptData = JSON.parse(fs.readFileSync(PT_PATH, 'utf-8'));

  // Flatten both objects
  const enFlat = flattenObject(enData);
  const ptFlat = flattenObject(ptData);

  console.log(`Found ${Object.keys(enFlat).length} English translations`);
  console.log(`Found ${Object.keys(ptFlat).length} Portuguese translations`);

  // Build translation mappings
  const exact: Record<string, string> = {};
  const patterns: TranslationPattern[] = [];
  const missingInPt: string[] = [];

  for (const key in enFlat) {
    const enValue = enFlat[key];
    const ptValue = ptFlat[key];

    if (!ptValue) {
      missingInPt.push(key);
      continue;
    }

    // Skip if both are the same (untranslated)
    if (enValue === ptValue) {
      continue;
    }

    // Check if it contains parameters
    const hasParams = enValue.includes('{') && enValue.includes('}');

    if (hasParams) {
      // Try to create a pattern
      const pattern = createPattern(enValue, ptValue);
      if (pattern) {
        patterns.push(pattern);
      } else {
        // If pattern creation failed, add as exact match
        exact[enValue] = ptValue;
      }
    } else {
      // No parameters, add as exact match
      exact[enValue] = ptValue;
    }
  }

  console.log(`Created ${Object.keys(exact).length} exact translations`);
  console.log(`Created ${patterns.length} pattern translations`);
  if (missingInPt.length > 0) {
    console.log(`Warning: ${missingInPt.length} translations missing in Portuguese`);
  }

  // Create the output data structure
  const outputData: TranslationData = {
    metadata: {
      version: '1.0',
      generated: new Date().toISOString(),
      exact_count: Object.keys(exact).length,
      pattern_count: patterns.length,
      language_pair: 'en-pt'
    },
    exact,
    patterns,
    exclusions: {
      prefixes: [
        '[Tool:',
        'Tool:',
        'User:',
        'Assistant:',
        'Error:',
        'DEBUG:',
        '[DEBUG]',
        '[ERROR]',
        '[WARN]',
        '[INFO]'
      ],
      components: [
        'ChatMessage',
        'ToolOutput',
        'UserInput',
        'FunctionResponse'
      ],
      contexts: [
        'chat',
        'tool',
        'function',
        'debug'
      ],
      patterns: [
        '^\\[Tool:.*\\]$',
        '^User:.*',
        '^Assistant:.*',
        '^\\s*$',  // Empty or whitespace-only
        '^[0-9]+$', // Numbers only
        '^[0-9]+(\\.[0-9]+)?$', // Decimal numbers
        '^[A-Z0-9_]+$', // Constants/env vars
        '^https?://.*', // URLs
        '^/.*', // File paths
        '^[A-Za-z]:\\\\.*', // Windows paths
        '^```.*', // Code blocks
        '^\\$.*', // Shell commands
        '^npm .*', // npm commands
        '^git .*', // git commands
        '^---+$', // Separators
        '^===+$', // Separators
        '^\\*\\*\\*+$' // Separators
      ]
    }
  };

  // Write the output file
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`\nMigration complete! Output written to: ${OUTPUT_PATH}`);

  // Print statistics
  console.log('\n=== Migration Statistics ===');
  console.log(`Total exact translations: ${Object.keys(exact).length}`);
  console.log(`Total pattern translations: ${patterns.length}`);
  console.log(`Total translations: ${Object.keys(exact).length + patterns.length}`);
  console.log(`Exclusion prefixes: ${outputData.exclusions.prefixes?.length || 0}`);
  console.log(`Exclusion patterns: ${outputData.exclusions.patterns?.length || 0}`);

  // Sample translations for verification
  console.log('\n=== Sample Translations (first 5) ===');
  const exactEntries = Object.entries(exact).slice(0, 5);
  for (const [en, pt] of exactEntries) {
    console.log(`  "${en}" → "${pt}"`);
  }

  if (patterns.length > 0) {
    console.log('\n=== Sample Patterns (first 5) ===');
    patterns.slice(0, 5).forEach(p => {
      console.log(`  Pattern: ${p.pattern}`);
      console.log(`  Replace: ${p.replacement}`);
    });
  }
}

// Run migration if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
}

export { migrate };