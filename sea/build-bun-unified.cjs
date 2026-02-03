#!/usr/bin/env node

/**
 * Unified Bun WebSocket solution - Single server handling both HTTP and WebSocket
 * FIXED: Server only initializes when --web flag is present
 * FIXED: Process.argv handling for correct argument parsing
 * FIXED: Interactive mode detection for standalone executable
 * FIXED: Stagehand and Playwright bundled for standalone executable
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUNDLE_PATH = path.join(__dirname, '..', 'bundle', 'gemini.js');
const BUN_BUNDLE_PATH = path.join(__dirname, '..', 'bundle', 'gemini-bun-prebundle.js');
const OUTPUT_PATH = path.join(__dirname, '..', 'auditaria-standalone.exe');
const WEB_CLIENT_PATH = path.join(__dirname, '..', 'packages', 'web-client', 'src');

console.log('🔧 Building Auditaria CLI with unified Bun server...\n');

if (!fs.existsSync(BUNDLE_PATH)) {
  console.error('❌ Bundle not found. Run "npm run bundle" first.');
  process.exit(1);
}

// Step 0: Create Bun-specific bundle that INCLUDES Stagehand and Playwright
// The regular bundle has these as external to avoid worker thread crashes,
// but for standalone Bun exe we need them bundled in.
console.log('📦 Creating Bun-specific bundle (including Stagehand/Playwright)...');

try {
  // Read the main esbuild config to get base settings
  const pkg = require(path.join(__dirname, '..', 'package.json'));

  // IMPORTANT: Marking packages as external INCREASES final exe size!
  // When external: esbuild keeps `import 'pkg'` statements → Bun tries to resolve/include them
  // When NOT external: esbuild fails to bundle native modules → imports get removed
  // So for packages we want to EXCLUDE from Bun, do NOT add them here.
  //
  // Only mark as external if the package:
  // 1. Is actually needed at runtime in Bun
  // 2. Must be resolved by Bun's module system (not bundled)
  //
  // Note: web-tree-sitter and tree-sitter-bash are NOT external - they get bundled,
  // and their WASM files are loaded from embedded assets
  const externals = [
    '@lydell/node-pty',
    'node-pty',
    '@lydell/node-pty-darwin-arm64',
    '@lydell/node-pty-darwin-x64',
    '@lydell/node-pty-linux-x64',
    '@lydell/node-pty-win32-arm64',
    '@lydell/node-pty-win32-x64',
    'keytar',  // Native module for credential storage
    'youtube-transcript',  // Optional dep of markitdown-ts
    'unzipper',  // Optional dep of markitdown-ts
    // These are dynamically imported and will throw runtime error if used in Bun
    // 'vectorlite',  // SQLite vector extension (native)
    // 'better-sqlite3',  // SQLite native bindings
    // '@electric-sql/pglite',  // PGlite embedded postgres
    // '@lancedb/lancedb',  // LanceDB vector storage
  ].map(e => `--external:${e}`).join(' ');

  // Alias native modules to shims for Bun compatibility
  // onnxruntime-node: shim that re-exports from onnxruntime-web/wasm (for Bun compatibility)
  // onnxruntime-web: NOT aliased - let it resolve naturally so the shim can import from it
  // sharp: stub shim (only needed for image processing, not text embeddings)
  // scribe.js-ocr: bundled version with patched font loading for Bun executables
  const sharpShimPath = path.join(__dirname, 'sharp-shim.js').replace(/\\/g, '/');
  const onnxNodeShimPath = path.join(__dirname, 'onnx-node-shim.js').replace(/\\/g, '/');
  const scribeBundledPath = path.join(__dirname, 'scribe-main-bundled.js').replace(/\\/g, '/');
  // NOTE: We do NOT alias @huggingface/transformers - let it use the default entry point
  // which imports onnxruntime-node. Our onnx-node-shim redirects to onnxruntime-web/wasm
  const aliases = `--alias:onnxruntime-node=${onnxNodeShimPath} --alias:sharp=${sharpShimPath} --alias:scribe.js-ocr=${scribeBundledPath}`;

  execSync(`npx esbuild packages/cli/index.ts --bundle --platform=node --format=esm \
    ${externals} \
    ${aliases} \
    --loader:.node=file \
    --loader:.wasm=file \
    --banner:js="const require = (await import('module')).createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);" \
    --define:process.env.CLI_VERSION='"${pkg.version}"' \
    --outfile="${BUN_BUNDLE_PATH}"`, {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe'
  });
  console.log('   ✓ Bun-specific bundle created (Stagehand/Playwright included)');
} catch (error) {
  console.error('   ⚠️  Failed to create Bun-specific bundle, falling back to regular bundle');
  console.error('   Error:', error.message);
  // Fall back to regular bundle
  fs.copyFileSync(BUNDLE_PATH, BUN_BUNDLE_PATH);
}

// Use the Bun-specific bundle
const ACTUAL_BUNDLE_PATH = fs.existsSync(BUN_BUNDLE_PATH) ? BUN_BUNDLE_PATH : BUNDLE_PATH;

// Embed locale files
console.log('📦 Embedding locale files...');
const LOCALE_PATH = path.join(__dirname, '..', 'bundle', 'locales');
let localeData = {};

if (fs.existsSync(LOCALE_PATH)) {
  const localeFiles = fs.readdirSync(LOCALE_PATH).filter(f => f.endsWith('.json'));
  localeFiles.forEach(file => {
    const lang = file.replace('.json', '');
    const content = fs.readFileSync(path.join(LOCALE_PATH, file), 'utf8');
    localeData[lang] = JSON.parse(content);
    console.log(`   ✓ Embedded locale: ${lang}`);
  });
} else {
  console.warn('   ⚠️  Locale directory not found, translations may not work');
}

// === PGLITE ASSETS EMBEDDING === (DISABLED - Bun only supports libsql backend)
// PGlite is not needed since we use libsql for the Bun executable
// console.log('\n📦 Embedding PGlite assets...');
// const PGLITE_DIST_PATH = path.join(__dirname, '..', 'node_modules', '@electric-sql', 'pglite', 'dist');
let pgliteAssets = {}; // Keep empty - not used in Bun executable
/*
try {
  const wasmPath = path.join(PGLITE_DIST_PATH, 'pglite.wasm');
  const dataPath = path.join(PGLITE_DIST_PATH, 'pglite.data');
  const vectorPath = path.join(PGLITE_DIST_PATH, 'vector.tar.gz');

  if (fs.existsSync(wasmPath) && fs.existsSync(dataPath) && fs.existsSync(vectorPath)) {
    pgliteAssets = {
      wasm: fs.readFileSync(wasmPath, 'base64'),
      data: fs.readFileSync(dataPath, 'base64'),
      vector: fs.readFileSync(vectorPath, 'base64'),
    };
    const totalSize = (pgliteAssets.wasm.length + pgliteAssets.data.length + pgliteAssets.vector.length) / 1024 / 1024 * 0.75; // Approx original size
    console.log(`   ✓ Embedded pglite.wasm (${(fs.statSync(wasmPath).size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   ✓ Embedded pglite.data (${(fs.statSync(dataPath).size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   ✓ Embedded vector.tar.gz (${(fs.statSync(vectorPath).size / 1024).toFixed(1)} KB)`);
    console.log(`   ✓ Total PGlite assets: ~${totalSize.toFixed(2)} MB`);
  } else {
    console.warn('   ⚠️  PGlite assets not found, knowledge search will not work in executable');
    console.warn(`      Looked for: ${wasmPath}`);
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed PGlite assets:', error.message);
}
*/

// === TREE-SITTER WASM EMBEDDING === (for shell parsing in Bun executable)
console.log('\n📦 Embedding tree-sitter WASM assets...');
let treeSitterAssets = {};

