/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation

import express, { Router, type RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** How many parent directories to inspect when looking for the repo root. */
const MAX_UPWARD_LEVELS = 8;

/**
 * Walks up from `startDir` and returns the first ancestor (inclusive) that
 * contains `relativeProbe`, or null.
 */
function findUpwards(startDir: string, relativeProbe: string): string | null {
  let dir = startDir;
  for (let i = 0; i < MAX_UPWARD_LEVELS; i++) {
    const candidate = path.join(dir, relativeProbe);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function packageRelativeWebClient(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const packageDir = path.dirname(
      require.resolve('@thacio/auditaria/package.json'),
    );
    return path.join(packageDir, 'web-client');
  } catch {
    return null;
  }
}

/**
 * Candidate locations for the web client's static files, most specific
 * first:
 *   1. the installed package (global npm installs),
 *   2. next to this module (the published bundle ships `web-client/` beside
 *      `gemini.js`),
 *   3. the built bundle in a source checkout,
 *   4. the raw client sources in a source checkout,
 *   5. the raw sources relative to the working directory (legacy).
 */
export function webClientCandidates(
  moduleDir: string = MODULE_DIR,
  cwd: string = process.cwd(),
): string[] {
  const candidates = [
    packageRelativeWebClient(),
    path.resolve(moduleDir, 'web-client'),
    findUpwards(moduleDir, path.join('bundle', 'web-client')),
    findUpwards(moduleDir, path.join('packages', 'web-client', 'src')),
    path.resolve(cwd, 'packages', 'web-client', 'src'),
  ];
  return candidates.filter((c): c is string => c !== null);
}

/** Resolves the directory holding the web client's `index.html`. */
export function resolveWebClientRoot(
  candidates: readonly string[] = webClientCandidates(),
): string {
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  throw new Error(
    `Could not find web client files in any of the attempted paths:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

export function createStaticAssetsHandler(root: string): RequestHandler {
  return express.static(root);
}

/** `GET /api/health` — liveness probe with the connected client count. */
export function createHealthRouter(getClientCount: () => number): Router {
  const router = Router();
  router.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', clients: getClientCount() });
  });
  return router;
}
