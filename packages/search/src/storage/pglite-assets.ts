/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
// Search is a standalone package; importing core here would introduce a cycle.
// eslint-disable-next-line no-restricted-imports
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface EmbeddedAssets {
  wasm: string;
  data: string;
  vector: string;
  amcheck: string;
  initdb?: string;
}

function isEmbeddedAssets(value: unknown): value is EmbeddedAssets {
  return (
    typeof value === 'object' &&
    value !== null &&
    'wasm' in value &&
    typeof value.wasm === 'string' &&
    'data' in value &&
    typeof value.data === 'string' &&
    'vector' in value &&
    typeof value.vector === 'string' &&
    'amcheck' in value &&
    typeof value.amcheck === 'string' &&
    (!('initdb' in value) || typeof value.initdb === 'string')
  );
}

/** Compiled Bun executables supply these bytes from sea/pglite-assets.cjs. */
export async function embeddedPGliteOptions(major: 17 | 18) {
  const embedded = (globalThis as Record<string, unknown>)
    .__PGLITE_EMBEDDED_ASSETS;
  if (!embedded) return undefined;
  let assets: unknown;
  if (typeof embedded === 'object') {
    if (major === 17 && 'pg17' in embedded) assets = embedded.pg17;
    if (major === 18 && 'pg18' in embedded) assets = embedded.pg18;
  }
  if (
    !isEmbeddedAssets(assets) ||
    !assets.wasm ||
    !assets.data ||
    !assets.vector ||
    !assets.amcheck ||
    (major === 18 && !assets.initdb)
  ) {
    throw new Error(
      `The executable is missing PostgreSQL ${major} assets. Rebuild it with the current PGlite asset helper.`,
    );
  }

  // Version the whole asset set, including extensions. WASM headers aren't unique.
  const hash = createHash('sha256');
  for (const value of Object.values(assets)) hash.update(value);
  const directory = join(
    homedir(),
    '.auditaria',
    'pglite-assets',
    hash.digest('hex'),
  );
  mkdirSync(directory, { recursive: true });
  const extension = (name: 'vector' | 'amcheck') => {
    const file = join(directory, `${name}.tar.gz`);
    if (!existsSync(file))
      writeFileSync(file, Buffer.from(assets[name], 'base64'));
    return { name, setup: async () => ({ bundlePath: pathToFileURL(file) }) };
  };
  const wasmModule = await WebAssembly.compile(
    new Uint8Array(Buffer.from(assets.wasm, 'base64')),
  );
  const fsBundle = new Blob([
    new Uint8Array(Buffer.from(assets.data, 'base64')),
  ]);
  const extensions = {
    vector: extension('vector'),
    amcheck: extension('amcheck'),
  };
  if (major === 17) return { wasmModule, fsBundle, extensions };
  return {
    pgliteWasmModule: wasmModule,
    initdbWasmModule: await WebAssembly.compile(
      new Uint8Array(Buffer.from(assets.initdb!, 'base64')),
    ),
    fsBundle,
    extensions,
  };
}
