/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Content fingerprint shared by discovery and indexing, with bounded memory. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