try {
  const treeSitterWasmPath = path.join(__dirname, '..', 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm');
  const bashWasmPath = path.join(__dirname, '..', 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm');

  if (fs.existsSync(treeSitterWasmPath) && fs.existsSync(bashWasmPath)) {
    treeSitterAssets = {
      treeSitter: fs.readFileSync(treeSitterWasmPath, 'base64'),
      bash: fs.readFileSync(bashWasmPath, 'base64'),
    };
    console.log(`   ✓ Embedded tree-sitter.wasm (${(fs.statSync(treeSitterWasmPath).size / 1024).toFixed(1)} KB)`);
    console.log(`   ✓ Embedded tree-sitter-bash.wasm (${(fs.statSync(bashWasmPath).size / 1024).toFixed(1)} KB)`);
  } else {
    console.warn('   ⚠️  Tree-sitter WASM files not found');
    if (!fs.existsSync(treeSitterWasmPath)) console.warn(`      Missing: ${treeSitterWasmPath}`);
    if (!fs.existsSync(bashWasmPath)) console.warn(`      Missing: ${bashWasmPath}`);
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed tree-sitter assets:', error.message);
}

// === ONNX RUNTIME WASM EMBEDDING === (for TransformersJS embeddings in Bun executable)
console.log('\n📦 Embedding ONNX Runtime WASM assets...');
let onnxAssets = {};

try {
  const onnxWasmPath = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm');
  const onnxMjsPath = path.join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.mjs');

  if (fs.existsSync(onnxWasmPath)) {
    onnxAssets = {
      wasmSimdThreaded: fs.readFileSync(onnxWasmPath, 'base64'),
      // Also embed the loader mjs if it exists
      mjsSimdThreaded: fs.existsSync(onnxMjsPath) ? fs.readFileSync(onnxMjsPath, 'base64') : null,
    };
    console.log(`   ✓ Embedded ort-wasm-simd-threaded.wasm (${(fs.statSync(onnxWasmPath).size / 1024 / 1024).toFixed(2)} MB)`);
    if (onnxAssets.mjsSimdThreaded) {
      console.log(`   ✓ Embedded ort-wasm-simd-threaded.mjs (${(fs.statSync(onnxMjsPath).size / 1024).toFixed(1)} KB)`);
    }
  } else {
    console.warn('   ⚠️  ONNX WASM files not found');
    console.warn(`      Missing: ${onnxWasmPath}`);
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed ONNX assets:', error.message);
}

// === CANVASKIT WASM EMBEDDING === (for Tesseract.js OCR in Bun executable)
console.log('\n📦 Embedding CanvasKit WASM assets...');
let canvaskitAssets = {};

try {
  const canvaskitWasmPath = path.join(__dirname, '..', 'node_modules', 'canvaskit-wasm', 'bin', 'canvaskit.wasm');

  if (fs.existsSync(canvaskitWasmPath)) {
    canvaskitAssets = {
      wasm: fs.readFileSync(canvaskitWasmPath, 'base64'),
    };
    console.log(`   ✓ Embedded canvaskit.wasm (${(fs.statSync(canvaskitWasmPath).size / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    console.warn('   ⚠️  CanvasKit WASM not found');
    console.warn(`      Missing: ${canvaskitWasmPath}`);
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed CanvasKit assets:', error.message);
}

// === TESSERACT WORKER EMBEDDING === (pre-bundled worker for Bun executable)
console.log('\n📦 Embedding Tesseract.js worker...');
let tesseractWorkerAssets = {};

try {
  // First, try to bundle the worker if it doesn't exist
  const bundledWorkerPath = path.join(__dirname, 'tesseract-worker-bundled.js');
  if (!fs.existsSync(bundledWorkerPath)) {
    console.log('   → Bundling tesseract worker...');
    execSync(`node "${path.join(__dirname, 'bundle-tesseract-worker.cjs')}"`, {
      cwd: __dirname,
      stdio: 'pipe'
    });
  }

  if (fs.existsSync(bundledWorkerPath)) {
    tesseractWorkerAssets = {
      worker: fs.readFileSync(bundledWorkerPath, 'base64'),
    };
    console.log(`   ✓ Embedded tesseract-worker-bundled.js (${(fs.statSync(bundledWorkerPath).size / 1024).toFixed(1)} KB)`);
  } else {
    console.warn('   ⚠️  Tesseract worker bundle not found');
  }

  // Also embed tesseract-core WASM files (use @scribe.js version which scribe.js-ocr expects)
  const tesseractCoreDir = path.join(__dirname, '..', 'node_modules', '@scribe.js', 'tesseract.js-core');
  const wasmFiles = ['tesseract-core-simd-lstm.wasm', 'tesseract-core-simd.wasm', 'tesseract-core-lstm.wasm', 'tesseract-core.wasm'];

  for (const wasmFile of wasmFiles) {
    const wasmPath = path.join(tesseractCoreDir, wasmFile);
    if (fs.existsSync(wasmPath)) {
      const key = wasmFile.replace('.wasm', '').replace(/-/g, '_');
      tesseractWorkerAssets[key] = fs.readFileSync(wasmPath, 'base64');
      console.log(`   ✓ Embedded ${wasmFile} (${(fs.statSync(wasmPath).size / 1024 / 1024).toFixed(2)} MB)`);
    }
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed Tesseract assets:', error.message);
}

// === MUPDF WORKER EMBEDDING === (for Scribe.js PDF OCR in Bun executable)
console.log('\n📦 Embedding MuPDF assets...');
let mupdfAssets = {};

try {
  // First, try to bundle the worker if it doesn't exist
  const bundledWorkerPath = path.join(__dirname, 'mupdf-worker-bundled.js');
  if (!fs.existsSync(bundledWorkerPath)) {
    console.log('   → Bundling mupdf worker...');
    execSync(`node "${path.join(__dirname, 'bundle-mupdf-worker.cjs')}"`, {
      cwd: __dirname,
      stdio: 'pipe'
    });
  }

  if (fs.existsSync(bundledWorkerPath)) {
    mupdfAssets.worker = fs.readFileSync(bundledWorkerPath, 'base64');
    console.log(`   ✓ Embedded mupdf-worker-bundled.js (${(fs.statSync(bundledWorkerPath).size / 1024).toFixed(1)} KB)`);
  } else {
    console.warn('   ⚠️  MuPDF worker bundle not found');
  }

  // Embed libmupdf.wasm
  const libmupdfWasmPath = path.join(__dirname, '..', 'node_modules', 'scribe.js-ocr', 'mupdf', 'libmupdf.wasm');
  if (fs.existsSync(libmupdfWasmPath)) {
    mupdfAssets.wasm = fs.readFileSync(libmupdfWasmPath, 'base64');
    console.log(`   ✓ Embedded libmupdf.wasm (${(fs.statSync(libmupdfWasmPath).size / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    console.warn('   ⚠️  libmupdf.wasm not found');
  }

  // Also embed libmupdf.js (the JS loader)
  const libmupdfJsPath = path.join(__dirname, '..', 'node_modules', 'scribe.js-ocr', 'mupdf', 'libmupdf.js');
  if (fs.existsSync(libmupdfJsPath)) {
    mupdfAssets.js = fs.readFileSync(libmupdfJsPath, 'base64');
    console.log(`   ✓ Embedded libmupdf.js (${(fs.statSync(libmupdfJsPath).size / 1024).toFixed(1)} KB)`);
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed MuPDF assets:', error.message);
}

// === SCRIBE FONTS EMBEDDING === (for Scribe.js OCR in Bun executable)
console.log('\n📦 Embedding Scribe.js fonts...');
let scribeFontAssets = { all: {}, latin: {} };

try {
  const fontsBaseDir = path.join(__dirname, '..', 'node_modules', 'scribe.js-ocr', 'fonts');

  // Embed fonts from 'all' directory
  const fontsAllDir = path.join(fontsBaseDir, 'all');
  if (fs.existsSync(fontsAllDir)) {
    const fontFiles = fs.readdirSync(fontsAllDir).filter(f => f.endsWith('.woff') || f.endsWith('.ttf'));
    for (const fontFile of fontFiles) {
      const fontPath = path.join(fontsAllDir, fontFile);
      scribeFontAssets.all[fontFile] = fs.readFileSync(fontPath, 'base64');
    }
    console.log(`   ✓ Embedded ${Object.keys(scribeFontAssets.all).length} fonts from 'all'`);
  }

  // Embed fonts from 'latin' directory
  const fontsLatinDir = path.join(fontsBaseDir, 'latin');
  if (fs.existsSync(fontsLatinDir)) {
    const fontFiles = fs.readdirSync(fontsLatinDir).filter(f => f.endsWith('.woff') || f.endsWith('.ttf'));
    for (const fontFile of fontFiles) {
      const fontPath = path.join(fontsLatinDir, fontFile);
      scribeFontAssets.latin[fontFile] = fs.readFileSync(fontPath, 'base64');
    }
    console.log(`   ✓ Embedded ${Object.keys(scribeFontAssets.latin).length} fonts from 'latin'`);
  }

  const totalSize = [...Object.values(scribeFontAssets.all), ...Object.values(scribeFontAssets.latin)]
    .reduce((sum, b64) => sum + b64.length * 0.75, 0) / 1024 / 1024;
  console.log(`   ✓ Total fonts: ~${totalSize.toFixed(2)} MB`);
} catch (error) {
  console.warn('   ⚠️  Failed to embed Scribe fonts:', error.message);
}

// === SCRIBE MAIN MODULE EMBEDDING === (bundled scribe.js-ocr for Bun executable)
console.log('\n📦 Embedding Scribe.js main module...');
let scribeMainAssets = {};

try {
  // Bundle the main scribe.js module with patched font loading
  const bundledMainPath = path.join(__dirname, 'scribe-main-bundled.js');
  if (!fs.existsSync(bundledMainPath)) {
    console.log('   → Bundling scribe.js main module...');
    execSync(`node "${path.join(__dirname, 'bundle-scribe-main.cjs')}"`, {
      cwd: __dirname,
      stdio: 'pipe'
    });
  }

  if (fs.existsSync(bundledMainPath)) {
    scribeMainAssets.main = fs.readFileSync(bundledMainPath, 'base64');
    console.log(`   ✓ Embedded scribe-main-bundled.js (${(fs.statSync(bundledMainPath).size / 1024 / 1024).toFixed(2)} MB)`);
  } else {
    console.warn('   ⚠️  Scribe main bundle not found');
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed Scribe main module:', error.message);
}

// === SCRIBE GENERAL WORKER EMBEDDING === (for Scribe.js OCR processing in Bun executable)
console.log('\n📦 Embedding Scribe.js general worker...');
let scribeWorkerAssets = {};

try {
  // First, try to bundle the worker if it doesn't exist
  const bundledWorkerPath = path.join(__dirname, 'scribe-worker-bundled.js');
  if (!fs.existsSync(bundledWorkerPath)) {
    console.log('   → Bundling scribe worker...');
    execSync(`node "${path.join(__dirname, 'bundle-scribe-worker.cjs')}"`, {
      cwd: __dirname,
      stdio: 'pipe'
    });
  }

  if (fs.existsSync(bundledWorkerPath)) {
    scribeWorkerAssets.worker = fs.readFileSync(bundledWorkerPath, 'base64');
    console.log(`   ✓ Embedded scribe-worker-bundled.js (${(fs.statSync(bundledWorkerPath).size / 1024).toFixed(1)} KB)`);
  } else {
    console.warn('   ⚠️  Scribe worker bundle not found');
  }
} catch (error) {
  console.warn('   ⚠️  Failed to embed Scribe worker:', error.message);
}

// Embed web client files
console.log('\n📦 Embedding web client files...');
const webClientFiles = {};

function readDirRecursive(dir, baseDir = dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (fs.statSync(fullPath).isDirectory()) {
      readDirRecursive(fullPath, baseDir);
    } else {
      webClientFiles[relativePath] = fs.readFileSync(fullPath, 'base64');
    }
  }
}

if (fs.existsSync(WEB_CLIENT_PATH)) {
  readDirRecursive(WEB_CLIENT_PATH);
  console.log(`   ✓ Embedded ${Object.keys(webClientFiles).length} files`);
}

console.log('\n📖 Reading bundle...');
let bundleContent = fs.readFileSync(ACTUAL_BUNDLE_PATH, 'utf8');

// Remove shebang
if (bundleContent.startsWith('#!/')) {
  bundleContent = bundleContent.slice(bundleContent.indexOf('\n') + 1);
}

console.log('🔨 Applying fixes...');

// Fix 0: Set up proper cache directories for Bun executables
// In Bun executables, import.meta.url returns virtual paths that break path resolution
const bunCacheFix = `
// BUN CACHE DIRECTORY FIX
// TransformersJS computes cache dir from import.meta.url which is broken in Bun executables
// We need to set a proper cache directory before TransformersJS initializes
if (typeof Bun !== 'undefined') {
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs');

  // Set up proper cache directory in user's home folder
  const homeDir = os.homedir();
  const bunCacheDir = path.join(homeDir, '.auditaria', 'models');
  const onnxWasmDir = path.join(homeDir, '.auditaria', 'onnx-wasm');

  // Store for later use by TransformersJS env setup
  globalThis.__BUN_TRANSFORMERS_CACHE_DIR = bunCacheDir;

  // Create directories if they don't exist
  try {
    if (!fs.existsSync(bunCacheDir)) {
      fs.mkdirSync(bunCacheDir, { recursive: true });
    }
    if (!fs.existsSync(onnxWasmDir)) {
      fs.mkdirSync(onnxWasmDir, { recursive: true });
    }
  } catch (e) {
    // Ignore - will be created later if needed
  }

  // SET EMBEDDED ASSETS HERE (before the check below)
  // This must be set before we try to extract them
  globalThis.__ONNX_EMBEDDED_ASSETS = ${Object.keys(onnxAssets).length > 0 ? JSON.stringify(onnxAssets) : 'null'};
  globalThis.__CANVASKIT_EMBEDDED_ASSETS = ${Object.keys(canvaskitAssets).length > 0 ? JSON.stringify(canvaskitAssets) : 'null'};
  globalThis.__TESSERACT_EMBEDDED_ASSETS = ${Object.keys(tesseractWorkerAssets).length > 0 ? JSON.stringify(tesseractWorkerAssets) : 'null'};
  globalThis.__MUPDF_EMBEDDED_ASSETS = ${Object.keys(mupdfAssets).length > 0 ? JSON.stringify(mupdfAssets) : 'null'};
  globalThis.__SCRIBE_WORKER_EMBEDDED_ASSETS = ${Object.keys(scribeWorkerAssets).length > 0 ? JSON.stringify(scribeWorkerAssets) : 'null'};
  globalThis.__SCRIBE_MAIN_EMBEDDED_ASSETS = ${Object.keys(scribeMainAssets).length > 0 ? JSON.stringify(scribeMainAssets) : 'null'};
  globalThis.__SCRIBE_FONT_EMBEDDED_ASSETS = ${(Object.keys(scribeFontAssets.all).length > 0 || Object.keys(scribeFontAssets.latin).length > 0) ? JSON.stringify(scribeFontAssets) : 'null'};

  // Extract embedded ONNX WASM files if available
  if (globalThis.__ONNX_EMBEDDED_ASSETS && globalThis.__ONNX_EMBEDDED_ASSETS.wasmSimdThreaded) {
    try {
      const wasmPath = path.join(onnxWasmDir, 'ort-wasm-simd-threaded.wasm');
      // Only extract if file doesn't exist or is different size
      const wasmData = Buffer.from(globalThis.__ONNX_EMBEDDED_ASSETS.wasmSimdThreaded, 'base64');
      let needsExtract = true;
      if (fs.existsSync(wasmPath)) {
        const stat = fs.statSync(wasmPath);
        if (stat.size === wasmData.length) {
          needsExtract = false;
        }
      }
      if (needsExtract) {
        fs.writeFileSync(wasmPath, wasmData);
        // console.log('[Bun] Extracted ONNX WASM to:', wasmPath);
      }

      // Also extract the mjs loader if available
      if (globalThis.__ONNX_EMBEDDED_ASSETS.mjsSimdThreaded) {
        const mjsPath = path.join(onnxWasmDir, 'ort-wasm-simd-threaded.mjs');
        const mjsData = Buffer.from(globalThis.__ONNX_EMBEDDED_ASSETS.mjsSimdThreaded, 'base64');
        if (!fs.existsSync(mjsPath) || fs.statSync(mjsPath).size !== mjsData.length) {
          fs.writeFileSync(mjsPath, mjsData);
        }
      }

      // Store the ONNX WASM directory for ONNX runtime configuration
      globalThis.__BUN_ONNX_WASM_DIR = onnxWasmDir;

      // Extract canvaskit.wasm if available (for Tesseract.js OCR)
      if (globalThis.__CANVASKIT_EMBEDDED_ASSETS && globalThis.__CANVASKIT_EMBEDDED_ASSETS.wasm) {
        const canvaskitPath = path.join(onnxWasmDir, 'canvaskit.wasm');
        const canvaskitData = Buffer.from(globalThis.__CANVASKIT_EMBEDDED_ASSETS.wasm, 'base64');
        if (!fs.existsSync(canvaskitPath) || fs.statSync(canvaskitPath).size !== canvaskitData.length) {
          fs.writeFileSync(canvaskitPath, canvaskitData);
        }
        globalThis.__BUN_CANVASKIT_PATH = canvaskitPath;
      }

      // Extract tesseract.js worker and WASM files if available
      if (globalThis.__TESSERACT_EMBEDDED_ASSETS && globalThis.__TESSERACT_EMBEDDED_ASSETS.worker) {
        const tesseractDir = path.join(homeDir, '.auditaria', 'tesseract');
        if (!fs.existsSync(tesseractDir)) {
          fs.mkdirSync(tesseractDir, { recursive: true });
        }

        // Extract bundled worker
        const workerPath = path.join(tesseractDir, 'tesseract-worker-bundled.js');
        const workerData = Buffer.from(globalThis.__TESSERACT_EMBEDDED_ASSETS.worker, 'base64');
        if (!fs.existsSync(workerPath) || fs.statSync(workerPath).size !== workerData.length) {
          fs.writeFileSync(workerPath, workerData);
        }
        globalThis.__BUN_TESSERACT_WORKER_PATH = workerPath;

        // Extract tesseract-core WASM files
        const wasmFiles = [
          ['tesseract_core_simd_lstm', 'tesseract-core-simd-lstm.wasm'],
          ['tesseract_core_simd', 'tesseract-core-simd.wasm'],
          ['tesseract_core_lstm', 'tesseract-core-lstm.wasm'],
          ['tesseract_core', 'tesseract-core.wasm']
        ];
        for (const [key, filename] of wasmFiles) {
          if (globalThis.__TESSERACT_EMBEDDED_ASSETS[key]) {
            const wasmPath = path.join(tesseractDir, filename);
            const wasmData = Buffer.from(globalThis.__TESSERACT_EMBEDDED_ASSETS[key], 'base64');
            if (!fs.existsSync(wasmPath) || fs.statSync(wasmPath).size !== wasmData.length) {
              fs.writeFileSync(wasmPath, wasmData);
            }
          }
        }
        globalThis.__BUN_TESSERACT_CORE_PATH = tesseractDir;
      }

      // Extract MuPDF worker and WASM files if available (for Scribe.js PDF OCR)
      if (globalThis.__MUPDF_EMBEDDED_ASSETS && globalThis.__MUPDF_EMBEDDED_ASSETS.worker) {
        const mupdfDir = path.join(homeDir, '.auditaria', 'mupdf');
        if (!fs.existsSync(mupdfDir)) {
          fs.mkdirSync(mupdfDir, { recursive: true });
        }

        // Extract bundled worker
        const workerPath = path.join(mupdfDir, 'mupdf-worker-bundled.js');
        const workerData = Buffer.from(globalThis.__MUPDF_EMBEDDED_ASSETS.worker, 'base64');
        if (!fs.existsSync(workerPath) || fs.statSync(workerPath).size !== workerData.length) {
          fs.writeFileSync(workerPath, workerData);
        }
        globalThis.__BUN_MUPDF_WORKER_PATH = workerPath;

        // Extract libmupdf.wasm
        if (globalThis.__MUPDF_EMBEDDED_ASSETS.wasm) {
          const wasmPath = path.join(mupdfDir, 'libmupdf.wasm');
          const wasmData = Buffer.from(globalThis.__MUPDF_EMBEDDED_ASSETS.wasm, 'base64');
          if (!fs.existsSync(wasmPath) || fs.statSync(wasmPath).size !== wasmData.length) {
            fs.writeFileSync(wasmPath, wasmData);
          }
          globalThis.__BUN_MUPDF_WASM_PATH = wasmPath;
        }

        // Extract libmupdf.js (the JS loader)
        if (globalThis.__MUPDF_EMBEDDED_ASSETS.js) {
          const jsPath = path.join(mupdfDir, 'libmupdf.js');
          const jsData = Buffer.from(globalThis.__MUPDF_EMBEDDED_ASSETS.js, 'base64');
          if (!fs.existsSync(jsPath) || fs.statSync(jsPath).size !== jsData.length) {
            fs.writeFileSync(jsPath, jsData);
          }
          globalThis.__BUN_MUPDF_JS_PATH = jsPath;
        }

        globalThis.__BUN_MUPDF_DIR = mupdfDir;
      }

      // NOTE: Scribe extraction moved to separate independent block below (after ONNX try block)

      // CRITICAL: Pre-configure ONNX environment BEFORE any imports
      // Use regular path (not file:// URL) for Bun compatibility
      const wasmPathsValue = onnxWasmDir.replace(/\\\\/g, '/') + '/';
      globalThis.ort = globalThis.ort || {};
      globalThis.ort.env = globalThis.ort.env || {};
      globalThis.ort.env.wasm = globalThis.ort.env.wasm || {};
      globalThis.ort.env.wasm.wasmPaths = wasmPathsValue;
      globalThis.ort.env.wasm.numThreads = 1;

      // Pre-load the WASM binary so ONNX doesn't need to fetch it
      const wasmBinaryPath = path.join(onnxWasmDir, 'ort-wasm-simd-threaded.wasm');
      if (fs.existsSync(wasmBinaryPath)) {
        const wasmBinary = fs.readFileSync(wasmBinaryPath);
        globalThis.ort.env.wasm.wasmBinary = wasmBinary.buffer;
        // console.log('[Bun] Pre-loaded WASM binary:', wasmBinaryPath, 'size:', wasmBinary.length);
      }

      // console.log('[Bun] Pre-configured ONNX wasmPaths:', globalThis.ort.env.wasm.wasmPaths);
      // console.log('[Bun] ONNX WASM dir contents:', fs.readdirSync(onnxWasmDir));

      // CRITICAL: Intercept fetch requests for local files and ONNX CDN
      // In Bun executables, fetch() can't access local file paths
      const originalFetch = globalThis.fetch;
      // console.log('[Bun] Setting up fetch interceptor for local files');
      globalThis.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));

        // Check if this is a local file path (Windows or Unix style)
        const isWindowsPath = url && url.length > 2 && url.charAt(1) === ':' && (url.charAt(2) === '\\\\' || url.charAt(2) === '/');
        const isUnixPath = url && url.charAt(0) === '/' && url.charAt(1) !== '/';
        const isFileUrl = url && url.indexOf('file://') === 0;
        const isLocalPath = isWindowsPath || isUnixPath || isFileUrl;

        if (isLocalPath) {
          // Convert to proper path
          let localPath = url;
          if (isFileUrl) {
            localPath = url.substring(7); // Remove 'file://'
            // Handle Windows file:// URLs (file:///C:/...)
            if (localPath.charAt(0) === '/' && localPath.charAt(2) === ':') {
              localPath = localPath.substring(1);
            }
          }

          // Normalize path separators - replace forward slashes with backslashes on Windows
          localPath = localPath.split('/').join(path.sep);

          if (fs.existsSync(localPath)) {
            // console.log('[Bun] Serving local file:', localPath);
            const data = fs.readFileSync(localPath);
            const ext = path.extname(localPath).toLowerCase();
            const mimeTypes = {
              '.onnx': 'application/octet-stream',
              '.json': 'application/json',
              '.wasm': 'application/wasm',
              '.mjs': 'application/javascript',
              '.js': 'application/javascript',
              '.bin': 'application/octet-stream',
            };
            return new Response(data, {
              status: 200,
              headers: { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' }
            });
          } else {
            // console.log('[Bun] Local file not found:', localPath);
            return new Response('Not found', { status: 404 });
          }
        }

        // Check if this is an ONNX WASM request from CDN - serve locally
        if (url && (url.includes('ort-wasm') || url.includes('onnxruntime'))) {
          const filename = url.split('/').pop().split('?')[0];
          const localOnnxPath = path.join(onnxWasmDir, filename);

          if (fs.existsSync(localOnnxPath)) {
            const data = fs.readFileSync(localOnnxPath);
            const contentType = filename.endsWith('.wasm') ? 'application/wasm' :
                               filename.endsWith('.mjs') ? 'application/javascript' :
                               'application/octet-stream';
            return new Response(data, {
              status: 200,
              headers: { 'Content-Type': contentType }
            });
          }
        }

        // Check if this is a canvaskit.wasm request - serve from extracted location
        if (url && url.includes('canvaskit.wasm') && globalThis.__BUN_CANVASKIT_PATH) {
          if (fs.existsSync(globalThis.__BUN_CANVASKIT_PATH)) {
            const data = fs.readFileSync(globalThis.__BUN_CANVASKIT_PATH);
            return new Response(data, {
              status: 200,
              headers: { 'Content-Type': 'application/wasm' }
            });
          }
        }

        // Check if this is a font request from Bun virtual path or scribe fonts
        if (url && (url.includes('~BUN') || url.includes('fonts/'))) {
          const fontMatch = url.match(/fonts[\\\\/](all|latin)[\\\\/]([^?\\\\/]+)/);
          if (fontMatch && globalThis.__BUN_SCRIBE_DIR) {
            const fontDir = fontMatch[1];
            const fontFile = fontMatch[2];
            const localFontPath = path.join(globalThis.__BUN_SCRIBE_DIR, 'fonts', fontDir, fontFile);

            if (fs.existsSync(localFontPath)) {
              const data = fs.readFileSync(localFontPath);
              return new Response(data, {
                status: 200,
                headers: { 'Content-Type': 'font/woff' }
              });
            }
          }
        }

        // Call original fetch for remote URLs
        try {
          return await originalFetch.apply(this, arguments);
        } catch (fetchError) {
          // Silently handle fetch errors - don't spam console
          throw fetchError;
        }
      };

      // Also store the wasm dir globally for debugging
      globalThis.__ONNX_WASM_DIR_DEBUG = onnxWasmDir;
      globalThis.__BUN_ONNX_WASM_DIR = onnxWasmDir;

      // Note: fs/promises patching doesn't work in Bun (modules are immutable)
      // Instead, we bundle scribe.js-ocr with patched font paths and import that

    } catch (e) {
      console.error('[Bun] Failed to extract ONNX WASM:', e.message);
    }
  }

  // SCRIBE EXTRACTION - Independent of ONNX (moved outside ONNX try block)
  // This ensures scribe fonts are extracted even if ONNX extraction fails
  try {
    const homeDir = os.homedir();
    const scribeDir = path.join(homeDir, '.auditaria', 'scribe');

    // Extract Scribe main module if available (bundled scribe.js-ocr with patched fonts)
    if (globalThis.__SCRIBE_MAIN_EMBEDDED_ASSETS && globalThis.__SCRIBE_MAIN_EMBEDDED_ASSETS.main) {
      if (!fs.existsSync(scribeDir)) {
        fs.mkdirSync(scribeDir, { recursive: true });
      }

      // IMPORTANT: Set __BUN_SCRIBE_DIR FIRST - the bundled module needs it for font paths
      globalThis.__BUN_SCRIBE_DIR = scribeDir;

      // Extract bundled main module
      const mainPath = path.join(scribeDir, 'scribe-main-bundled.mjs');
      const mainData = Buffer.from(globalThis.__SCRIBE_MAIN_EMBEDDED_ASSETS.main, 'base64');
      if (!fs.existsSync(mainPath) || fs.statSync(mainPath).size !== mainData.length) {
        fs.writeFileSync(mainPath, mainData);
      }
      globalThis.__BUN_SCRIBE_MAIN_PATH = mainPath;
    }

    // Extract Scribe fonts
    if (globalThis.__SCRIBE_FONT_EMBEDDED_ASSETS) {
      // Make sure scribeDir is set
      if (!globalThis.__BUN_SCRIBE_DIR) {
        globalThis.__BUN_SCRIBE_DIR = scribeDir;
        if (!fs.existsSync(scribeDir)) {
          fs.mkdirSync(scribeDir, { recursive: true });
        }
      }

      // Extract 'all' fonts
      if (globalThis.__SCRIBE_FONT_EMBEDDED_ASSETS.all) {
        const fontsAllDir = path.join(scribeDir, 'fonts', 'all');
        if (!fs.existsSync(fontsAllDir)) {
          fs.mkdirSync(fontsAllDir, { recursive: true });
        }
        for (const [fontFile, fontBase64] of Object.entries(globalThis.__SCRIBE_FONT_EMBEDDED_ASSETS.all)) {
          const fontPath = path.join(fontsAllDir, fontFile);
          const fontData = Buffer.from(fontBase64, 'base64');
          if (!fs.existsSync(fontPath) || fs.statSync(fontPath).size !== fontData.length) {
            fs.writeFileSync(fontPath, fontData);
          }
        }
      }

      // Extract 'latin' fonts
      if (globalThis.__SCRIBE_FONT_EMBEDDED_ASSETS.latin) {
        const fontsLatinDir = path.join(scribeDir, 'fonts', 'latin');
        if (!fs.existsSync(fontsLatinDir)) {
          fs.mkdirSync(fontsLatinDir, { recursive: true });
        }
        for (const [fontFile, fontBase64] of Object.entries(globalThis.__SCRIBE_FONT_EMBEDDED_ASSETS.latin)) {
          const fontPath = path.join(fontsLatinDir, fontFile);
          const fontData = Buffer.from(fontBase64, 'base64');
          if (!fs.existsSync(fontPath) || fs.statSync(fontPath).size !== fontData.length) {
            fs.writeFileSync(fontPath, fontData);
          }
        }
      }
    }

    // Extract Scribe general worker
    if (globalThis.__SCRIBE_WORKER_EMBEDDED_ASSETS && globalThis.__SCRIBE_WORKER_EMBEDDED_ASSETS.worker) {
      if (!fs.existsSync(scribeDir)) {
        fs.mkdirSync(scribeDir, { recursive: true });
      }

      const workerPath = path.join(scribeDir, 'scribe-worker-bundled.js');
      const workerData = Buffer.from(globalThis.__SCRIBE_WORKER_EMBEDDED_ASSETS.worker, 'base64');
      if (!fs.existsSync(workerPath) || fs.statSync(workerPath).size !== workerData.length) {
        fs.writeFileSync(workerPath, workerData);
      }
      globalThis.__BUN_SCRIBE_WORKER_PATH = workerPath;

      // Ensure __BUN_SCRIBE_DIR is set
      if (!globalThis.__BUN_SCRIBE_DIR) {
        globalThis.__BUN_SCRIBE_DIR = scribeDir;
      }
    }

    // Extract canvaskit.wasm to scribe directory (worker loads it from its own directory)
    if (globalThis.__CANVASKIT_EMBEDDED_ASSETS && globalThis.__CANVASKIT_EMBEDDED_ASSETS.wasm) {
      const scribeCanvaskitPath = path.join(scribeDir, 'canvaskit.wasm');
      const canvaskitData = Buffer.from(globalThis.__CANVASKIT_EMBEDDED_ASSETS.wasm, 'base64');
      if (!fs.existsSync(scribeCanvaskitPath) || fs.statSync(scribeCanvaskitPath).size !== canvaskitData.length) {
        fs.writeFileSync(scribeCanvaskitPath, canvaskitData);
      }
    }

    // Extract tesseract worker and WASM files to scribe directory (scribe worker spawns tesseract workers)
    if (globalThis.__TESSERACT_EMBEDDED_ASSETS && globalThis.__TESSERACT_EMBEDDED_ASSETS.worker) {
      const scribeTesseractPath = path.join(scribeDir, 'tesseract-worker.js');
      const tesseractData = Buffer.from(globalThis.__TESSERACT_EMBEDDED_ASSETS.worker, 'base64');
      if (!fs.existsSync(scribeTesseractPath) || fs.statSync(scribeTesseractPath).size !== tesseractData.length) {
        fs.writeFileSync(scribeTesseractPath, tesseractData);
      }

      // Extract tesseract-core WASM files to scribe directory too
      const wasmFiles = [
        ['tesseract_core_simd_lstm', 'tesseract-core-simd-lstm.wasm'],
        ['tesseract_core_simd', 'tesseract-core-simd.wasm'],
        ['tesseract_core_lstm', 'tesseract-core-lstm.wasm'],
        ['tesseract_core', 'tesseract-core.wasm']
      ];
      for (const [key, filename] of wasmFiles) {
        if (globalThis.__TESSERACT_EMBEDDED_ASSETS[key]) {
          const wasmPath = path.join(scribeDir, filename);
          const wasmData = Buffer.from(globalThis.__TESSERACT_EMBEDDED_ASSETS[key], 'base64');
          if (!fs.existsSync(wasmPath) || fs.statSync(wasmPath).size !== wasmData.length) {
            fs.writeFileSync(wasmPath, wasmData);
          }
        }
      }
    }

  } catch (e) {
    console.error('[Bun] Failed to extract Scribe assets:', e.message);
  }
}
`;

// Fix 1: Process.argv cleanup for Bun environment
// This ensures clean argument parsing and prevents extra Bun-specific arguments
const argvCleanupFix = `
// BUN ARGV CLEANUP FIX
(function() {
  if (typeof Bun !== 'undefined' && Bun.version) {
    // Store original argv
    const originalArgv = [...process.argv];

    // Check if we're running as a standalone executable
    // In Bun, argv[0] is "bun" and argv[1] is the executable path
    const isStandalone = process.argv.some(arg => arg && arg.includes('auditaria-standalone'));

    if (isStandalone) {
      // In Bun compiled executable:
      // argv[0] = "bun"
      // argv[1] = "B:/~BUN/root/auditaria-standalone.exe"
      // argv[2+] = actual user arguments (if any)

      let cleanArgv = [];
      let exePath = null;
      let userArgsStart = -1;

      // Find the executable path and where user arguments start
      for (let i = 0; i < originalArgv.length; i++) {
        if (originalArgv[i] && originalArgv[i].includes('auditaria-standalone')) {
          exePath = originalArgv[i];
          // User arguments start after the executable path
          userArgsStart = i + 1;
          break;
        }
      }

      if (exePath) {
        // Build clean argv for yargs:
        // argv[0] = executable path
        // argv[1] = dummy script path (same as argv[0], required by yargs)
        // argv[2+] = user arguments
        cleanArgv.push(exePath);
        cleanArgv.push(exePath); // dummy script path for yargs

        // Add any actual user arguments
        for (let i = userArgsStart; i < originalArgv.length; i++) {
          const arg = originalArgv[i];
          // Skip if this is a duplicate of the exe path (Bun sometimes adds it twice)
          if (arg && arg !== exePath && !arg.startsWith('--bun-') && !arg.startsWith('-bun-')) {
            cleanArgv.push(arg);
          }
        }
      } else {
        // Fallback if exe path not found
        cleanArgv = [...originalArgv];
      }

      // Replace process.argv with cleaned version
      process.argv = cleanArgv;
    }
  }
})();
`;

// Fix 2: Enhanced interactive mode detection
// Ensure interactive mode works correctly when no arguments provided
const interactiveModeFixEnhanced = `
// ENHANCED INTERACTIVE MODE FIX FOR BUN
(function() {
  if (typeof Bun !== 'undefined' && Bun.version) {
    // Override hideBin globally if it exists
    // This approach doesn't require module interception
    const checkAndFixHideBin = () => {
      try {
        // Check if hideBin is available globally (it might be after yargs loads)
        if (typeof globalThis.hideBin === 'function') {
          const originalHideBin = globalThis.hideBin;
          globalThis.hideBin = function(argv) {
            if (argv && argv.length >= 2) {
              const isStandalone = argv[0] && argv[0].includes('auditaria-standalone');
              if (isStandalone) {
                return argv.slice(2);
              }
            }
            return originalHideBin(argv);
          };
        }
      } catch (e) {
        // Silently ignore if hideBin is not available
      }
    };

    // Check immediately and also set a timer to check later
    checkAndFixHideBin();
    setTimeout(checkAndFixHideBin, 0);

    // Additional fix: patch yargs parsing directly
    // Override process.argv before yargs processes it
    const originalSlice = Array.prototype.slice;
    Array.prototype.slice = function(...args) {
      // Check if this is being called on process.argv by yargs
      if (this === process.argv && args.length > 0 && args[0] === 2) {
        // This is likely hideBin trying to slice argv
        const isStandalone = this[0] && this[0].includes('auditaria-standalone');
        if (isStandalone && this.length >= 2 && this[1] === this[0]) {
          // Skip the duplicate executable path we added
          return originalSlice.call(this, 2);
        }
      }
      return originalSlice.apply(this, args);
    };
  }
})();
`;

// Fix 3: Always initialize Bun server infrastructure (but conditionally start)
const conditionalUnifiedBunServer = `
// UNIFIED BUN SERVER FOR HTTP + WEBSOCKET - ALWAYS INITIALIZED
(function() {
  if (typeof Bun === 'undefined' || !Bun.version) return;

  // Check if web interface is disabled at startup (web is enabled by default)
  const hasNoWebFlag = process.argv.some(arg => arg === '--no-web');
  const webEnabled = !hasNoWebFlag;

  // Debug output
  if (process.env.DEBUG) {
    console.log('[Bun] Web enabled (default):', webEnabled);
    console.log('[Bun] Current argv:', process.argv);
  }

  // Embedded locale data for Bun executable (always set this)
  if (typeof globalThis.__EMBEDDED_LOCALES === 'undefined') {
    globalThis.__EMBEDDED_LOCALES = ${JSON.stringify(localeData)};
  }

  // Embedded PGlite assets for Bun executable (for knowledge search)
  if (typeof globalThis.__PGLITE_EMBEDDED_ASSETS === 'undefined') {
    globalThis.__PGLITE_EMBEDDED_ASSETS = ${Object.keys(pgliteAssets).length > 0 ? JSON.stringify(pgliteAssets) : 'null'};
  }

  // Embedded tree-sitter WASM assets for Bun executable (for shell parsing)
  if (typeof globalThis.__TREESITTER_EMBEDDED_ASSETS === 'undefined') {
    globalThis.__TREESITTER_EMBEDDED_ASSETS = ${Object.keys(treeSitterAssets).length > 0 ? JSON.stringify(treeSitterAssets) : 'null'};
  }

  // NOTE: ONNX embedded assets are set in bunCacheFix (must be set early for extraction)

  // ALWAYS initialize server infrastructure (needed for /web command)
  // console.log('[Bun] Initializing server infrastructure...');

  const WEB_CLIENT_FILES = ${JSON.stringify(webClientFiles)};
  const wsClients = new Set();
  let unifiedServer = null;
  let serverPort = null;

  // Store embedded files globally for Express static middleware override
  globalThis.__EMBEDDED_WEB_FILES = WEB_CLIENT_FILES;

  // Message handlers storage
  let messageHandlers = {
    submitQuery: null,
    abort: null,
    confirmation: null
  };

  // State storage
  let serverState = {
    history: [],
    slashCommands: [],
    mcpServers: { servers: [], blockedServers: [] },
    consoleMessages: [],
    cliActionState: null,
    pendingItem: null,
    loadingState: null
  };

  // Create unified Bun WebSocketServer replacement
  class BunUnifiedWebSocketServer {
    constructor(options) {
      // console.log('[Bun] Creating unified WebSocket server instance');
      this.clients = wsClients;
      this._connectionHandler = null;
      this._options = options; // Store options for lazy initialization

      // Don't create the actual server yet - wait until it's needed
      // The server will be created either:
      // 1. Immediately if web is enabled (default, unless --no-web)
      // 2. Later when /web command is used

      // Check if we should auto-start the server (web enabled by default)
      if (webEnabled && !unifiedServer) {
        // console.log('[Bun] Auto-starting server (web enabled by default)');
        this._createServer(options);
      }
      // Otherwise, server will be created on demand
    }

    _createServer(options) {
      // Only create server once
      if (unifiedServer) {
        // console.log('[Bun] Server already exists on port', serverPort);
        return;
      }

      // console.log('[Bun] Creating actual Bun server');

      // Get port from command line arguments or use default
      let requestedPort = 8629;

      // Parse --port argument from process.argv
      const portArgIndex = process.argv.indexOf('--port');
      if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
        const parsedPort = parseInt(process.argv[portArgIndex + 1], 10);
        if (!isNaN(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) {
          requestedPort = parsedPort;
        } else {
          console.error(\`⚠️ Invalid port number: \${process.argv[portArgIndex + 1]}. Port must be between 0-65535. Starting in another port.\`);
        }
      }

      const port = options.port || (options.server && options.server.address?.()?.port) || requestedPort;

      // Create the unified Bun server
      unifiedServer = Bun.serve({
        port: port,
        hostname: 'localhost',

        fetch: (req, server) => {
          const url = new URL(req.url);

          // Handle WebSocket upgrade
          if (req.headers.get('upgrade') === 'websocket') {
            // console.log('[Bun] WebSocket upgrade request for:', url.pathname);

            // Store URL path for routing in open handler
            const success = server.upgrade(req, {
              data: {
                pathname: url.pathname,
                host: req.headers.get('host') || 'localhost'
              },
              headers: {
                'Access-Control-Allow-Origin': '*'
              }
            });

            if (success) {
              return undefined; // Let WebSocket handler take over
            }
            return new Response('WebSocket upgrade failed', { status: 400 });
          }

          // Handle API endpoints
          if (url.pathname === '/api/health') {
            return Response.json({
              status: 'ok',
              clients: wsClients.size,
              runtime: 'bun-unified'
            });
          }

          // Handle file preview endpoint - serves files from filesystem
          if (url.pathname.startsWith('/preview-file/')) {
            try {
              const fs = require('fs');
              const nodePath = require('path');

              // Get the file path from the URL (everything after /preview-file/)
              const requestedPath = url.pathname.slice('/preview-file/'.length);
              if (!requestedPath) {
                return new Response('Missing file path', { status: 400 });
              }

              // Decode the path
              const decodedPath = decodeURIComponent(requestedPath);

              // Security: ensure path is absolute and normalized
              const absolutePath = nodePath.isAbsolute(decodedPath)
                ? nodePath.normalize(decodedPath)
                : nodePath.resolve(decodedPath);

              // Check if file exists
              if (!fs.existsSync(absolutePath)) {
                return new Response('File not found', { status: 404 });
              }

              // Get file stats for size information
              const stats = fs.statSync(absolutePath);
              const fileSize = stats.size;

              // Read file extension
              const ext = nodePath.extname(absolutePath).toLowerCase();

              // Determine if media file (needs Range support)
              const mediaExtensions = [
                '.mp4', '.webm', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.m4v', '.ogv',
                '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.opus'
              ];
              const isMedia = mediaExtensions.includes(ext);

              // MIME type mapping
              const contentTypes = {
                // HTML & Web
                '.html': 'text/html; charset=utf-8',
                '.htm': 'text/html; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.mjs': 'application/javascript; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
                '.xml': 'application/xml; charset=utf-8',
                // Images
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.gif': 'image/gif',
                '.svg': 'image/svg+xml',
                '.webp': 'image/webp',
                '.ico': 'image/x-icon',
                '.bmp': 'image/bmp',
                '.tiff': 'image/tiff',
                '.tif': 'image/tiff',
                '.avif': 'image/avif',
                // Fonts
                '.woff': 'font/woff',
                '.woff2': 'font/woff2',
                '.ttf': 'font/ttf',
                '.otf': 'font/otf',
                // Documents
                '.pdf': 'application/pdf',
                '.doc': 'application/msword',
                '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                '.xls': 'application/vnd.ms-excel',
                '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                '.ppt': 'application/vnd.ms-powerpoint',
                '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                // Data formats
                '.csv': 'text/csv; charset=utf-8',
                '.yaml': 'text/yaml; charset=utf-8',
                '.yml': 'text/yaml; charset=utf-8',
                '.toml': 'application/toml; charset=utf-8',
                // Text files
                '.txt': 'text/plain; charset=utf-8',
                '.md': 'text/markdown; charset=utf-8',
                '.log': 'text/plain; charset=utf-8',
                // Video
                '.mp4': 'video/mp4',
                '.webm': 'video/webm',
                '.avi': 'video/x-msvideo',
                '.mov': 'video/quicktime',
                '.wmv': 'video/x-ms-wmv',
                '.flv': 'video/x-flv',
                '.mkv': 'video/x-matroska',
                '.m4v': 'video/x-m4v',
                '.ogv': 'video/ogg',
                // Audio
                '.mp3': 'audio/mpeg',
                '.wav': 'audio/wav',
                '.ogg': 'audio/ogg',
                '.aac': 'audio/aac',
                '.m4a': 'audio/mp4',
                '.flac': 'audio/flac',
                '.wma': 'audio/x-ms-wma',
                '.opus': 'audio/opus',
                // Programming languages
                '.ts': 'text/typescript; charset=utf-8',
                '.tsx': 'text/typescript; charset=utf-8',
                '.jsx': 'text/jsx; charset=utf-8',
                '.py': 'text/x-python; charset=utf-8',
                '.java': 'text/x-java; charset=utf-8',
                '.c': 'text/x-c; charset=utf-8',
                '.cpp': 'text/x-c++; charset=utf-8',
                '.go': 'text/x-go; charset=utf-8',
                '.rs': 'text/x-rust; charset=utf-8',
                '.sh': 'application/x-sh; charset=utf-8',
                // Other
                '.wasm': 'application/wasm'
              };

              const contentType = contentTypes[ext] || 'application/octet-stream';

              // Handle Range requests for media files (enables seeking)
              const rangeHeader = req.headers.get('range');
              if (isMedia && rangeHeader) {
                // Parse range header (e.g., "bytes=0-1023" or "bytes=1024-")
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

                // Validate range
                if (start >= fileSize || end >= fileSize || start > end) {
                  return new Response('Range Not Satisfiable', {
                    status: 416,
                    headers: { 'Content-Range': \`bytes */\${fileSize}\` }
                  });
                }

                const chunkSize = (end - start) + 1;

                // Read the requested range
                const buffer = Buffer.alloc(chunkSize);
                const fd = fs.openSync(absolutePath, 'r');
                fs.readSync(fd, buffer, 0, chunkSize, start);
                fs.closeSync(fd);

                return new Response(buffer, {
                  status: 206, // Partial Content
                  headers: {
                    'Content-Type': contentType,
                    'Content-Range': \`bytes \${start}-\${end}/\${fileSize}\`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize.toString(),
                    'Access-Control-Allow-Origin': '*'
                  }
                });
              }

              // For media files without range, indicate range support
              if (isMedia) {
                const fileContent = fs.readFileSync(absolutePath);
                return new Response(fileContent, {
                  headers: {
                    'Content-Type': contentType,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': fileSize.toString(),
                    'Access-Control-Allow-Origin': '*'
                  }
                });
              }

              // For non-media files, read and send
              const fileContent = fs.readFileSync(absolutePath);

              // For HTML files, rewrite relative URLs to preview URLs
              if (ext === '.html' || ext === '.htm') {
                const baseDir = nodePath.dirname(absolutePath);
                let htmlContent = fileContent.toString('utf-8');

                // Rewrite relative URLs in common attributes (href, src, data, action)
                // Matches: href="./file.html" src="images/pic.png" etc.
                htmlContent = htmlContent.replace(
                  /(href|src|data|action)\\s*=\\s*["'](?!https?:\\/\\/|data:|mailto:|tel:|javascript:|#|\\/\\/)([^"']+)["']/gi,
                  (match, attr, url) => {
                    // Skip if already a preview URL
                    if (url.startsWith('/preview-file/')) return match;
                    // Resolve relative path to absolute
                    const resolvedPath = nodePath.resolve(baseDir, url);
                    const normalizedPath = resolvedPath.replace(/\\\\/g, '/');
                    return \`\${attr}="/preview-file/\${encodeURIComponent(normalizedPath)}"\`;
                  }
                );

                return new Response(htmlContent, {
                  headers: {
                    'Content-Type': contentType,
                    'Cache-Control': 'no-cache',
                    'Access-Control-Allow-Origin': '*'
                  }
                });
              }

              return new Response(fileContent, {
                headers: {
                  'Content-Type': contentType,
                  'Cache-Control': 'no-cache',
                  'Access-Control-Allow-Origin': '*'
                }
              });

            } catch (error) {
              console.error('[Bun] Preview file error:', error.message);
              if (error.code === 'ENOENT') {
                return new Response('File not found', { status: 404 });
              }
              return new Response(\`Error: \${error.message}\`, { status: 500 });
            }
          }

          // Serve static files
          const filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
          const fileContent = WEB_CLIENT_FILES[filePath];

          if (fileContent) {
            const buffer = Buffer.from(fileContent, 'base64');
            const ext = path.extname(filePath).slice(1);
            const mimeTypes = {
              'html': 'text/html',
              'js': 'application/javascript',
              'css': 'text/css',
              'json': 'application/json',
              'png': 'image/png',
              'jpg': 'image/jpeg',
              'svg': 'image/svg+xml',
              'ico': 'image/x-icon'
            };

            return new Response(buffer, {
              headers: {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }

          // Default 404
          return new Response('Not found', { status: 404 });
        },

        websocket: {
          open: (ws) => {
            // Get pathname from upgrade data
            const pathname = ws.data?.pathname || '/';
            const host = ws.data?.host || 'localhost';

            // console.log('[Bun] WebSocket connection opened for:', pathname);

            try {
              // Check if this is a special path that should be routed to WebInterfaceService
              const isBrowserStream = pathname.startsWith('/stream/browser/');
              const isAgentControl = pathname.startsWith('/control/agent/');

              // For stream/control connections, route to WebInterfaceService handler
              if ((isBrowserStream || isAgentControl) && this._connectionHandler) {
                // Create a mock WebSocket for compatibility
                const mockWs = {
                  send: (data) => {
                    try { ws.send(data); } catch (e) { /* ignore */ }
                  },
                  close: () => {
                    try { ws.close(); } catch (e) { /* ignore */ }
                  },
                  readyState: 1,
                  on: (event, handler) => {
                    if (!ws._handlers) ws._handlers = {};
                    ws._handlers[event] = handler;
                  }
                };

                // Create mock request with URL for path-based routing
                const mockRequest = {
                  url: pathname,
                  headers: { host: host }
                };

                ws._mockWs = mockWs;
                this._connectionHandler(mockWs, mockRequest);
                return;
              }

              // Main chat connection - add to broadcast clients
              wsClients.add(ws);

              // Send initial connection message
              ws.send(JSON.stringify({
                type: 'connection',
                data: { message: 'Connected to Auditaria CLI' },
                timestamp: Date.now()
              }));

              // Send current state
              if (serverState.history.length > 0) {
                ws.send(JSON.stringify({
                  type: 'history_sync',
                  data: { history: serverState.history },
                  timestamp: Date.now()
                }));
              }

              if (serverState.slashCommands.length > 0) {
                ws.send(JSON.stringify({
                  type: 'slash_commands',
                  data: { commands: serverState.slashCommands },
                  timestamp: Date.now()
                }));
              }

              ws.send(JSON.stringify({
                type: 'mcp_servers',
                data: serverState.mcpServers,
                timestamp: Date.now()
              }));

              ws.send(JSON.stringify({
                type: 'console_messages',
                data: serverState.consoleMessages,
                timestamp: Date.now()
              }));

              if (serverState.cliActionState && serverState.cliActionState.active) {
                ws.send(JSON.stringify({
                  type: 'cli_action_required',
                  data: serverState.cliActionState,
                  timestamp: Date.now()
                }));
              }

              // Send current pending item (for live tool updates like browser agent)
              if (serverState.pendingItem) {
                ws.send(JSON.stringify({
                  type: 'pending_item',
                  data: serverState.pendingItem,
                  ephemeral: true,
                  timestamp: Date.now()
                }));
              }

              // Send current loading state
              if (serverState.loadingState) {
                ws.send(JSON.stringify({
                  type: 'loading_state',
                  data: serverState.loadingState,
                  ephemeral: true,
                  timestamp: Date.now()
                }));
              }

              // Call the connection handler for main chat
              if (this._connectionHandler) {
                // Create a mock WebSocket for compatibility
                const mockWs = {
                  send: (data) => {
                    try { ws.send(data); } catch (e) { /* ignore */ }
                  },
                  close: () => {
                    try { ws.close(); } catch (e) { /* ignore */ }
                  },
                  readyState: 1,
                  on: (event, handler) => {
                    if (!ws._handlers) ws._handlers = {};
                    ws._handlers[event] = handler;
                  }
                };

                // Create mock request with URL
                const mockRequest = {
                  url: pathname,
                  headers: { host: host }
                };

                ws._mockWs = mockWs;
                this._connectionHandler(mockWs, mockRequest);
              }
            } catch (err) {
              console.error('[Bun] Error in open handler:', err);
            }
          },

          message: (ws, message) => {
            // console.log('[Bun] Message received:', message.toString().slice(0, 100));

            try {
              const data = JSON.parse(message.toString());

              // Handle different message types - these are already being processed
              // so we don't need to trigger mock handlers for them
              let messageHandled = false;

              if (data.type === 'user_message' && messageHandlers.submitQuery) {
                const query = data.content?.trim();
                if (query) {
                  messageHandlers.submitQuery(query);
                  messageHandled = true;
                }
              } else if (data.type === 'interrupt_request' && messageHandlers.abort) {
                messageHandlers.abort();
                messageHandled = true;
              } else if (data.type === 'tool_confirmation_response' && messageHandlers.confirmation) {
                if (data.callId && data.outcome) {
                  messageHandlers.confirmation(data.callId, data.outcome, data.payload);
                  messageHandled = true;
                }
              }

              // Only trigger mock handlers for unhandled message types
              // to avoid duplicate processing
              if (!messageHandled && ws._mockWs && ws._handlers && ws._handlers.message) {
                ws._handlers.message(message);
              }
            } catch (error) {
              // console.error('[Bun] Error handling message:', error);
            }
          },

          close: (ws, code, reason) => {
            // console.log('[Bun] WebSocket closed, code:', code, 'reason:', reason?.toString() || 'none');
            wsClients.delete(ws);

            if (ws._mockWs && ws._handlers && ws._handlers.close) {
              ws._handlers.close();
            }
          },

          error: (ws, error) => {
            // console.error('[Bun] WebSocket error:', error);
            wsClients.delete(ws);

            if (ws._mockWs && ws._handlers && ws._handlers.error) {
              ws._handlers.error(error);
            }
          }
        }
      });

      serverPort = unifiedServer.port;
      // console.log('[Bun] Unified server started on port', serverPort);

      // Stop the original Express server if it exists
      if (options.server && options.server.close) {
        // console.log('[Bun] Stopping original Express server');
        try {
          options.server.close();
          options.server.listening = false;
        } catch (e) {
          // console.log('[Bun] Could not stop Express server:', e.message);
        }
      }

      // Notify any waiting connection handlers
      if (this._connectionHandler) {
        wsClients.forEach(ws => {
          if (ws._mockWs) {
            this._connectionHandler(ws._mockWs, {});
          }
        });
      }
    }

    on(event, handler) {
      if (event === 'connection') {
        this._connectionHandler = handler;

        // Ensure server is created when handlers are attached
        // This happens when /web command is used
        if (!unifiedServer && this._options) {
          // console.log('[Bun] Late server initialization triggered by handler attachment');
          this._createServer(this._options);
        }

        // If we already have clients, call handler for them
        wsClients.forEach(ws => {
          if (ws._mockWs) {
            handler(ws._mockWs, {});
          }
        });
      }
    }

    // Method to manually start the server (for /web command)
    startServer() {
      if (!unifiedServer && this._options) {
        // console.log('[Bun] Manual server start requested');
        this._createServer(this._options);
        return serverPort;
      }
      return serverPort || null;
    }

    close(callback) {
      if (callback) callback();
    }
  }

  // Mock WebSocket class
  class BunMockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      this.readyState = 1;
      this.OPEN = 1;
      this.CLOSED = 3;
    }

    on() {}
    send() {}
    close() {}
  }

  // Override WebSocketServer globally
  globalThis.WebSocketServer = BunUnifiedWebSocketServer;
  globalThis.WebSocket = BunMockWebSocket;

  // Override require('ws') - simplified approach for Bun
  if (typeof require !== 'undefined' && typeof require.cache === 'object') {
    try {
      // Directly modify require.cache entries for ws module
      Object.keys(require.cache).forEach(key => {
        if (key.includes('ws') || key.includes('websocket')) {
          require.cache[key].exports = {
            WebSocketServer: BunUnifiedWebSocketServer,
            WebSocket: BunMockWebSocket,
            Server: BunUnifiedWebSocketServer
          };
        }
      });
    } catch (e) {}
  }

  // Override in require cache
  try {
    Object.keys(require.cache || {}).forEach(key => {
      if (key.includes('ws')) {
        require.cache[key].exports = {
          WebSocketServer: BunUnifiedWebSocketServer,
          WebSocket: BunMockWebSocket,
          Server: BunUnifiedWebSocketServer
        };
      }
    });
  } catch (e) {}

  // Create global broadcast function
  globalThis.bunBroadcast = function(message) {
    const payload = JSON.stringify({ ...message, timestamp: Date.now() });
    wsClients.forEach(ws => {
      try {
        ws.send(payload);
      } catch (e) {
        wsClients.delete(ws);
      }
    });
  };

  // Create state update functions
  globalThis.bunUpdateState = function(type, data) {
    if (type === 'history') serverState.history = data;
    else if (type === 'slashCommands') serverState.slashCommands = data;
    else if (type === 'mcpServers') serverState.mcpServers = data;
    else if (type === 'consoleMessages') serverState.consoleMessages = data;
    else if (type === 'cliActionState') serverState.cliActionState = data;
    else if (type === 'pendingItem') serverState.pendingItem = data;
    else if (type === 'loadingState') serverState.loadingState = data;
  };

  // Create handler setters
  globalThis.bunSetHandler = function(type, handler) {
    messageHandlers[type] = handler;
  };

  // Create function to start server on demand (for /web command)
  globalThis.bunStartServer = function() {
    // Find WebSocketServer instance and start it
    if (!unifiedServer) {
      // console.log('[Bun] Starting server on demand');
      // We need to trigger server creation through any WebSocketServer instance
      // The WebInterfaceService will have one
      return true; // Signal that server needs to be started
    }
    return false; // Server already running
  };

  globalThis.bunGetServerPort = function() {
    return serverPort;
  };

  // console.log('[Bun] Server infrastructure ready');
})();
`;

// Apply all fixes in order (bunCacheFix must be first to set up cache dirs before TransformersJS loads)
bundleContent = bunCacheFix + '\n' +
                argvCleanupFix + '\n' +
                interactiveModeFixEnhanced + '\n' +
                conditionalUnifiedBunServer + '\n' +
                bundleContent;

// Fix 4: Enhanced interactive mode check in the main code
// This ensures the CLI correctly detects interactive mode in Bun
bundleContent = bundleContent.replace(
  /const interactive = !!argv\.promptInteractive \|\| process33\.stdin\.isTTY && question\.length === 0;/g,
  `// Enhanced interactive check for Bun compatibility
  const interactive = !!argv.promptInteractive || !!argv.web ||
    (process33.stdin.isTTY && question.length === 0 && !argv.prompt);`
);

// Fix 5: Patch WebInterfaceService to skip file checks in Bun and serve from embedded files
bundleContent = bundleContent.replace(
  /for \(const testPath of possiblePaths\) \{[\s\S]*?\}[\s]*if \(!webClientPath\) \{/g,
  `// In Bun runtime, skip file checks and use embedded files
  if (typeof Bun !== 'undefined' && globalThis.__EMBEDDED_WEB_FILES) {
    webClientPath = '/$bunfs/embedded-web-client';
    if (debugMode) {
      // console.log('✓ Using embedded web client files in Bun runtime');
    }
  } else {
    for (const testPath of possiblePaths) {
      try {
        const fs = await import('fs');
        const indexPath = path.join(testPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          webClientPath = testPath;
          if (debugMode) {
            console.log(\`✓ Found web client files at: \${webClientPath}\`);
          }
          break;
        } else if (debugMode) {
          console.log(\`✗ Not found: \${indexPath}\`);
        }
      } catch (error) {
        if (debugMode) {
          console.log(\`✗ Error checking \${testPath}:\`, error);
        }
        // Continue to next path
      }
    }
  }

  if (!webClientPath) {`
);

// Fix 6: Patch WebSocketServer instantiation
bundleContent = bundleContent.replace(
  /new import_websocket_server\.(default|WebSocketServer)\(/g,
  'new (globalThis.WebSocketServer || import_websocket_server.default)('
);

// Fix 7: Patch WebInterfaceService methods to use global broadcast
bundleContent = bundleContent.replace(
  /broadcastMessage\(historyItem\)\s*{/g,
  `broadcastMessage(historyItem) {
    if (typeof bunBroadcast !== 'undefined') {
      bunUpdateState('history', [...(this.currentHistory || []), historyItem]);
      bunBroadcast({ type: 'history_item', data: historyItem });
      return;
    }`
);

bundleContent = bundleContent.replace(
  /setSubmitQueryHandler\(handler\)\s*{/g,
  `setSubmitQueryHandler(handler) {
    if (typeof bunSetHandler !== 'undefined') {
      bunSetHandler('submitQuery', handler);
    }`
);

// Fix 7b: Patch broadcastPendingItem for live tool updates (browser agent streaming)
bundleContent = bundleContent.replace(
  /broadcastPendingItem\(pendingItem\)\s*{/g,
  `broadcastPendingItem(pendingItem) {
    // Store current pending item for new clients
    this.currentPendingItem = pendingItem;
    if (typeof bunBroadcast !== 'undefined') {
      bunUpdateState('pendingItem', pendingItem);
      bunBroadcast({ type: 'pending_item', data: pendingItem, ephemeral: true });
      return;
    }`
);

// Fix 7c: Patch broadcastLoadingState for loading state updates
bundleContent = bundleContent.replace(
  /broadcastLoadingState\(loadingState\)\s*{/g,
  `broadcastLoadingState(loadingState) {
    // Store current loading state for new clients
    this.currentLoadingState = loadingState;
    if (typeof bunBroadcast !== 'undefined') {
      bunUpdateState('loadingState', loadingState);
      bunBroadcast({ type: 'loading_state', data: loadingState, ephemeral: true });
      return;
    }`
);

// Fix 7d: Patch broadcastFooterData for footer updates
bundleContent = bundleContent.replace(
  /broadcastFooterData\(footerData\)\s*{/g,
  `broadcastFooterData(footerData) {
    if (typeof bunBroadcast !== 'undefined') {
      bunBroadcast({ type: 'footer_data', data: footerData });
      return;
    }`
);

// Fix 7e: Patch broadcastWithSequence (generic broadcast helper used by many methods)
bundleContent = bundleContent.replace(
  /broadcastWithSequence\(type, data\)\s*{/g,
  `broadcastWithSequence(type, data) {
    if (typeof bunBroadcast !== 'undefined') {
      bunBroadcast({ type, data });
      return;
    }`
);

// Fix 7f: Patch setAbortHandler
bundleContent = bundleContent.replace(
  /setAbortHandler\(handler\)\s*{/g,
  `setAbortHandler(handler) {
    if (typeof bunSetHandler !== 'undefined') {
      bunSetHandler('abort', handler);
    }`
);

// Fix 7g: Patch setConfirmationResponseHandler
bundleContent = bundleContent.replace(
  /setConfirmationResponseHandler\(handler\)\s*{/g,
  `setConfirmationResponseHandler(handler) {
    if (typeof bunSetHandler !== 'undefined') {
      bunSetHandler('confirmation', handler);
    }`
);

// Fix 8: Suppress locale warnings
console.log('   ✓ Suppressing locale warnings...');
bundleContent = bundleContent.replace(
  /console\.warn\("Could not read locales directory, falling back to defaults:", error\);/g,
  '// Warning suppressed for Bun executable'
);

bundleContent = bundleContent.replace(
  /console\.warn\(`Could not load translations for language \${language}:`, error\);/g,
  '// Warning suppressed for Bun executable'
);

// Fix 9a: Force TransformersJS cacheDir and ONNX WASM paths in Bun executables
// The env.cacheDir is broken in Bun because it's computed from import.meta.url
// Also configure ONNX to use local WASM files instead of CDN
console.log('   ✓ Patching TransformersJS cache directory for Bun...');
bundleContent = bundleContent.replace(
  /const (env\d+) = transformers\.env;/g,
  (match, varName) => `const ${varName} = transformers.env;
      // BUN FIX: Set proper cache directory (import.meta.url is broken in Bun executables)
      if (typeof Bun !== 'undefined' && globalThis.__BUN_TRANSFORMERS_CACHE_DIR) {
        ${varName}.cacheDir = globalThis.__BUN_TRANSFORMERS_CACHE_DIR;
      }
      // BUN FIX: Configure ONNX WASM paths to use extracted files instead of CDN
      if (typeof Bun !== 'undefined' && globalThis.__BUN_ONNX_WASM_DIR) {
        // Set ONNX runtime to use local WASM files
        // This must be done BEFORE creating any ONNX session
        if (${varName}.backends && ${varName}.backends.onnx && ${varName}.backends.onnx.wasm) {
          ${varName}.backends.onnx.wasm.wasmPaths = globalThis.__BUN_ONNX_WASM_DIR + '/';
        }
      }`
);

// Fix 9b: Patch the dynamic import of @huggingface/transformers to configure ONNX paths
// This ensures WASM paths are set before any ONNX operations
console.log('   ✓ Patching ONNX runtime WASM paths for Bun...');
bundleContent = bundleContent.replace(
  /const transformers = await import\("@huggingface\/transformers"\);/g,
  `const transformers = await import("@huggingface/transformers");
      // BUN FIX: Configure ONNX WASM paths immediately after import
      if (typeof Bun !== 'undefined' && globalThis.__BUN_ONNX_WASM_DIR) {
        try {
          const onnxWasmDir = globalThis.__BUN_ONNX_WASM_DIR;

          // Configure TransformersJS env.backends.onnx
          if (transformers.env && transformers.env.backends && transformers.env.backends.onnx) {
            transformers.env.backends.onnx.wasm = transformers.env.backends.onnx.wasm || {};
            transformers.env.backends.onnx.wasm.wasmPaths = onnxWasmDir + '/';
            transformers.env.backends.onnx.wasm.numThreads = 1;
            // Pre-load WASM binary if available
            if (globalThis.ort && globalThis.ort.env && globalThis.ort.env.wasm && globalThis.ort.env.wasm.wasmBinary) {
              transformers.env.backends.onnx.wasm.wasmBinary = globalThis.ort.env.wasm.wasmBinary;
            }
          }

          // Also try to configure onnxruntime-web directly
          try {
            const ort = await import("onnxruntime-web");
            if (ort && ort.env && ort.env.wasm) {
              ort.env.wasm.wasmPaths = onnxWasmDir + '/';
              ort.env.wasm.numThreads = 1;
              if (globalThis.ort && globalThis.ort.env && globalThis.ort.env.wasm && globalThis.ort.env.wasm.wasmBinary) {
                ort.env.wasm.wasmBinary = globalThis.ort.env.wasm.wasmBinary;
              }
            }
          } catch (ortErr) {
            // ONNX direct configuration failed, but TransformersJS config should work
          }
        } catch (e) {
          // ONNX configuration error - embeddings may not work
        }
      }`
);

// Fix 9c: Patch CanvasKitInit to use locateFile for canvaskit.wasm in Bun executables
// Scribe.js uses canvaskit-wasm but doesn't pass locateFile, so it fails in Bun
console.log('   ✓ Patching CanvasKit initialization for Bun...');
bundleContent = bundleContent.replace(
  /ca\.CanvasKit = await CanvasKitInit\(\);/g,
  `// BUN FIX: Pass locateFile to find canvaskit.wasm from extracted location
      ca.CanvasKit = await CanvasKitInit(
        typeof Bun !== 'undefined' && globalThis.__BUN_CANVASKIT_PATH
          ? {
              locateFile: (file) => {
                if (file === 'canvaskit.wasm' || file.endsWith('canvaskit.wasm')) {
                  return globalThis.__BUN_CANVASKIT_PATH;
                }
                return file;
              }
            }
          : undefined
      );`
);

// Fix 9d: Patch tesseract.js worker path resolution for Bun executables
// Tesseract.js computes workerPath from __dirname which doesn't work in bundled executables
console.log('   ✓ Patching tesseract.js worker path for Bun...');
// Pattern: workerPath: path137.join(__dirname, "..", "..", "worker-script", "node", "index.js")
const tesseractWorkerPathPattern = /workerPath:\s*path(\d+)\.join\(__dirname,\s*"\.\.",\s*"\.\.",\s*"worker-script",\s*"node",\s*"index\.js"\)/g;
bundleContent = bundleContent.replace(
  tesseractWorkerPathPattern,
  (match, pathNum) => `workerPath: (typeof Bun !== 'undefined' && globalThis.__BUN_TESSERACT_WORKER_PATH)
      ? globalThis.__BUN_TESSERACT_WORKER_PATH
      : path${pathNum}.join(__dirname, "..", "..", "worker-script", "node", "index.js")`
);

// Fix 9e: Patch MuPDF worker URL for Bun executables
// Scribe.js uses new URL("./mupdf-worker.js", import.meta.url) which doesn't work in Bun executables
console.log('   ✓ Patching MuPDF worker path for Bun...');
// Pattern: worker = new WorkerNode(new URL("./mupdf-worker.js", import.meta.url));
bundleContent = bundleContent.replace(
  /worker = new WorkerNode\(new URL\("\.\/mupdf-worker\.js", import\.meta\.url\)\);/g,
  `worker = new WorkerNode(
      (typeof Bun !== 'undefined' && globalThis.__BUN_MUPDF_WORKER_PATH)
        ? globalThis.__BUN_MUPDF_WORKER_PATH
        : new URL("./mupdf-worker.js", import.meta.url)
    );`
);

// Fix 9f: Patch Scribe generalWorker URL for Bun executables
// Scribe.js uses new URL("./worker/generalWorker.js", import.meta.url) which doesn't work in Bun executables
console.log('   ✓ Patching Scribe general worker path for Bun...');
// Pattern: worker = new WorkerNode(new URL("./worker/generalWorker.js", import.meta.url));
bundleContent = bundleContent.replace(
  /worker = new WorkerNode\(new URL\("\.\/worker\/generalWorker\.js", import\.meta\.url\)\);/g,
  `worker = new WorkerNode(
      (typeof Bun !== 'undefined' && globalThis.__BUN_SCRIBE_WORKER_PATH)
        ? globalThis.__BUN_SCRIBE_WORKER_PATH
        : new URL("./worker/generalWorker.js", import.meta.url)
    );`
);

// Fix 9g: Patch scribe.js-ocr import to use bundled version in Bun executables
// The bundled version has patched font loading that works with Bun's virtual filesystem
console.log('   ✓ Patching scribe.js-ocr import for Bun...');

// Pattern: await import("scribe.js-ocr") or import('scribe.js-ocr')
// Replace with code that imports from extracted bundled version in Bun
const scribeImportCount = (bundleContent.match(/import\s*\(\s*["']scribe\.js-ocr["']\s*\)/g) || []).length;
console.log(`      Found ${scribeImportCount} scribe.js-ocr import(s) to patch`);

bundleContent = bundleContent.replace(
  /import\s*\(\s*["']scribe\.js-ocr["']\s*\)/g,
  `(async () => {
    if (typeof Bun !== 'undefined' && globalThis.__BUN_SCRIBE_MAIN_PATH) {
      return import(globalThis.__BUN_SCRIBE_MAIN_PATH);
    }
    return import("scribe.js-ocr");
  })()`
);

// Fix 9: Replace file reading with embedded data check
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

// Verify scribe.js patches are in the bundle
const scribeDirCount = (bundleContent.match(/globalThis\.__BUN_SCRIBE_DIR/g) || []).length;
console.log(`   ✓ Scribe.js __BUN_SCRIBE_DIR references in bundle: ${scribeDirCount}`);

// Write modified bundle
const tempPath = path.join(__dirname, '..', 'bundle', 'gemini-bun-unified.js');
fs.writeFileSync(tempPath, bundleContent);
console.log(`   ✓ Bundle size: ${(bundleContent.length / 1024 / 1024).toFixed(2)} MB`);

console.log('\n🚀 Compiling...');

// Detect Bun path - try multiple locations
let bunPath = '';
const possibleBunPaths = [
  path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'), // User profile (Windows)
  path.join(process.env.HOME || '', '.bun', 'bin', 'bun.exe'), // Home directory
  'C:\\Users\\thaci\\.bun\\bin\\bun.exe', // Local development fallback
  'bun.exe', // In PATH (Windows)
  'bun' // In PATH (cross-platform)
];

for (const testPath of possibleBunPaths) {
  try {
    // Test if the command works
    execSync(`"${testPath}" --version`, { stdio: 'ignore' });
    bunPath = testPath;
    console.log(`   ✓ Found Bun at: ${bunPath}`);
    break;
  } catch (e) {
    // Continue to next path
  }
}

if (!bunPath) {
  console.error('\n❌ Could not find Bun executable. Please ensure Bun is installed.');
  console.error('   Tried paths:', possibleBunPaths);
  process.exit(1);
}

try {
  const iconPath = path.join(__dirname, '..', 'assets', 'auditaria.ico');
  // External packages that can't be bundled by Bun
  // Note: web-tree-sitter and tree-sitter-bash are now bundled, WASM loaded from embedded assets
  const bunExternals = [
    'youtube-transcript',  // Optional dep of markitdown-ts
    'unzipper',  // Optional dep of markitdown-ts
  ].map(e => `--external ${e}`).join(' ');
  execSync(`"${bunPath}" build "${tempPath}" --compile --target=bun-windows-x64 --windows-icon="${iconPath}" ${bunExternals} --outfile "${OUTPUT_PATH}"`, {
    stdio: 'inherit'
  });

  console.log('\n✅ Build successful!');
  console.log('\n📋 Test instructions:');
  console.log('   Interactive mode (default):');
  console.log('      auditaria-standalone.exe');
  console.log('   ');
  console.log('   One-shot mode with prompt:');
  console.log('      auditaria-standalone.exe "What is 2+2?"');
  console.log('   ');
  console.log('   Web interface mode:');
  console.log('      auditaria-standalone.exe -w no-browser');
  console.log('      Or with custom port: auditaria-standalone.exe -w no-browser --port 3000');
  console.log('   ');
  console.log('   Then open: http://localhost:8629 (or your custom port)');

} catch (error) {
  console.error('\n❌ Build failed:', error.message);
} finally {
  // Clean up temporary files
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }
  if (fs.existsSync(BUN_BUNDLE_PATH)) {
    fs.unlinkSync(BUN_BUNDLE_PATH);
  }
}