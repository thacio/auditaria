/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

/**
 * Multi-file sites — an Auditaria extension past Claude's single-document
 * artifact. A folder with an `index.html` publishes as ONE artifact whose
 * files are served under the artifact's origin at their relative paths
 * (`/about.html`, `/css/site.css`, `/img/logo.png`), so relative links
 * resolve and every HTML page gets the runtime and the theme. Versions keep
 * whole snapshots. Nothing here touches the single-page path, which stays
 * exactly Claude's and remains the preferred shape.
 */

import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { SiteFile } from './types.js';

export const MAX_SITE_FILES = 2000;
export const MAX_SITE_BYTES = 16 * 1024 * 1024;
export const SITE_ENTRY = 'index.html';
const MAX_SITE_PATH_CHARS = 512;

/** Top-level names the artifact origin keeps for itself. */
export const RESERVED_SITE_NAMES: ReadonlySet<string> = new Set([
  'v',
  's',
  '__assets',
  '__rt',
  '__downloads',
  '__runtime',
]);

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

export type SiteErrorCode =
  | 'not_a_directory'
  | 'no_entry'
  | 'too_many_files'
  | 'too_large'
  | 'reserved_path'
  | 'invalid_path';

export class SiteError extends Error {
  constructor(
    readonly code: SiteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SiteError';
  }
}

export interface CollectedSite {
  readonly files: readonly SiteFile[];
  readonly bytes: number;
}

export function isSiteHtml(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

/** A stored site path: forward slashes, no empty/dot segments, no controls. */
export function validateSitePath(relPath: string): void {
  const segments = relPath.split('/');
  if (
    relPath.length === 0 ||
    relPath.length > MAX_SITE_PATH_CHARS ||
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\\]/.test(relPath) ||
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw new SiteError(
      'invalid_path',
      `"${relPath}" is not a valid site path.`,
    );
  }
}

/**
 * Walks a folder into the file list a site version stores: regular files
 * only (symlinks are never followed, dotfiles, node_modules and .git are
 * skipped), an `index.html` at the root, no reserved top-level names, and
 * the same 16MB ceiling as a single page, across the whole site.
 */
export async function collectSite(rootDir: string): Promise<CollectedSite> {
  const root = path.resolve(rootDir);
  const stat = await fsp.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new SiteError('not_a_directory', `${root} is not a directory.`);
  }
  const files: SiteFile[] = [];
  let bytes = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      if (rel === '' && RESERVED_SITE_NAMES.has(entry.name)) {
        throw new SiteError(
          'reserved_path',
          `"${entry.name}" at the site root is reserved by the artifact origin (${[...RESERVED_SITE_NAMES].join(', ')}); rename it.`,
        );
      }
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      validateSitePath(relPath);
      const size = (await fsp.stat(abs)).size;
      files.push({ path: relPath, source: abs, bytes: size });
      bytes += size;
      if (files.length > MAX_SITE_FILES) {
        throw new SiteError(
          'too_many_files',
          `A site may hold at most ${MAX_SITE_FILES} files.`,
        );
      }
      if (bytes > MAX_SITE_BYTES) {
        throw new SiteError(
          'too_large',
          `A site must be 16MB or smaller in total (this one passed ${bytes} bytes).`,
        );
      }
    }
  };
  await walk(root, '');
  if (!files.some((f) => f.path === SITE_ENTRY)) {
    throw new SiteError(
      'no_entry',
      `A site needs an ${SITE_ENTRY} at its root (${root} has none).`,
    );
  }
  return { files, bytes };
}

/**
 * Resolves a request path inside a stored snapshot, or null: decoded once,
 * no dot segments or dotfiles, never outside the snapshot, never through a
 * symlink; a directory resolves to its `index.html`.
 */
export async function resolveSiteFile(
  siteDir: string,
  requestPath: string,
): Promise<{ file: string; html: boolean } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  // A trailing slash asks for a directory: a file under that name is a miss.
  const wantsDirectory = /\/$/.test(decoded);
  const trimmed = decoded.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = trimmed === '' ? [] : trimmed.split('/');
  for (const segment of segments) {
    if (
      segment === '' ||
      segment.startsWith('.') ||
      segment.includes('\\') ||
      segment.includes(':') ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/.test(segment)
    ) {
      return null;
    }
  }
  const root = path.resolve(siteDir);
  let target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  let stat = await fsp.lstat(target).catch(() => null);
  if (wantsDirectory && stat?.isFile()) return null;
  if (stat?.isDirectory()) {
    target = path.join(target, SITE_ENTRY);
    stat = await fsp.lstat(target).catch(() => null);
  }
  if (!stat?.isFile()) return null;
  return { file: target, html: isSiteHtml(target) };
}

/** A snapshot's files as sorted relative paths (forward slashes). */
export async function listSiteFiles(siteDir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  await walk(path.resolve(siteDir), '');
  return out.sort();
}

/**
 * Site pages are usually complete documents, while the host wraps
 * fragments: drop the document shell and keep everything inside it. Head
 * content survives — `<title>`, `<link>`, `<style>` and `<meta>` all keep
 * working from the body.
 */
export function stripDocumentShell(html: string): string {
  return html
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .trim();
}

/** The snapshot directory of site version `n` under an artifact's versions dir. */
export function siteDirOf(versionsDir: string, n: number): string {
  return path.join(versionsDir, String(n));
}
