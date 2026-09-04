/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { ArtifactId } from './types.js';

/** Artifact ids are 16 lower-case hex characters. */
const ID_RE = /^[0-9a-f]{16}$/;

/** Host label prefix: `art-<id>.localhost`. */
export const ARTIFACT_HOST_PREFIX = 'art-';

export function newArtifactId(): ArtifactId {
  return randomBytes(8).toString('hex');
}

export function isArtifactId(value: unknown): value is ArtifactId {
  return typeof value === 'string' && ID_RE.test(value);
}

/** Directory name of the per-project store, under the config dir. */
export const ARTIFACTS_DIR_NAME = 'artifacts';
/** Soft-deleted artifacts live here until the retention sweep. */
export const TRASH_DIR_NAME = '.trash';

/** File layout inside `<store>/<id>/`. */
export const ARTIFACT_FILES = {
  journal: 'artifact.jsonl',
  versionsDir: 'versions',
  db: 'db.jsonl',
  comments: 'comments.jsonl',
  assetsDir: 'assets',
} as const;

export interface ArtifactPaths {
  readonly root: string;
  readonly journal: string;
  readonly versionsDir: string;
  readonly db: string;
  readonly comments: string;
  readonly assetsDir: string;
}

export function artifactPaths(
  storeRoot: string,
  id: ArtifactId,
): ArtifactPaths {
  if (!isArtifactId(id)) {
    throw new Error(`Invalid artifact id: ${String(id)}`);
  }
  const root = path.join(storeRoot, id);
  return {
    root,
    journal: path.join(root, ARTIFACT_FILES.journal),
    versionsDir: path.join(root, ARTIFACT_FILES.versionsDir),
    db: path.join(root, ARTIFACT_FILES.db),
    comments: path.join(root, ARTIFACT_FILES.comments),
    assetsDir: path.join(root, ARTIFACT_FILES.assetsDir),
  };
}

/** Write-once body file of version `n`. */
export function versionFile(
  paths: ArtifactPaths,
  n: number,
  format: 'html' | 'markdown',
): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid version number: ${String(n)}`);
  }
  return path.join(
    paths.versionsDir,
    `${n}.${format === 'html' ? 'html' : 'md'}`,
  );
}

/**
 * Host name of an artifact origin (without port). Browsers resolve
 * `*.localhost` to loopback with no DNS, so every artifact gets its own
 * origin — and its own storage — for free.
 */
export function artifactHostname(id: ArtifactId): string {
  return `${ARTIFACT_HOST_PREFIX}${id}.localhost`;
}

/** The artifact id encoded in a host name, or null. */
export function artifactIdFromHostname(hostname: string): ArtifactId | null {
  const lower = hostname.toLowerCase();
  if (
    !lower.startsWith(ARTIFACT_HOST_PREFIX) ||
    !lower.endsWith('.localhost')
  ) {
    return null;
  }
  const id = lower.slice(ARTIFACT_HOST_PREFIX.length, -'.localhost'.length);
  return isArtifactId(id) ? id : null;
}

export function artifactUrl(id: ArtifactId, port: number): string {
  return `http://${artifactHostname(id)}:${port}/`;
}

/**
 * Accepts the forms an agent may use to name an artifact: a bare id, an
 * artifact URL (any port), or `artifact:<id>`. Returns null otherwise.
 */
export function parseArtifactReference(value: string): ArtifactId | null {
  const text = value.trim();
  if (ID_RE.test(text)) return text;
  if (text.toLowerCase().startsWith('artifact:')) {
    const rest = text.slice('artifact:'.length);
    return ID_RE.test(rest) ? rest : null;
  }
  try {
    const url = new URL(text);
    return artifactIdFromHostname(url.hostname);
  } catch {
    return null;
  }
}
