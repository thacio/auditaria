/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/** Shared by both executable builders; fail the build if a required asset is missing. */
function collectPGliteAssets() {
  const modules = join(__dirname, '..', 'node_modules', '@electric-sql');
  const collect = (name, vectorPackage, hasInitdb) => {
    const dist = join(modules, name, 'dist');
    const read = (file) => readFileSync(join(dist, file), 'base64');
    return {
      wasm: read('pglite.wasm'),
      data: read('pglite.data'),
      vector: readFileSync(
        join(modules, vectorPackage, 'dist', 'vector.tar.gz'),
        'base64',
      ),
      amcheck: read('amcheck.tar.gz'),
      ...(hasInitdb ? { initdb: read('initdb.wasm') } : {}),
    };
  };
  return {
    pg18: collect('pglite', 'pglite-pgvector', true),
    pg17: collect('pglite-pg17', 'pglite-pg17', false),
  };
}

module.exports = { collectPGliteAssets };
