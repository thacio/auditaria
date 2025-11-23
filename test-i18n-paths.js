#!/usr/bin/env node

// Test script to debug i18n path issues
const path = require('path');
const fs = require('fs');

console.log('=== i18n Path Debugging ===\n');

// Show environment variables
console.log('Environment Variables:');
console.log(`  DEBUG_I18N: ${process.env.DEBUG_I18N}`);
console.log(`  AUDITARIA_LANGUAGE: ${process.env.AUDITARIA_LANGUAGE}`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV}\n`);

// Show process info
console.log('Process Info:');
console.log(`  process.execPath: ${process.execPath}`);
console.log(`  process.cwd(): ${process.cwd()}`);
console.log(`  __dirname (script): ${__dirname}\n`);

// Try to find the compiled i18n-injection directory
const possibleDirs = [
  path.join(__dirname, 'packages', 'cli', 'dist', 'src', 'i18n-injection'),
  path.join(__dirname, 'node_modules', '@thacio', 'auditaria-cli', 'packages', 'cli', 'dist', 'src', 'i18n-injection'),
  'C:\\Users\\thaci\\AppData\\Roaming\\npm\\node_modules\\@thacio\\auditaria-cli\\packages\\cli\\dist\\src\\i18n-injection',
];

console.log('Searching for i18n-injection directory:\n');
for (const dir of possibleDirs) {
  const exists = fs.existsSync(dir);
  console.log(`  ${exists ? '✓' : '✗'} ${dir}`);

  if (exists) {
    const files = fs.readdirSync(dir);
    console.log(`    Files: ${files.join(', ')}\n`);

    // Check for en-pt.json
    const enPtPath = path.join(dir, 'en-pt.json');
    if (fs.existsSync(enPtPath)) {
      const stats = fs.statSync(enPtPath);
      console.log(`    ✓ en-pt.json found (${(stats.size / 1024).toFixed(2)} KB)\n`);
    }
  }
}

// Try to import and test the translation manager
console.log('\nTrying to load TranslationManager...\n');

try {
  // Set environment variables for testing
  process.env.DEBUG_I18N = 'true';
  process.env.AUDITARIA_LANGUAGE = 'pt';

  const translationPath = path.join(__dirname, 'packages', 'cli', 'dist', 'src', 'i18n-injection', 'index.js');

  if (fs.existsSync(translationPath)) {
    console.log(`Loading from: ${translationPath}\n`);

    import(translationPath).then(async (module) => {
      console.log('Module loaded successfully!');
      console.log('Available exports:', Object.keys(module), '\n');

      if (module.initialize) {
        console.log('Calling initialize()...\n');
        await module.initialize();

        if (module.translationManager) {
          console.log('\nTranslationManager stats:');
          const stats = module.translationManager.getStats();
          console.log(JSON.stringify(stats, null, 2));

          // Test a translation
          console.log('\nTesting translation:');
          const testStr = 'change the theme';
          const translated = module.translationManager.translate(testStr);
          console.log(`  "${testStr}" → "${translated}"`);
        }
      }
    }).catch(err => {
      console.error('Error loading module:', err);
    });
  } else {
    console.log(`Translation module not found at: ${translationPath}`);
  }
} catch (err) {
  console.error('Error:', err);
}