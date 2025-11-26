#!/usr/bin/env node

/**
 * I18n String Extraction Script
 *
 * Extracts untranslated strings from the i18n transformation report
 * and generates a file with placeholders for translation.
 *
 * Usage:
 *   node scripts/i18n-extract-strings.js --lang=pt --output=i18n-pending-translations.json
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = {
    lang: 'pt',
    output: 'i18n-pending-translations.json',
    report: 'i18n-transform-report.json',
  };

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--lang=')) {
      args.lang = arg.split('=')[1];
    } else if (arg.startsWith('--output=')) {
      args.output = arg.split('=')[1];
    } else if (arg.startsWith('--report=')) {
      args.report = arg.split('=')[1];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
I18n String Extraction Script

Usage:
  node scripts/i18n-extract-strings.js [options]

Options:
  --lang=LANG       Target language (default: pt)
  --output=FILE     Output file path (default: i18n-pending-translations.json)
  --report=FILE     Input report file (default: i18n-transform-report.json)
  --help, -h        Show this help message

Example:
  node scripts/i18n-extract-strings.js --lang=pt --output=i18n-pending-translations.json
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

// Generate context description based on transformation type
function generateContext(transformation, file) {
  const type = transformation.type;
  const original = transformation.original;

  // Determine context based on type
  if (type === 'property:description') {
    return 'CLI option or command description';
  } else if (type === 'property:message') {
    return 'User notification or status message';
  } else if (type === 'property:text') {
    return 'UI text or label';
  } else if (type === 'property:label') {
    return 'Button or menu label';
  } else if (type === 'property:title') {
    return 'Dialog or section title';
  } else if (type === 'property:helpText' || type === 'property:hint') {
    return 'Help or hint text';
  } else if (type === 'JSXText') {
    return 'React component text content';
  } else if (type === 'ParameterizedText') {
    const params = transformation.params || [];
    return `Parameterized text with variables: ${params.join(', ')}`;
  } else if (type === 'I18nText') {
    return 'Nested text component';
  }

  // Default context based on file path
  if (file.includes('components')) {
    return 'UI component text';
  } else if (file.includes('commands')) {
    return 'Command output';
  } else if (file.includes('config')) {
    return 'Configuration text';
  }

  return 'User-facing text';
}

// Main extraction function
function extractStrings(args) {
  const reportPath = path.resolve(args.report);
  const localePath = path.resolve(`packages/core/src/i18n/locales/${args.lang}.json`);

  console.log(`\nI18n String Extraction`);
  console.log(`======================`);
  console.log(`Report: ${reportPath}`);
  console.log(`Locale: ${localePath}`);
  console.log(`Output: ${args.output}`);
  console.log();

  // Load the transformation report
  if (!fs.existsSync(reportPath)) {
    console.error(`Error: Report file not found: ${reportPath}`);
    console.error(`\nPlease run the build with i18n transformation enabled first:`);
    console.error(`  I18N_TRANSFORM=true I18N_REPORT=true npm run build`);
    process.exit(1);
  }

  const report = loadJson(reportPath);

  // Load existing translations (if any)
  const existingTranslations = loadJson(localePath, false);
  const exactStrings = existingTranslations?._exactStrings || {};

  console.log(`Loaded ${Object.keys(exactStrings).length} existing translations`);

  // Extract unique strings with their metadata
  const stringsMap = new Map();

  for (const fileDetail of report.fileDetails || []) {
    const file = fileDetail.file;

    for (const transformation of fileDetail.transformations || []) {
      const key = transformation.original;

      // Skip empty or very short strings
      if (!key || key.trim().length < 2) {
        continue;
      }

      // Skip strings that are already translated
      if (exactStrings[key]) {
        continue;
      }

      // Skip duplicates but collect all files where it appears
      if (stringsMap.has(key)) {
        const existing = stringsMap.get(key);
        if (!existing.files.includes(file)) {
          existing.files.push(file);
        }
        continue;
      }

      // Add new string
      stringsMap.set(key, {
        key: key,
        context: generateContext(transformation, file),
        files: [file],
        type: transformation.type,
        params: transformation.params || [],
        translation: '',
      });
    }
  }

  // Convert to array and sort alphabetically
  const pendingTranslations = Array.from(stringsMap.values())
    .sort((a, b) => a.key.localeCompare(b.key));

  // Create output object
  const output = {
    metadata: {
      sourceLanguage: 'en',
      targetLanguage: args.lang,
      generatedAt: new Date().toISOString(),
      totalStringsInReport: report.stringsTransformed || 0,
      uniqueStrings: stringsMap.size + Object.keys(exactStrings).length,
      alreadyTranslated: Object.keys(exactStrings).length,
      pendingTranslation: pendingTranslations.length,
    },
    translations: pendingTranslations.map(item => ({
      key: item.key,
      context: item.context,
      file: item.files[0],  // Primary file
      files: item.files.length > 1 ? item.files : undefined,  // All files if more than one
      type: item.type,
      params: item.params.length > 0 ? item.params : undefined,
      translation: '',
    })),
  };

  // Write output file
  const outputPath = path.resolve(args.output);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  // Print summary
  console.log(`\nExtraction Summary`);
  console.log(`------------------`);
  console.log(`Total strings in report: ${output.metadata.totalStringsInReport}`);
  console.log(`Unique strings: ${output.metadata.uniqueStrings}`);
  console.log(`Already translated: ${output.metadata.alreadyTranslated}`);
  console.log(`Pending translation: ${output.metadata.pendingTranslation}`);
  console.log(`\nOutput written to: ${outputPath}`);

  // Show sample of pending strings
  if (pendingTranslations.length > 0) {
    console.log(`\nSample pending strings (first 5):`);
    for (const item of pendingTranslations.slice(0, 5)) {
      console.log(`  - "${item.key.substring(0, 60)}${item.key.length > 60 ? '...' : ''}"`);
      if (item.params.length > 0) {
        console.log(`    Params: ${item.params.join(', ')}`);
      }
    }
    if (pendingTranslations.length > 5) {
      console.log(`  ... and ${pendingTranslations.length - 5} more`);
    }
  }

  console.log(`\nNext step: Run the translation script:`);
  console.log(`  python scripts/i18n-translate.py --lang=${args.lang}`);
}

// Run
const args = parseArgs();
extractStrings(args);
