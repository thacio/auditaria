#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Building Bun executable (final version)...');

// Read the original bundle
const bundlePath = path.join(__dirname, '..', 'bundle', 'gemini.js');
let bundleContent = fs.readFileSync(bundlePath, 'utf8');

// Read locale files and embed them
const localeEn = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'locales', 'en.json'), 'utf8');
const localePt = fs.readFileSync(path.join(__dirname, '..', 'bundle', 'locales', 'pt.json'), 'utf8');

// Suppress the warning messages
bundleContent = bundleContent.replace(
  /console\.warn\("Could not read locales directory, falling back to defaults:", error\);/g,
  '// Warning suppressed for Bun executable'
);

bundleContent = bundleContent.replace(
  /console\.warn\(`Could not load translations for language \${language}:`, error\);/g,
  '// Warning suppressed for Bun executable'
);

// Add embedded locale data at the beginning
const embeddedData = `
// Embedded locale data for Bun executable
if (typeof globalThis.__EMBEDDED_LOCALES === 'undefined') {
  globalThis.__EMBEDDED_LOCALES = {
    'en': ${localeEn},
    'pt': ${localePt}
  };
}
`;

// Add after shebang if present
if (bundleContent.startsWith('#!/usr/bin/env node')) {
  const firstNewline = bundleContent.indexOf('\n');
  bundleContent = bundleContent.substring(0, firstNewline + 1) + embeddedData + bundleContent.substring(firstNewline + 1);
} else {
  bundleContent = embeddedData + bundleContent;
}

// Replace file reading with embedded data check
bundleContent = bundleContent.replace(
  /const fileContent = await fs\d+\.readFile\(filePath, "utf-8"\);[\s]*const translations = JSON\.parse\(fileContent\);/g,
  `let translations;
   if (globalThis.__EMBEDDED_LOCALES && globalThis.__EMBEDDED_LOCALES[language]) {
     translations = globalThis.__EMBEDDED_LOCALES[language];
   } else {
     const fileContent = await fs7.readFile(filePath, "utf-8");
     translations = JSON.parse(fileContent);
   }`
);

// Write temporary patched bundle
const tempBundlePath = path.join(__dirname, 'bundle-temp.js');
fs.writeFileSync(tempBundlePath, bundleContent);

// Build with Bun
const bunPath = 'C:/Users/thaci/.bun/bin/bun.exe';
const outputPath = path.join(__dirname, '..', 'auditaria-standalone.exe');

console.log('Building executable with Bun...');
try {
  execSync(`"${bunPath}" build --compile --minify "${tempBundlePath}" --outfile "${outputPath}"`, {
    stdio: 'inherit'
  });
  
  // Clean up temp file
  fs.unlinkSync(tempBundlePath);
  
  console.log(`\n✅ Executable created: ${outputPath}`);
  console.log(`   Size: ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   No warnings, fully standalone!`);
} catch (error) {
  console.error('Build failed:', error.message);
  // Clean up temp file on error
  if (fs.existsSync(tempBundlePath)) {
    fs.unlinkSync(tempBundlePath);
  }
  process.exit(1);
}