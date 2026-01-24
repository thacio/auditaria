#!/usr/bin/env node
/**
 * Bundle scribe.js-ocr main module for embedding in Bun executables.
 *
 * This creates a bundled version with patched font loading that works
 * in Bun executables where import.meta.url resolves to virtual paths.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SCRIBE_ENTRY = path.join(__dirname, '..', 'node_modules', 'scribe.js-ocr', 'scribe.js');
const OUTPUT_PATH = path.join(__dirname, 'scribe-main-bundled.js');

console.log('📦 Bundling scribe.js-ocr main module...');

if (!fs.existsSync(SCRIBE_ENTRY)) {
  console.error('❌ Scribe.js entry not found at:', SCRIBE_ENTRY);
  process.exit(1);
}

try {
  // Bundle scribe.js with all its dependencies
  // Mark workers as external since they're loaded separately
  execSync(`npx esbuild "${SCRIBE_ENTRY}" --bundle --platform=node --format=esm \
    --external:./mupdf/mupdf-worker.js \
    --external:./js/worker/generalWorker.js \
    --outfile="${OUTPUT_PATH}"`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit'
  });

  // Post-process: Patch font loading for Bun executables
  console.log('   → Patching font loading paths...');
  let bundleContent = fs.readFileSync(OUTPUT_PATH, 'utf8');

  // Pattern: readFile(new URL("../fonts/all/FontName.woff", import.meta.url))
  // Replace with code that checks for Bun and uses extracted fonts
  const fontReadFilePattern = /readFile\(new URL\("\.\.\/fonts\/(all|latin)\/([^"]+)", import\.meta\.url\)\)/g;
  bundleContent = bundleContent.replace(
    fontReadFilePattern,
    (match, fontDir, fontFile) => {
      return `(async () => {
        if (typeof Bun !== 'undefined' && globalThis.__BUN_SCRIBE_DIR) {
          const pathMod = await import('path');
          const fsMod = await import('fs/promises');
          const localPath = pathMod.join(globalThis.__BUN_SCRIBE_DIR, 'fonts', '${fontDir}', '${fontFile}');
          return fsMod.readFile(localPath);
        }
        return readFile(new URL("../fonts/${fontDir}/${fontFile}", import.meta.url));
      })()`;
    }
  );

  // Also patch any fetch calls for fonts (browser mode)
  const fontFetchPattern = /fetch\(new URL\("\.\.\/fonts\/(all|latin)\/([^"]+)", import\.meta\.url\)\)/g;
  bundleContent = bundleContent.replace(
    fontFetchPattern,
    (match, fontDir, fontFile) => {
      return `(typeof Bun !== 'undefined' && globalThis.__BUN_SCRIBE_DIR
        ? (async () => {
            const pathMod = await import('path');
            const fsMod = await import('fs/promises');
            const localPath = pathMod.join(globalThis.__BUN_SCRIBE_DIR, 'fonts', '${fontDir}', '${fontFile}');
            const data = await fsMod.readFile(localPath);
            return new Response(data);
          })()
        : fetch(new URL("../fonts/${fontDir}/${fontFile}", import.meta.url))
      )`;
    }
  );

  // Patch worker URL patterns
  // Pattern: new URL("./mupdf/mupdf-worker.js", import.meta.url)
  bundleContent = bundleContent.replace(
    /new URL\("\.\/mupdf\/mupdf-worker\.js", import\.meta\.url\)/g,
    `(typeof Bun !== 'undefined' && globalThis.__BUN_MUPDF_WORKER_PATH
      ? globalThis.__BUN_MUPDF_WORKER_PATH
      : new URL("./mupdf/mupdf-worker.js", import.meta.url)
    )`
  );

  // Pattern: new URL("./js/worker/generalWorker.js", import.meta.url)
  bundleContent = bundleContent.replace(
    /new URL\("\.\/js\/worker\/generalWorker\.js", import\.meta\.url\)/g,
    `(typeof Bun !== 'undefined' && globalThis.__BUN_SCRIBE_WORKER_PATH
      ? globalThis.__BUN_SCRIBE_WORKER_PATH
      : new URL("./js/worker/generalWorker.js", import.meta.url)
    )`
  );

  fs.writeFileSync(OUTPUT_PATH, bundleContent);

  const stats = fs.statSync(OUTPUT_PATH);
  console.log(`✅ Scribe.js bundled successfully: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Output: ${OUTPUT_PATH}`);
} catch (error) {
  console.error('❌ Failed to bundle scribe.js:', error.message);
  process.exit(1);
}
