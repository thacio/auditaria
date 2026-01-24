#!/usr/bin/env node
/**
 * Bundle the tesseract.js worker script for embedding in Bun executables.
 *
 * This creates a single bundled worker file that can be extracted at runtime,
 * avoiding the __dirname issues when tesseract.js is bundled.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_PATH = path.join(__dirname, '..', 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js');
const OUTPUT_PATH = path.join(__dirname, 'tesseract-worker-bundled.js');

console.log('📦 Bundling tesseract.js worker script...');

if (!fs.existsSync(WORKER_PATH)) {
  console.error('❌ Tesseract worker not found at:', WORKER_PATH);
  process.exit(1);
}

try {
  // Bundle the worker with all its dependencies
  // We use CJS format since the worker uses require()
  execSync(`npx esbuild "${WORKER_PATH}" --bundle --platform=node --format=cjs \
    --outfile="${OUTPUT_PATH}"`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });

  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`✅ Worker bundled successfully: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`   Output: ${OUTPUT_PATH}`);
} catch (error) {
  console.error('❌ Failed to bundle worker:', error.message);
  process.exit(1);
}
