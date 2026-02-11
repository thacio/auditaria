#!/usr/bin/env node

/**
 * I18n Rebranding Utility
 *
 * Replaces "Gemini" with "Auditaria" in user-facing strings.
 * Preserves model names like "gemini-2.0-flash" or "gemini-pro".
 *
 * This is a shared utility used by:
 * - babel-transformer.js (at build time)
 * - i18n-extract-strings.cjs (during extraction)
 * - Python translation scripts (via subprocess)
 *
 * Usage:
 *   node scripts/i18n-rebrand.cjs "text to rebrand"
 *   node scripts/i18n-rebrand.cjs --json '{"key": "Gemini text"}'
 *   node scripts/i18n-rebrand.cjs --batch < input.json > output.json
 */

/**
 * Rebrand a single string: replace "Gemini" variants with "Auditaria"
 * Preserves model names like "gemini-2.0-flash", "gemini-pro", etc.
 *
 * Patterns to replace:
 * - "Gemini" (standalone word, not followed by hyphen)
 * - "gemini-cli" → "auditaria"
 *
 * Patterns to preserve (exclusions):
 * - "GEMINI.md" (documentation file reference)
 * - "Gemini API" (external API reference)
 * - "Gemini Code" (product name reference)
 * - "gemini-" followed by version/model (e.g., gemini-2.0-flash, gemini-pro)
 * - "gemini_" (potential snake_case identifiers)
 *
 * @param {string} text - The text to rebrand
 * @returns {string} The rebranded text
 */
function rebrand(text) {
  if (!text || typeof text !== 'string') {
    return text;
  }

  // Step 1: Protect exclusions with placeholders
  // These are official Google product/service names that should NOT be rebranded
  const exclusions = [
    // Documentation
    { pattern: /GEMINI\.md/g, placeholder: '\x00GEMINI_MD\x00', restore: 'GEMINI.md' },
    // API and services
    { pattern: /Gemini API/gi, placeholder: '\x00GEMINI_API\x00', restore: 'Gemini API' },
    { pattern: /Gemini Code/gi, placeholder: '\x00GEMINI_CODE\x00', restore: 'Gemini Code' },
    // Model references
    { pattern: /Gemini models?/gi, placeholder: '\x00GEMINI_MODEL\x00', restore: 'Gemini model' },
    { pattern: /Gemini Pro/gi, placeholder: '\x00GEMINI_PRO\x00', restore: 'Gemini Pro' },
    { pattern: /Gemini Flash/gi, placeholder: '\x00GEMINI_FLASH\x00', restore: 'Gemini Flash' },
    { pattern: /Gemini Nano/gi, placeholder: '\x00GEMINI_NANO\x00', restore: 'Gemini Nano' },
    { pattern: /Gemini Ultra/gi, placeholder: '\x00GEMINI_ULTRA\x00', restore: 'Gemini Ultra' },
    // Version references (Gemini 1, Gemini 2, Gemini 3, Gemini 1.0, Gemini 2.0, etc.)
    { pattern: /Gemini \d+(\.\d+)?/gi, placeholder: '\x00GEMINI_VER\x00', restore: 'Gemini $V' },
    // Products and subscriptions
    { pattern: /Gemini Advanced/gi, placeholder: '\x00GEMINI_ADV\x00', restore: 'Gemini Advanced' },
    { pattern: /Gemini Live/gi, placeholder: '\x00GEMINI_LIVE\x00', restore: 'Gemini Live' },
    { pattern: /Gemini Apps?/gi, placeholder: '\x00GEMINI_APP\x00', restore: 'Gemini app' },
    { pattern: /Google Gemini/gi, placeholder: '\x00GOOGLE_GEMINI\x00', restore: 'Google Gemini' },
    { pattern: /Gemini for Google/gi, placeholder: '\x00GEMINI_FOR\x00', restore: 'Gemini for Google' },
    { pattern: /Gemini extensions?/gi, placeholder: '\x00GEMINI_EXT\x00', restore: 'Gemini extension' },
    { pattern: /Gemini side panel/gi, placeholder: '\x00GEMINI_PANEL\x00', restore: 'Gemini side panel' },
  ];

  let result = text;

  // Store captured version numbers for restoration
  const versionCaptures = [];

  for (const { pattern, placeholder } of exclusions) {
    // Special handling for version pattern to capture the actual version
    if (placeholder === '\x00GEMINI_VER\x00') {
      result = result.replace(pattern, (match) => {
        versionCaptures.push(match);
        return `\x00GEMINI_VER_${versionCaptures.length - 1}\x00`;
      });
    } else {
      result = result.replace(pattern, placeholder);
    }
  }

  // Step 2: Replace "gemini-cli" with "auditaria"
  result = result.replace(/gemini-cli/gi, (match) => {
    if (match === 'GEMINI-CLI') return 'AUDITARIA';
    if (match === 'gemini-cli') return 'auditaria';
    return 'Auditaria';
  });

  // Step 3: Replace standalone "Gemini" (not model names)
  // Pattern explanation:
  // (?<!-) - Negative lookbehind: not preceded by hyphen (avoids "google-gemini")
  // \bGemini\b - Word boundary match for "Gemini"
  // (?![-_]) - Negative lookahead: not followed by hyphen or underscore (preserves model names)
  const pattern = /(?<![-])\bGemini\b(?![-_])/gi;

  result = result.replace(pattern, (match) => {
    // Preserve original case pattern
    if (match === 'GEMINI') {
      return 'AUDITARIA';
    } else if (match === 'gemini') {
      return 'auditaria';
    } else if (match[0] === 'G') {
      return 'Auditaria';
    }
    return 'Auditaria';
  });

  // Step 4: Restore exclusions
  for (const { placeholder, restore } of exclusions) {
    // Skip version placeholder (handled separately)
    if (placeholder === '\x00GEMINI_VER\x00') continue;
    result = result.replace(new RegExp(placeholder, 'g'), restore);
  }

  // Restore version captures with their original values
  for (let i = 0; i < versionCaptures.length; i++) {
    result = result.replace(`\x00GEMINI_VER_${i}\x00`, versionCaptures[i]);
  }

  return result;
}

