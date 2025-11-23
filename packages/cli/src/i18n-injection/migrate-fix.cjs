#!/usr/bin/env node
/**
 * Fixed migration script to convert en.json + pt.json to en-pt.json format
 */

const fs = require('fs');
const path = require('path');

// Paths to translation files
const EN_PATH = path.join(__dirname, '..', '..', '..', 'core', 'src', 'i18n', 'locales', 'en.json');
const PT_PATH = path.join(__dirname, '..', '..', '..', 'core', 'src', 'i18n', 'locales', 'pt.json');
const OUTPUT_PATH = path.join(__dirname, 'en-pt.json');

/**
 * Flatten nested object to dot-notation keys
 */
function flattenObject(obj, prefix = '') {
  const result = {};

  for (const key in obj) {
    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof value === 'string') {
      result[newKey] = value;
    } else if (typeof value === 'object' && value !== null) {
      Object.assign(result, flattenObject(value, newKey));
    }
  }

  return result;
}

/**
 * Extract parameter placeholders from a string
 */
function extractParameters(str) {
  const matches = str.match(/\{([^}]+)\}/g);
  return matches ? matches.map(m => m.slice(1, -1)) : [];
}

/**
 * Create a pattern from parameterized strings
 */
function createPattern(enStr, ptStr) {
  const enParams = extractParameters(enStr);
  const ptParams = extractParameters(ptStr);

  // If no parameters or mismatched parameters, return null
  if (enParams.length === 0 || enParams.length !== ptParams.length) {
    return null;
  }

  // Create regex pattern from English string
  let pattern = enStr;
  let replacement = ptStr;

  // First, replace {param} placeholders with unique markers
  let tempPattern = pattern;
  const markers = [];
  for (let i = 0; i < enParams.length; i++) {
    const marker = `__PARAM_${i}__`;
    markers.push(marker);
    tempPattern = tempPattern.replace(`{${enParams[i]}}`, marker);
  }

  // Now escape all regex special characters
  tempPattern = tempPattern.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

  // Replace markers with capture groups
  let finalPattern = tempPattern;
  let captureIndex = 1;
  for (let i = 0; i < markers.length; i++) {
    finalPattern = finalPattern.replace(markers[i], '(.+)');

    // Replace {param} in Portuguese with capture group reference
    const param = enParams[i];
    const ptParamIndex = ptParams.indexOf(param);
    if (ptParamIndex !== -1) {
      replacement = replacement.replace(`{${param}}`, `$${captureIndex}`);
    }
    captureIndex++;
  }

  pattern = finalPattern;

  return {
    pattern: `^${pattern}$`,
    replacement,
    flags: ''
  };
}

/**
 * Main migration function
 */
function migrate() {
  console.log('Starting FIXED migration from en.json + pt.json to en-pt.json...');
  console.log('EN_PATH:', EN_PATH);
  console.log('PT_PATH:', PT_PATH);
  console.log('OUTPUT_PATH:', OUTPUT_PATH);

  // Check if source files exist
  if (!fs.existsSync(EN_PATH)) {
    console.error(`English translation file not found: ${EN_PATH}`);
    process.exit(1);
  }

  if (!fs.existsSync(PT_PATH)) {
    console.error(`Portuguese translation file not found: ${PT_PATH}`);
    process.exit(1);
  }

  console.log('Reading translation files...');

  const enData = JSON.parse(fs.readFileSync(EN_PATH, 'utf-8'));
  const ptData = JSON.parse(fs.readFileSync(PT_PATH, 'utf-8'));

  // Flatten both objects
  const enFlat = flattenObject(enData);
  const ptFlat = flattenObject(ptData);

  console.log(`Found ${Object.keys(enFlat).length} English translations`);
  console.log(`Found ${Object.keys(ptFlat).length} Portuguese translations`);

  // Build translation mappings
  const exact = {};
  const patterns = [];
  const missingInPt = [];
  let skippedSame = 0;

  for (const key in enFlat) {
    const enValue = enFlat[key];
    const ptValue = ptFlat[key];

    if (!ptValue) {
      missingInPt.push(key);
      continue;
    }

    // Skip if both are the same (untranslated)
    if (enValue === ptValue) {
      skippedSame++;
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
  console.log(`Skipped ${skippedSame} untranslated strings`);
  if (missingInPt.length > 0) {
    console.log(`Warning: ${missingInPt.length} translations missing in Portuguese`);
  }

  // Create the output data structure
  const outputData = {
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
        '^\\s*$',
        '^[0-9]+$',
        '^[0-9]+(\\.[0-9]+)?$',
        '^[A-Z0-9_]+$',
        '^https?://.*',
        '^/.*',
        '^[A-Za-z]:\\\\.*',
        '^```.*',
        '^\\$.*',
        '^npm .*',
        '^git .*',
        '^---+$',
        '^===+$',
        '^\\*\\*\\*+$'
      ]
    }
  };

  // Write the output file
  console.log(`Writing output to: ${OUTPUT_PATH}`);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData, null, 2), 'utf-8');
  console.log(`Migration complete! Output written to: ${OUTPUT_PATH}`);

  // Print statistics
  console.log('\n=== Migration Statistics ===');
  console.log(`Total exact translations: ${Object.keys(exact).length}`);
  console.log(`Total pattern translations: ${patterns.length}`);
  console.log(`Total translations: ${Object.keys(exact).length + patterns.length}`);
  console.log(`File size: ${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(2)} KB`);

  // Sample translations for verification
  console.log('\n=== Sample Translations (first 5) ===');
  const exactEntries = Object.entries(exact).slice(0, 5);
  for (const [en, pt] of exactEntries) {
    console.log(`  "${en}" → "${pt}"`);
  }

  if (patterns.length > 0) {
    console.log('\n=== Sample Patterns (first 3) ===');
    patterns.slice(0, 3).forEach(p => {
      console.log(`  Pattern: ${p.pattern}`);
      console.log(`  Replace: ${p.replacement}`);
      console.log('');
    });
  }
}

// Run migration
migrate();