/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { wasmLoader } from 'esbuild-plugin-wasm';
import i18nTransformPlugin from './scripts/i18n-transform/index.js'; // AUDITARIA_I18N custom feature
import packageRenamePlugin from './scripts/package-rename-transform/index.js'; // AUDITARIA: Transform @google/gemini-cli to @thacio/auditaria-cli

let esbuild;
try {
  esbuild = (await import('esbuild')).default;
} catch (_error) {
  console.error('esbuild not available - cannot build bundle');
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.resolve(__dirname, 'package.json'));

function createWasmPlugins() {
  const wasmBinaryPlugin = {
    name: 'wasm-binary',
    setup(build) {
      build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
        const specifier = args.path.replace(/\?binary$/, '');
        const resolveDir = args.resolveDir || '';
        const isBareSpecifier =
          !path.isAbsolute(specifier) &&
          !specifier.startsWith('./') &&
          !specifier.startsWith('../');

        let resolvedPath;
        if (isBareSpecifier) {
          resolvedPath = require.resolve(specifier, {
            paths: resolveDir ? [resolveDir, __dirname] : [__dirname],
          });
        } else {
          resolvedPath = path.isAbsolute(specifier)
            ? specifier
            : path.join(resolveDir, specifier);
        }

        return { path: resolvedPath, namespace: 'wasm-embedded' };
      });
    },
  };

  return [wasmBinaryPlugin, wasmLoader({ mode: 'embedded' })];
}

const external = [
  '@lydell/node-pty',
  'node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
  // AUDITARIA_BROWSER_AGENT: Stagehand must be external to avoid worker thread crash
  // It has heavy initialization on import that's incompatible with worker threads
  '@browserbasehq/stagehand',
  'playwright',
  'playwright-core',
  // AUDITARIA_SEARCH: markitdown-ts optional dependencies (used dynamically)
  'youtube-transcript',
  'unzipper',
  // AUDITARIA_SEARCH: transformers.js must be external due to complex WASM/ONNX backend initialization
  '@huggingface/transformers',
  // AUDITARIA_SEARCH: tesseract.js must be external due to worker thread spawning
  'tesseract.js',
  // AUDITARIA_LOCAL_SEARCH: search package has complex dependencies (pglite, transformers.js)
  '@thacio/auditaria-cli-search',
  // keytar is a native module that cannot be bundled
  'keytar',
  // AUDITARIA_CLAUDE_PROVIDER: Claude Agent SDK must be external (dynamic import at runtime)
  '@anthropic-ai/claude-agent-sdk',
];

const baseConfig = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
  loader: { '.node': 'file' },
  write: true,
};

const cliConfig = {
  ...baseConfig,
  banner: {
    js: `const require = (await import('module')).createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);`,
  },
  entryPoints: ['packages/cli/index.ts'],
  outfile: 'bundle/gemini.js',
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  plugins: [
    ...createWasmPlugins(),
    i18nTransformPlugin(), // AUDITARIA_I18N custom feature
    packageRenamePlugin(), // AUDITARIA: Transform package names
  ],
  alias: {
    'is-in-ci': path.resolve(__dirname, 'packages/cli/src/patches/is-in-ci.ts'),
  },
  metafile: true,
};

const a2aServerConfig = {
  ...baseConfig,
  banner: {
    js: `const require = (await import('module')).createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);`,
  },
  entryPoints: ['packages/a2a-server/src/http/server.ts'],
  outfile: 'packages/a2a-server/dist/a2a-server.mjs',
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  plugins: [
    ...createWasmPlugins(),
    i18nTransformPlugin(), // AUDITARIA_I18N custom feature
    packageRenamePlugin(), // AUDITARIA: Transform package names
  ],
};

Promise.allSettled([
  esbuild.build(cliConfig).then(({ metafile }) => {
    if (process.env.DEV === 'true') {
      writeFileSync('./bundle/esbuild.json', JSON.stringify(metafile, null, 2));
    }
  }),
  esbuild.build(a2aServerConfig),
]).then((results) => {
  const [cliResult, a2aResult] = results;
  if (cliResult.status === 'rejected') {
    console.error('gemini.js build failed:', cliResult.reason);
    process.exit(1);
  }
  // error in a2a-server bundling will not stop gemini.js bundling process
  if (a2aResult.status === 'rejected') {
    console.warn('a2a-server build failed:', a2aResult.reason);
  }
});
