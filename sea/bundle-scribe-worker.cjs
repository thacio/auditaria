#!/usr/bin/env node
/**
 * Bundle the scribe.js generalWorker script for embedding in Bun executables.
 *
 * This creates a single bundled worker file that can be extracted at runtime,
 * avoiding the import.meta.url issues when scribe.js-ocr is bundled.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKER_PATH = path.join(__dirname, '..', 'node_modules', 'scribe.js-ocr', 'js', 'worker', 'generalWorker.js');
const OUTPUT_PATH = path.join(__dirname, 'scribe-worker-bundled.js');

console.log('📦 Bundling scribe.js generalWorker script...');

if (!fs.existsSync(WORKER_PATH)) {
  console.error('❌ Scribe worker not found at:', WORKER_PATH);
  process.exit(1);
}

try {
  // Bundle the worker with all its dependencies
  // We use ESM format since the worker uses dynamic imports
  execSync(`npx esbuild "${WORKER_PATH}" --bundle --platform=node --format=esm \
    --outfile="${OUTPUT_PATH}"`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });

  // Post-process: Apply patches for Bun executable
  console.log('   → Applying Bun compatibility patches...');
  let bundleContent = fs.readFileSync(OUTPUT_PATH, 'utf8');

  // Inject fetch interceptor at the start of the bundle to handle font loading
  // In Bun executables, import.meta.url resolves to virtual paths that don't work
  const fetchInterceptor = `
// BUN EXECUTABLE FETCH INTERCEPTOR
// Intercept fetch requests for fonts and serve from extracted location
(function() {
  if (typeof process !== 'undefined' && process.argv && process.argv.some(a => a && a.includes && a.includes('auditaria'))) {
    const originalFetch = globalThis.fetch;
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    globalThis.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));

      // Check if this is a font request from Bun virtual path
      if (url && (url.includes('~BUN') || url.includes('fonts/'))) {
        // Extract font filename
        const fontMatch = url.match(/fonts\\/(all|latin)\\/([^?\\/]+)/);
        if (fontMatch) {
          const fontDir = fontMatch[1];
          const fontFile = fontMatch[2];
          const scribeDir = path.join(os.homedir(), '.auditaria', 'scribe');
          const localFontPath = path.join(scribeDir, 'fonts', fontDir, fontFile);

          if (fs.existsSync(localFontPath)) {
            const data = fs.readFileSync(localFontPath);
            return new Response(data, {
              status: 200,
              headers: { 'Content-Type': 'font/woff' }
            });
          }
        }
      }

      // Check if this is a local file path
      const isWindowsPath = url && url.length > 2 && url.charAt(1) === ':';
      const isFileUrl = url && url.indexOf('file://') === 0;

      if (isWindowsPath || isFileUrl) {
        let localPath = url;
        if (isFileUrl) {
          localPath = url.substring(7);
          if (localPath.charAt(0) === '/' && localPath.charAt(2) === ':') {
            localPath = localPath.substring(1);
          }
        }

        if (fs.existsSync(localPath)) {
          const data = fs.readFileSync(localPath);
          const ext = path.extname(localPath).toLowerCase();
          const mimeTypes = {
            '.woff': 'font/woff',
            '.ttf': 'font/ttf',
            '.wasm': 'application/wasm',
            '.json': 'application/json',
          };
          return new Response(data, {
            status: 200,
            headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' }
          });
        }
      }

      return originalFetch.apply(this, arguments);
    };
  }
})();
`;

  bundleContent = fetchInterceptor + bundleContent;

  // Patch tesseract worker path for Bun executable
  // The original code uses: path.join(__dirname, '..', '..', 'worker-script', 'node', 'index.js')
  // We need to change it to use a co-located tesseract-worker.js
  console.log('   → Patching tesseract worker path...');

  // Pattern: workerPath: path.join(__dirname, "..", "..", "worker-script", "node", "index.js")
  // Various path variable names might be used (path, path2, path137, etc.)
  const tesseractPathPattern = /workerPath:\s*path\d*\.join\(__dirname,\s*"\.\.",\s*"\.\.",\s*"worker-script",\s*"node",\s*"index\.js"\)/g;
  bundleContent = bundleContent.replace(
    tesseractPathPattern,
    'workerPath: path.join(__dirname, "tesseract-worker.js")'
  );

  fs.writeFileSync(OUTPUT_PATH, bundleContent);

  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`✅ Worker bundled successfully: ${(stats.size / 1024).toFixed(1)} KB`);
  console.log(`   Output: ${OUTPUT_PATH}`);
} catch (error) {
  console.error('❌ Failed to bundle worker:', error.message);
  process.exit(1);
}
