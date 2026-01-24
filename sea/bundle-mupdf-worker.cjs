#!/usr/bin/env node
/**
 * Bundle the mupdf worker script for embedding in Bun executables.
 *
 * This creates a single bundled worker file that can be extracted at runtime,
 * avoiding the import.meta.url issues when scribe.js-ocr is bundled.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_PATH = path.join(__dirname, '..', 'node_modules', 'scribe.js-ocr', 'mupdf', 'mupdf-worker.js');
const OUTPUT_PATH = path.join(__dirname, 'mupdf-worker-bundled.js');

console.log('📦 Bundling mupdf worker script...');

if (!fs.existsSync(WORKER_PATH)) {
  console.error('❌ MuPDF worker not found at:', WORKER_PATH);
  process.exit(1);
}

try {
  // Bundle the worker with all its dependencies
  // We use ESM format since the worker uses dynamic imports
  // We need to mark libmupdf.js as external since it loads WASM dynamically
  execSync(`npx esbuild "${WORKER_PATH}" --bundle --platform=node --format=esm \
    --external:./libmupdf.js \
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
