/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const patchesDir = join(rootDir, 'patches');

// Only run patch-package if patches directory exists (development environment)
if (existsSync(patchesDir)) {
  try {
    // Check if patch-package is available
    execSync('npx patch-package --version', { stdio: 'ignore', cwd: rootDir });
    // Run patch-package
    console.log('Applying patches...');
    execSync('npx patch-package', { stdio: 'inherit', cwd: rootDir });
  } catch {
    // patch-package not installed - this is fine for production installs
    console.log(
      'Note: patch-package not available, skipping patches (this is normal for production installs)',
    );
  }
} else {
  // No patches directory - this is a published package install, nothing to do
}
