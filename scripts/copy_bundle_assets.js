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

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const bundleDir = join(root, 'bundle');

// Create the bundle directory if it doesn't exist
if (!existsSync(bundleDir)) {
  mkdirSync(bundleDir);
}

// Find and copy all .sb files from packages to the root of the bundle directory
const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
for (const file of sbFiles) {
  copyFileSync(join(root, file), join(bundleDir, basename(file)));
}

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

// Find and copy all .vsix files from packages to the root of the bundle directory
const vsixFiles = glob.sync('packages/vscode-ide-companion/*.vsix', {
  cwd: root,
});
for (const file of vsixFiles) {
  copyFileSync(join(root, file), join(bundleDir, basename(file)));
}

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
    nodir: true 
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

console.log('Assets and locale files copied to bundle/');
