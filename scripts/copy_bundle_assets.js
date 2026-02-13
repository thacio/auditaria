/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { copyFileSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundleDir = join(root, 'bundle');

// Create the bundle directory if it doesn't exist
if (!existsSync(bundleDir)) {
  mkdirSync(bundleDir);
}

// 1. Copy Sandbox definitions (.sb)
const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
for (const file of sbFiles) {
  copyFileSync(join(root, file), join(bundleDir, basename(file)));
}

// 2. Copy Policy definitions (.toml)
const policyDir = join(bundleDir, 'policies');
if (!existsSync(policyDir)) {
  mkdirSync(policyDir);
}

// Locate policy files specifically in the core package
const policyFiles = glob.sync('packages/core/src/policy/policies/*.toml', {
  cwd: root,
});

for (const file of policyFiles) {
  copyFileSync(join(root, file), join(policyDir, basename(file)));
}

console.log(`Copied ${policyFiles.length} policy files to bundle/policies/`);

// 3. Copy Documentation (docs/)
const docsSrc = join(root, 'docs');
const docsDest = join(bundleDir, 'docs');
if (existsSync(docsSrc)) {
  cpSync(docsSrc, docsDest, { recursive: true, dereference: true });
  console.log('Copied docs to bundle/docs/');
}

// 4. Copy Built-in Skills (packages/core/src/skills/builtin)
const builtinSkillsSrc = join(root, 'packages/core/src/skills/builtin');
const builtinSkillsDest = join(bundleDir, 'builtin');
if (existsSync(builtinSkillsSrc)) {
  cpSync(builtinSkillsSrc, builtinSkillsDest, {
    recursive: true,
    dereference: true,
  });
  console.log('Copied built-in skills to bundle/builtin/');
}

// AUDITARIA_FEATURE_START: i18n-locales
// Create locales directory in bundle and copy translation files
const localesDir = join(bundleDir, 'locales');
if (!existsSync(localesDir)) {
  mkdirSync(localesDir, { recursive: true });
}

// Find and copy all .json files from i18n/locales directories
const localeFiles = glob.sync('packages/**/i18n/locales/*.json', { cwd: root });
for (const file of localeFiles) {
  const fileName = basename(file);
  copyFileSync(join(root, file), join(localesDir, fileName));
}
// AUDITARIA_FEATURE_END

// AUDITARIA_SEARCH_START: Copy search package and PGlite files
// The search package is marked as external in esbuild because it has complex
// dependencies (PGlite, transformers.js). We need to copy the built package
// to bundle/node_modules so it can be found at runtime.

// 1. Copy the built search package to bundle/node_modules
const searchPackageSrc = join(root, 'packages/search');
const searchPackageDest = join(
  bundleDir,
  'node_modules/@thacio/auditaria-search',
);

if (existsSync(join(searchPackageSrc, 'dist'))) {
  // Create destination directory
  mkdirSync(searchPackageDest, { recursive: true });

  // Copy dist folder
  cpSync(join(searchPackageSrc, 'dist'), join(searchPackageDest, 'dist'), {
    recursive: true,
    dereference: true,
  });

  // Copy package.json
  copyFileSync(
    join(searchPackageSrc, 'package.json'),
    join(searchPackageDest, 'package.json'),
  );

  // Copy python folder if it exists (for Python embedder)
  const pythonSrc = join(searchPackageSrc, 'python');
  if (existsSync(pythonSrc)) {
    cpSync(pythonSrc, join(searchPackageDest, 'python'), {
      recursive: true,
      dereference: true,
    });
  }

  console.log(
    'Search package copied to bundle/node_modules/@thacio/auditaria-search/',
  );
}

// 2. Copy PGlite WASM, data, and extension files
// PGlite requires its WASM, data, and extension files at runtime
const pgliteDir = join(root, 'node_modules/@electric-sql/pglite/dist');

if (existsSync(pgliteDir)) {
  // Core PGlite files
  const pgliteFiles = ['pglite.wasm', 'pglite.data'];
  for (const file of pgliteFiles) {
    const srcPath = join(pgliteDir, file);
    if (existsSync(srcPath)) {
      copyFileSync(srcPath, join(bundleDir, file));
    }
  }

  // PGlite extensions (pgvector for vector similarity search)
  // Note: PGlite's bundled code uses "../vector.tar.gz" relative to bundle/gemini.js
  // so we need to copy to project root, not bundle directory
  const extensionFiles = ['vector.tar.gz'];
  for (const file of extensionFiles) {
    const srcPath = join(pgliteDir, file);
    if (existsSync(srcPath)) {
      // Copy to project root (parent of bundleDir)
      copyFileSync(srcPath, join(root, file));
    }
  }

  console.log('PGlite WASM/data/extension files copied to bundle/');
}
// AUDITARIA_SEARCH_END

// AUDITARIA_BROWSER_AGENT_START: Copy stagehand package.json for module resolution
// Stagehand's dist/index.js is re-bundled by esbuild (see esbuild.config.js) with all
// dependencies inlined. We only need to copy the package.json for Node's require() resolution.
const stagehandSrc = join(
  root,
  'node_modules/@browserbasehq/stagehand',
);
const stagehandDest = join(
  bundleDir,
  'node_modules/@browserbasehq/stagehand',
);

if (existsSync(join(stagehandSrc, 'package.json'))) {
  mkdirSync(stagehandDest, { recursive: true });

  copyFileSync(
    join(stagehandSrc, 'package.json'),
    join(stagehandDest, 'package.json'),
  );

  console.log(
    'Stagehand package.json copied to bundle/node_modules/@browserbasehq/stagehand/',
  );
}
// AUDITARIA_BROWSER_AGENT_END

// WEB_INTERFACE_START: Copy web client files
// Copy web client files to bundle directory
const webClientSrc = join(root, 'packages/web-client/src');
const webClientDest = join(bundleDir, 'web-client');

if (existsSync(webClientSrc)) {
  if (!existsSync(webClientDest)) {
    mkdirSync(webClientDest, { recursive: true });
  }

  // Copy all files from web-client/src to bundle/web-client
  const webClientFiles = glob.sync('**/*', {
    cwd: webClientSrc,
    nodir: true,
  });

  for (const file of webClientFiles) {
    const srcPath = join(webClientSrc, file);
    const destPath = join(webClientDest, file);
    const destDir = dirname(destPath);

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    copyFileSync(srcPath, destPath);
  }

  console.log('Web client files copied to bundle/web-client/');
}
// WEB_INTERFACE_END

console.log('Assets and locale files copied to bundle/');
