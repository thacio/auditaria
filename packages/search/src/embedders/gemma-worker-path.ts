/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
// Search cannot import core's environment helpers without introducing a cycle.
// eslint-disable-next-line no-restricted-imports
import { homedir } from 'node:os';

/** Resolve published Python files or extract the workers embedded by the executable builder. */
export function gemmaWorkerPath(): string {
  const embedded = (globalThis as Record<string, unknown>)
    .__SEARCH_PYTHON_ASSETS;
  if (
    embedded &&
    typeof embedded === 'object' &&
    'worker' in embedded &&
    typeof embedded.worker === 'string' &&
    'media' in embedded &&
    typeof embedded.media === 'string'
  ) {
    const hash = createHash('sha256')
      .update(embedded.worker)
      .update(embedded.media)
      .digest('hex');
    const directory = join(homedir(), '.auditaria', 'python-workers', hash);
    mkdirSync(directory, { recursive: true });
    const worker = join(directory, 'embeddinggemma.py');
    const media = join(directory, 'media_inputs.py');
    if (!existsSync(worker)) writeFileSync(worker, embedded.worker, 'utf8');
    if (!existsSync(media)) writeFileSync(media, embedded.media, 'utf8');
    return worker;
  }
  const candidates = [
    new URL('../../python/embeddinggemma.py', import.meta.url),
    new URL('../../../python/embeddinggemma.py', import.meta.url),
  ].map((url) => fileURLToPath(url));
  try {
    const packagePath = createRequire(import.meta.url).resolve(
      '@thacio/auditaria-search/package.json',
    );
    candidates.push(join(dirname(packagePath), 'python', 'embeddinggemma.py'));
  } catch {
    /* Source checkout paths above are sufficient during development. */
  }
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found)
    throw new Error(
      'EmbeddingGemma Python worker is missing from the search package',
    );
  return found;
}
