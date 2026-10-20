/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DiscoveredFile } from '../types.js';
import type { SyncChanges } from '../indexing/types.js';

/** Compare a complete discovery snapshot with the last indexed content. */
export function detectChanges(
  files: DiscoveredFile[],
  storedHashes: Map<string, string>,
  force = false,
): SyncChanges {
  const deleted = new Set(storedHashes.keys());
  const changes: SyncChanges = { added: [], modified: [], deleted: [] };
  for (const file of files) {
    if (!storedHashes.has(file.relativePath)) {
      changes.added.push(file.relativePath);
    } else if (force || storedHashes.get(file.relativePath) !== file.hash) {
      changes.modified.push(file.relativePath);
    }
    deleted.delete(file.relativePath);
  }
  changes.deleted = [...deleted];
  return changes;
}
