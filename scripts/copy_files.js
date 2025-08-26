#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Copyright 2025 Google LLC
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

import fs from 'node:fs';
import path from 'node:path';

const sourceDir = path.join('src');
const targetDir = path.join('dist', 'src');

const extensionsToCopy = ['.md', '.json', '.sb'];

function copyFilesRecursive(source, target, copyAllFiles = false) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const items = fs.readdirSync(source, { withFileTypes: true });

  for (const item of items) {
    const sourcePath = path.join(source, item.name);
    const targetPath = path.join(target, item.name);

    if (item.isDirectory()) {
      copyFilesRecursive(sourcePath, targetPath, copyAllFiles);
    } else if (copyAllFiles || extensionsToCopy.includes(path.extname(item.name))) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

if (!fs.existsSync(sourceDir)) {
  console.error(`Source directory ${sourceDir} not found.`);
  process.exit(1);
}

copyFilesRecursive(sourceDir, targetDir);

// Copy web client files to CLI package dist if we're building the CLI package
const packageJsonPath = path.join(process.cwd(), 'package.json');
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  if (packageJson.name === '@thacio/auditaria-cli') {
    // Copy web client files from bundle to CLI package dist
    const webClientSrc = path.resolve(process.cwd(), '../../bundle/web-client');
    const webClientDest = path.join(process.cwd(), 'dist', 'web-client');
    
    if (fs.existsSync(webClientSrc)) {
      console.log('Copying web client files to CLI package...');
      copyFilesRecursive(webClientSrc, webClientDest, true); // Copy all files for web client
      console.log('Web client files copied to dist/web-client/');
    }
  }
}

console.log('Successfully copied files.');
