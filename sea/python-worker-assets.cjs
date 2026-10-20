/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function collectPythonWorkerAssets() {
  const directory = join(__dirname, '..', 'packages', 'search', 'python');
  return {
    worker: readFileSync(join(directory, 'embeddinggemma.py'), 'utf8'),
    media: readFileSync(join(directory, 'media_inputs.py'), 'utf8'),
  };
}

module.exports = { collectPythonWorkerAssets };
