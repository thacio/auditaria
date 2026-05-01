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

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// npm install if node_modules was removed (e.g. via npm run clean or scripts/clean.js)
if (!existsSync(join(root, 'node_modules'))) {
  execSync('npm install', { stdio: 'inherit', cwd: root });
}

// build all workspaces/packages
execSync('npm run generate', { stdio: 'inherit', cwd: root });

// AUDITARIA: Build in topological order. Each package's build_package.js wipes
// its own dist/ before tsc emits; on a cold cache, consumer tsc instances fall
// back to source resolution via workspace symlinks and miss ambient .d.ts
// declarations (e.g. scribe.js-ocr, vectorlite in packages/search/src/).
// Both `npm run build --workspaces` (declaration order) and the prior parallel
// path raced on this. Forcing topo order eliminates the flake.
//
// Layers (workspace deps only — devDeps ignored since they don't gate tsc):
//   0: leaf packages with no workspace deps
//   1: core (depends on search + browser-agent)
//   2: consumers of core
const BUILD_ORDER = [
  // Layer 0 — leaves
  '@thacio/auditaria-search',
  '@thacio/browser-agent',
  '@google/gemini-cli-devtools',
  'gemini-cli-vscode-ide-companion',
  // Layer 1 — core
  '@google/gemini-cli-core',
  // Layer 2 — core consumers
  '@google/gemini-cli-test-utils',
  '@google/gemini-cli-a2a-server',
  '@google/gemini-cli-sdk',
  '@thacio/auditaria',
];

for (const pkg of BUILD_ORDER) {
  console.log(`Building ${pkg}...`);
  execSync(`npm run build -w ${pkg}`, { stdio: 'inherit', cwd: root });
}

// also build container image if sandboxing is enabled
// skip (-s) npm install + build since we did that above
try {
  execSync('node scripts/sandbox_command.js -q', {
    stdio: 'inherit',
    cwd: root,
  });
  if (
    process.env.BUILD_SANDBOX === '1' ||
    process.env.BUILD_SANDBOX === 'true'
  ) {
    execSync('node scripts/build_sandbox.js -s', {
      stdio: 'inherit',
      cwd: root,
    });
  }
} catch {
  // ignore
}