/**
 * Rebrand all string values in an object (recursively)
 * @param {any} obj - The object to rebrand
 * @returns {any} The rebranded object
 */
function rebrandObject(obj) {
  if (typeof obj === 'string') {
    return rebrand(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(rebrandObject);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      // Rebrand both keys and values for translation files
      const newKey = rebrand(key);
      result[newKey] = rebrandObject(value);
    }
    return result;
  }
  return obj;
}

// CLI mode
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage:');
    console.error('  node scripts/i18n-rebrand.cjs "text to rebrand"');
    console.error('  node scripts/i18n-rebrand.cjs --json \'{"key": "Gemini text"}\'');
    console.error('  echo \'["Gemini", "gemini-pro"]\' | node scripts/i18n-rebrand.cjs --batch');
    process.exit(1);
  }

  if (args[0] === '--json') {
    // JSON object mode
    try {
      const input = JSON.parse(args[1]);
      const output = rebrandObject(input);
      console.log(JSON.stringify(output));
    } catch (error) {
      console.error('Error parsing JSON:', error.message);
      process.exit(1);
    }
  } else if (args[0] === '--batch') {
    // Batch mode: read JSON array from stdin, output rebranded JSON array
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(input);
        const output = rebrandObject(data);
        console.log(JSON.stringify(output, null, 2));
      } catch (error) {
        console.error('Error processing batch:', error.message);
        process.exit(1);
      }
    });
  } else if (args[0] === '--test') {
    // Test mode: run tests
    const tests = [
      // Basic replacements
      ['Welcome to Gemini', 'Welcome to Auditaria'],
      ['Gemini CLI', 'Auditaria'],
      ['Gemini.', 'Auditaria.'],
      ['Gemini, the AI', 'Auditaria, the AI'],
      ['Use Gemini for help', 'Use Auditaria for help'],
      ['GEMINI MODE', 'AUDITARIA MODE'],
      ['gemini mode', 'auditaria mode'],
      // gemini-cli replacement
      ['gemini-cli', 'auditaria'],
      ['Install gemini-cli globally', 'Install auditaria globally'],
      ['GEMINI-CLI', 'AUDITARIA'],
      // Model names should be preserved
      ['gemini-2.0-flash', 'gemini-2.0-flash'],
      ['gemini-pro', 'gemini-pro'],
      ['gemini-1.5-pro', 'gemini-1.5-pro'],
      ['Using gemini-2.0-flash model', 'Using gemini-2.0-flash model'],
      ['Model: gemini-pro', 'Model: gemini-pro'],
      // Exclusions - should NOT be rebranded
      ['See GEMINI.md for details', 'See GEMINI.md for details'],
      ['Using the Gemini API', 'Using the Gemini API'],
      ['Gemini Code Assist', 'Gemini Code Assist'],
      ['Select a Gemini model', 'Select a Gemini model'],
      ['The Gemini models are ready', 'The Gemini model are ready'],
      // Model family names
      ['Using Gemini Pro', 'Using Gemini Pro'],
      ['Switch to Gemini Flash', 'Switch to Gemini Flash'],
      ['Gemini Nano on device', 'Gemini Nano on device'],
      ['Gemini Ultra is powerful', 'Gemini Ultra is powerful'],
      // Version references
      ['Gemini 2 is here', 'Gemini 2 is here'],
      ['Gemini 1.5 features', 'Gemini 1.5 features'],
      ['Gemini 2.0 model', 'Gemini 2.0 model'],
      // Products and services
      ['Subscribe to Gemini Advanced', 'Subscribe to Gemini Advanced'],
      ['Try Gemini Live', 'Try Gemini Live'],
      ['Open the Gemini app', 'Open the Gemini app'],
      ['Google Gemini announcement', 'Google Gemini announcement'],
      ['Gemini for Google Workspace', 'Gemini for Google Workspace'],
      ['Use Gemini for coding', 'Use Auditaria for coding'],
      ['Install Gemini extensions', 'Install Gemini extension'],
      ['Use the Gemini side panel', 'Use the Gemini side panel'],
      // Mixed cases
      ['Gemini uses gemini-pro', 'Auditaria uses gemini-pro'],
      ['Welcome to Gemini! Model: gemini-2.0-flash', 'Welcome to Auditaria! Model: gemini-2.0-flash'],
      ['Run gemini-cli with Gemini API key', 'Run auditaria with Gemini API key'],
      // Edge cases
      ['', ''],
      ['No brand here', 'No brand here'],
      ['Gemini', 'Auditaria'],
    ];

    let passed = 0;
    let failed = 0;

    for (const [input, expected] of tests) {
      const result = rebrand(input);
      if (result === expected) {
        passed++;
        console.log(`PASS: "${input}" -> "${result}"`);
      } else {
        failed++;
        console.log(`FAIL: "${input}"`);
        console.log(`  Expected: "${expected}"`);
        console.log(`  Got:      "${result}"`);
      }
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } else {
    // Single string mode
    const output = rebrand(args.join(' '));
    console.log(output);
  }
}

// Export for use in other modules
module.exports = { rebrand, rebrandObject };
