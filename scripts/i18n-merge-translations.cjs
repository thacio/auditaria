#!/usr/bin/env node

/**
 * I18n Merge Translations Script
 *
 * Merges completed translations back into the locale file.
 *
 * IMPORTANT: This script creates a NEW locale file structure with ONLY _exactStrings.
 * All nested keys from the old format are removed.
 *
 * Usage:
 *   node scripts/i18n-merge-translations.js --locale=pt
 *   node scripts/i18n-merge-translations.js --input=i18n-completed-translations.json --locale=pt
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = {
    input: 'i18n-completed-translations.json',
    locale: 'pt',
    backup: false,  // Disabled by default - use git instead
    dryRun: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--input=')) {
      args.input = arg.split('=')[1];
    } else if (arg.startsWith('--locale=')) {
      args.locale = arg.split('=')[1];
    } else if (arg === '--backup') {
      args.backup = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
I18n Merge Translations Script

Merges completed translations into the locale file.
Creates a new file structure with ONLY _exactStrings (removes all nested keys).

Usage:
  node scripts/i18n-merge-translations.js [options]

Options:
  --input=FILE      Input file with completed translations (default: i18n-completed-translations.json)
  --locale=LANG     Target locale (default: pt)
  --backup          Create backup of existing locale file (disabled by default, use git instead)
  --dry-run         Show what would be changed without modifying files
  --help, -h        Show this help message

Example:
  node scripts/i18n-merge-translations.js --locale=pt
`);
      process.exit(0);
    }
  }

  return args;
}

// Load JSON file with error handling
function loadJson(filePath, required = true) {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (required) {
      console.error(`Error loading ${filePath}: ${error.message}`);
      process.exit(1);
    }
    return null;
  }
}

// Save JSON file
function saveJson(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content, 'utf-8');
}

// Main merge function
function mergeTranslations(args) {
  const inputPath = path.resolve(args.input);
  const localePath = path.resolve(`packages/core/src/i18n/locales/${args.locale}.json`);

  console.log(`\nI18n Merge Translations`);
  console.log(`=======================`);
  console.log(`Input: ${inputPath}`);
  console.log(`Locale: ${localePath}`);
  console.log(`Dry run: ${args.dryRun}`);
  console.log();

  // Load completed translations
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    console.error(`\nPlease run the translation script first:`);
    console.error(`  python scripts/i18n-translate.py --lang=${args.locale}`);
    process.exit(1);
  }

  const completedData = loadJson(inputPath);
  const translations = completedData.translations || [];

  // Filter translations that have actual translations
  const validTranslations = translations.filter(t => t.translation && t.translation.trim());

  if (validTranslations.length === 0) {
    console.log('No translations to merge.');
    return;
  }

  console.log(`Found ${validTranslations.length} translations to merge`);

  // Load existing locale file (if any)
  const existingLocale = loadJson(localePath, false);

  // Start with existing _exactStrings or empty object
  const existingExactStrings = existingLocale?._exactStrings || {};

  // Count new vs updated
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  // Create new _exactStrings by merging
  const newExactStrings = { ...existingExactStrings };

  for (const item of validTranslations) {
    const key = item.key;
    const translation = item.translation.trim();

    if (!newExactStrings[key]) {
      newExactStrings[key] = translation;
      newCount++;
    } else if (newExactStrings[key] !== translation) {
      // Translation exists but is different - update it
      console.log(`  Updating: "${key.substring(0, 40)}..."`);
      console.log(`    Old: ${newExactStrings[key].substring(0, 40)}...`);
      console.log(`    New: ${translation.substring(0, 40)}...`);
      newExactStrings[key] = translation;
      updatedCount++;
    } else {
      unchangedCount++;
    }
  }

  // Sort _exactStrings alphabetically by key
  const sortedExactStrings = {};
  const sortedKeys = Object.keys(newExactStrings).sort();
  for (const key of sortedKeys) {
    sortedExactStrings[key] = newExactStrings[key];
  }

  // Create new locale file structure (ONLY _exactStrings)
  const newLocale = {
    _exactStrings: sortedExactStrings,
  };

  // Print summary
  console.log(`\nMerge Summary`);
  console.log(`-------------`);
  console.log(`New translations: ${newCount}`);
  console.log(`Updated translations: ${updatedCount}`);
  console.log(`Unchanged: ${unchangedCount}`);
  console.log(`Total in _exactStrings: ${Object.keys(sortedExactStrings).length}`);

  if (args.dryRun) {
    console.log(`\n[DRY RUN] Would write to: ${localePath}`);
    console.log(`\nSample of merged translations:`);
    const sampleKeys = sortedKeys.slice(0, 5);
    for (const key of sampleKeys) {
      console.log(`  "${key.substring(0, 30)}..." => "${sortedExactStrings[key].substring(0, 30)}..."`);
    }
    return;
  }

  // Create backup if requested and file exists
  if (args.backup && fs.existsSync(localePath)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = localePath.replace('.json', `.backup-${timestamp}.json`);
    fs.copyFileSync(localePath, backupPath);
    console.log(`\nBackup created: ${backupPath}`);
  }

  // Write new locale file
  saveJson(localePath, newLocale);
  console.log(`\nLocale file updated: ${localePath}`);

  // Show sample
  console.log(`\nSample translations:`);
  const sampleKeys = sortedKeys.slice(0, 5);
  for (const key of sampleKeys) {
    console.log(`  "${key.substring(0, 30)}..." => "${sortedExactStrings[key].substring(0, 30)}..."`);
  }
  if (sortedKeys.length > 5) {
    console.log(`  ... and ${sortedKeys.length - 5} more`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Rebuild the application:`);
  console.log(`     I18N_TRANSFORM=true npm run build`);
  console.log(`  2. Test with the target language:`);
  console.log(`     AUDITARIA_LANG=${args.locale} node bundle/gemini.js`);
}

// Run
const args = parseArgs();
mergeTranslations(args);
