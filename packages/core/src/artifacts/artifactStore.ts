/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { EventEmitter } from 'node:events';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {
  ARTIFACTS_DIR_NAME,
  TRASH_DIR_NAME,
  artifactPaths,
  isArtifactId,
  newArtifactId,
  versionFile,
  type ArtifactPaths,
} from './artifactPaths.js';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_LABEL_CHARS,
  MAX_RENDERED_BYTES,
  sha256Hex,
  validateFavicon,
} from './htmlShell.js';
import { isPlainObject, validateRules } from './dbEngine.js';
import { appendJsonl, isCode, readJsonl, writeOnce } from './journal.js';
import { constants as fsConstants } from 'node:fs';
import { listSiteFiles, resolveSiteFile, siteDirOf } from './site.js';
import type {
  ArtifactEvent,
  ArtifactId,
  ArtifactRecord,
  ArtifactStoreEvents,
  ArtifactSummary,
  ArtifactVersion,
  CapabilityDeclaration,
  PublishInput,
  PublishOutcome,
} from './types.js';

/** Days a soft-deleted artifact stays in the trash. */
export const TRASH_RETENTION_DAYS = 7;

/** Capability names the store accepts in a declaration. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  'artifact',
  'self',
  'db',
  'user',
  'assets',
  'downloads',
  'sample',
  'room',
  'mcp',
]);

/** Capabilities declared but not served on this host (`use()` → null). */
export const UNSERVED_CAPABILITIES: ReadonlySet<string> = new Set([
  'room',
  'mcp',
]);

export class ArtifactStoreError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_argument'
      | 'too_large'
      | 'deleted'
      | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

interface LoadedArtifact {
  record: ArtifactRecord;
  versions: ArtifactVersion[];
}

type MetaPatch = Extract<ArtifactEvent, { type: 'meta' }>['patch'];

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Validates a `capabilities` declaration: known names only, object or
 * boolean configs. Returns the names that are accepted but not served.
 */
export function validateCapabilities(declaration: CapabilityDeclaration): {
  unserved: string[];
} {
  const unserved: string[] = [];
  for (const [name, config] of Object.entries(declaration)) {
    if (!KNOWN_CAPABILITIES.has(name)) {
      throw new ArtifactStoreError(
        'invalid_argument',
        `Unknown capability "${name}". Available: ${Array.from(KNOWN_CAPABILITIES).join(', ')}.`,
      );
    }
    const type = typeof config;
    if (type !== 'object' && type !== 'boolean') {
      throw new ArtifactStoreError(
        'invalid_argument',
        `Capability "${name}" must be configured with an object (or true).`,
      );
    }
    if (name === 'db') {
      // Access rules are fixed at publish: reject a bad declaration here.
      const rules = isPlainObject(config) ? config['rules'] : undefined;
      try {
        validateRules(rules);
      } catch (error) {
        throw new ArtifactStoreError(
          'invalid_argument',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (UNSERVED_CAPABILITIES.has(name)) unserved.push(name);
  }
  return { unserved };
}

/**
 * The per-project artifact store: one directory per artifact holding an
 * append-only journal (`artifact.jsonl`) and write-once version bodies.
 * Loaded lazily into an in-memory index; every mutation appends a journal
 * line before the index changes, so a crash can lose at most the line in
 * flight. Emits events the web layer turns into broadcasts.
 */
export class ArtifactStore extends EventEmitter<ArtifactStoreEvents> {
  private readonly index = new Map<ArtifactId, LoadedArtifact>();
  private loaded: Promise<void> | null = null;

  constructor(readonly rootDir: string) {
    super();
  }

  /** `<configDir>/artifacts` for a project. */
  static rootFor(projectConfigDir: string): string {
    return path.join(projectConfigDir, ARTIFACTS_DIR_NAME);
  }

  // ---------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------

  /** Reads every artifact directory once; safe to call repeatedly. */
  async load(): Promise<void> {
    this.loaded ??= this.loadAll();
    return this.loaded;
  }

  private async loadAll(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.rootDir);
    } catch (error) {
      if (isCode(error, 'ENOENT')) return;
      throw error;
    }
    for (const entry of entries) {
      if (!isArtifactId(entry)) continue;
      const loaded = await this.loadOne(entry);
      if (loaded) this.index.set(entry, loaded);
    }
  }

  private async loadOne(id: ArtifactId): Promise<LoadedArtifact | null> {
    const events = await readJsonl<ArtifactEvent>(
      artifactPaths(this.rootDir, id).journal,
    );
    let record: ArtifactRecord | undefined;
    const versions: ArtifactVersion[] = [];
    for (const event of events) {
      if (event.type === 'created') {
        record = event.record;
        continue;
      }
      if (!record) continue;
      const current: ArtifactRecord = record;
      switch (event.type) {
        case 'version':
          versions.push(event.version);
          record = {
            ...current,
            latestVersion: Math.max(current.latestVersion, event.version.n),
            title: event.version.title,
            updatedAt: event.at,
          };
          break;
        case 'meta':
          record = { ...current, ...event.patch, updatedAt: event.at };
          break;
        case 'deleted':
          record = { ...current, deletedAt: event.at };
          break;
        case 'restored':
          record = withoutDeletedAt(current, event.at);
          break;
        default:
          break;
      }
    }
    return record ? { record, versions } : null;
  }

  // ---------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------

  async list(
    options: { includeDeleted?: boolean } = {},
  ): Promise<ArtifactSummary[]> {
    await this.load();
    const rows: ArtifactSummary[] = [];
    for (const { record } of this.index.values()) {
      if (record.deletedAt && !options.includeDeleted) continue;
      rows.push(toSummary(record));
    }
    // Newest activity first, pinned on top — the gallery order.
    rows.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return rows;
  }

  async get(id: ArtifactId): Promise<ArtifactRecord | null> {
    await this.load();
    return this.index.get(id)?.record ?? null;
  }

  /** Throws `not_found` (unknown) or `deleted` (in the trash). */
  async require(id: ArtifactId): Promise<ArtifactRecord> {
    const record = await this.get(id);
    if (!record) {
      throw new ArtifactStoreError('not_found', `No artifact with id ${id}.`);
    }
    if (record.deletedAt) {
      throw new ArtifactStoreError(
        'deleted',
        `Artifact ${id} was deleted; restore it first.`,
      );
    }
    return record;
  }

  async versions(id: ArtifactId): Promise<ArtifactVersion[]> {
    await this.load();
    return [...(this.index.get(id)?.versions ?? [])];
  }

  async version(id: ArtifactId, n: number): Promise<ArtifactVersion | null> {
    const versions = await this.versions(id);
    return versions.find((v) => v.n === n) ?? null;
  }

  /** The version viewers see: the pin when set, else the latest. */
  async servedVersion(id: ArtifactId): Promise<ArtifactVersion | null> {
    const record = await this.get(id);
    if (!record) return null;
    return this.version(id, record.pinnedVersion ?? record.latestVersion);
  }

  /** Stored body (the authored fragment or Markdown) of one version. */
  async readBody(id: ArtifactId, n: number): Promise<string> {
    const version = await this.version(id, n);
    if (!version) {
      throw new ArtifactStoreError(
        'not_found',
        `Artifact ${id} has no version ${n}.`,
      );
    }
    return fsp.readFile(
      versionFile(artifactPaths(this.rootDir, id), n, version.format),
      'utf-8',
    );
  }

  paths(id: ArtifactId): ArtifactPaths {
    return artifactPaths(this.rootDir, id);
  }

  // ---------------------------------------------------------------------
  // Multi-file sites: a version's folder snapshot, served by path.
  // ---------------------------------------------------------------------

  /** The snapshot directory of a site version, or null for a page. */
  async siteDir(id: ArtifactId, n: number): Promise<string | null> {
    const version = await this.version(id, n);
    return version?.site
      ? siteDirOf(artifactPaths(this.rootDir, id).versionsDir, n)
      : null;
  }

  /** A file inside a site version for a request path, or null. */
  async siteFile(
    id: ArtifactId,
    n: number,
    requestPath: string,
  ): Promise<{ file: string; html: boolean } | null> {
    const dir = await this.siteDir(id, n);
    return dir ? resolveSiteFile(dir, requestPath) : null;
  }

  /** A site version's files as sorted relative paths (empty for a page). */
  async siteFiles(id: ArtifactId, n: number): Promise<string[]> {
    const dir = await this.siteDir(id, n);
    return dir ? listSiteFiles(dir) : [];
  }

  // ---------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------

  /**
   * Creates an artifact (when `id` is undefined) or mints the next version
   * of an existing one. `expectedBase` implements compare-and-set: when the
   * latest version differs, the publish is refused with `conflict` so the
   * caller can merge onto the newer content.
   */
  async publish(
    id: ArtifactId | undefined,
    input: PublishInput,
    expectedBase?: number,
  ): Promise<PublishOutcome> {
    await this.load();
    validatePublishInput(input);

    // A site's ceiling covers the whole folder, a page's its body.
    const bytes = input.site
      ? input.site.files.reduce((sum, f) => sum + f.bytes, 0)
      : Buffer.byteLength(input.body, 'utf-8');
    if (bytes > MAX_RENDERED_BYTES) {
      throw new ArtifactStoreError(
        'too_large',
        `The rendered ${input.site ? 'site' : 'page'} must be 16MB or smaller (this one is ${bytes} bytes).`,
      );
    }
    if (input.capabilities !== undefined) {
      validateCapabilities(input.capabilities);
    }

    const at = nowIso();
    const title = input.title?.trim() || 'Untitled';

    if (id === undefined) {
      if (!input.favicon) {
        throw new ArtifactStoreError(
          'invalid_argument',
          'favicon is required on a first publish: one or two emoji.',
        );
      }
      const newId = newArtifactId();
      const record: ArtifactRecord = {
        id: newId,
        createdAt: at,
        updatedAt: at,
        title,
        description: input.description?.trim() ?? '',
        favicon: input.favicon,
        capabilities: input.capabilities ?? {},
        latestVersion: 0,
        pinnedVersion: null,
        pinned: false,
        sampleConsent: false,
      };
      const paths = artifactPaths(this.rootDir, newId);
      await fsp.mkdir(paths.versionsDir, { recursive: true });
      await appendJsonl(paths.journal, {
        type: 'created',
        at,
        record,
      } satisfies ArtifactEvent);
      this.index.set(newId, { record, versions: [] });
      const outcome = await this.mintVersion(newId, input, title, at);
      return { ...outcome, created: true };
    }

    const existing = await this.require(id);
    if (expectedBase !== undefined && existing.latestVersion !== expectedBase) {
      throw new ArtifactStoreError(
        'conflict',
        `Artifact ${id} is at version ${existing.latestVersion}, not ${expectedBase}: someone published in between.`,
      );
    }

    const patch: { -readonly [K in keyof MetaPatch]: MetaPatch[K] } = {};
    if (input.description !== undefined) {
      patch.description = input.description.trim();
    }
    if (input.favicon !== undefined) patch.favicon = input.favicon;
    if (input.capabilities !== undefined) {
      patch.capabilities = input.capabilities;
    }
    if (Object.keys(patch).length > 0) {
      await this.applyMeta(id, patch, at);
    }
    const outcome = await this.mintVersion(id, input, title, at);
    return { ...outcome, created: false };
  }

  private async mintVersion(
    id: ArtifactId,
    input: PublishInput,
    title: string,
    at: string,
  ): Promise<Omit<PublishOutcome, 'created'>> {
    const loaded = this.index.get(id);
    if (!loaded)
      throw new ArtifactStoreError('not_found', `No artifact ${id}.`);
    const n = loaded.record.latestVersion + 1;
    const paths = artifactPaths(this.rootDir, id);
    const version: ArtifactVersion = {
      n,
      createdAt: at,
      source: input.source,
      title,
      ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      sha256: sha256Hex(input.body),
      bytes: Buffer.byteLength(input.body, 'utf-8'),
      format: input.format,
      ...(input.site
        ? {
            site: {
              files: input.site.files.length,
              bytes: input.site.files.reduce((sum, f) => sum + f.bytes, 0),
            },
          }
        : {}),
    };
    // Files first (write-once), then the journal line that makes them visible.
    if (input.site) {
      const dir = siteDirOf(paths.versionsDir, n);
      for (const file of input.site.files) {
        const dest = `${dir}/${file.path}`;
        await fsp.mkdir(dest.slice(0, dest.lastIndexOf('/')), {
          recursive: true,
        });
        await fsp.copyFile(file.source, dest, fsConstants.COPYFILE_EXCL);
      }
    }
    await writeOnce(versionFile(paths, n, input.format), input.body);
    await appendJsonl(paths.journal, {
      type: 'version',
      at,
      version,
    } satisfies ArtifactEvent);
    loaded.versions.push(version);
    loaded.record = {
      ...loaded.record,
      latestVersion: n,
      title,
      updatedAt: at,
    };
    const outcome = { record: loaded.record, version, created: false };
    this.emit('version', outcome);
    return outcome;
  }

  private async applyMeta(
    id: ArtifactId,
    patch: MetaPatch,
    at: string = nowIso(),
  ): Promise<ArtifactRecord> {
    const loaded = this.index.get(id);
    if (!loaded)
      throw new ArtifactStoreError('not_found', `No artifact ${id}.`);
    await appendJsonl(artifactPaths(this.rootDir, id).journal, {
      type: 'meta',
      at,
      patch,
    } satisfies ArtifactEvent);
    loaded.record = { ...loaded.record, ...patch, updatedAt: at };
    this.emit('meta', loaded.record);
    return loaded.record;
  }

  async rename(id: ArtifactId, title: string): Promise<ArtifactRecord> {
    await this.require(id);
    const trimmed = title.trim();
    if (!trimmed) {
      throw new ArtifactStoreError('invalid_argument', 'title is required');
    }
    return this.applyMeta(id, { title: trimmed });
  }

  async setDescription(
    id: ArtifactId,
    description: string,
  ): Promise<ArtifactRecord> {
    await this.require(id);
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new ArtifactStoreError(
        'invalid_argument',
        `description must be at most ${MAX_DESCRIPTION_CHARS} characters`,
      );
    }
    return this.applyMeta(id, { description: description.trim() });
  }

  async setPinned(id: ArtifactId, pinned: boolean): Promise<ArtifactRecord> {
    await this.require(id);
    return this.applyMeta(id, { pinned });
  }

  /** Pins the version viewers see (`null` = latest). */
  async setPinnedVersion(
    id: ArtifactId,
    n: number | null,
  ): Promise<ArtifactRecord> {
    const record = await this.require(id);
    if (n !== null && !(await this.version(id, n))) {
      throw new ArtifactStoreError(
        'not_found',
        `Artifact ${id} has no version ${n} (latest is ${record.latestVersion}).`,
      );
    }
    return this.applyMeta(id, { pinnedVersion: n });
  }

  async setSampleConsent(
    id: ArtifactId,
    consent: boolean,
  ): Promise<ArtifactRecord> {
    await this.require(id);
    return this.applyMeta(id, { sampleConsent: consent });
  }

  /** Records that a public share started/stopped (history only). */
  async noteShare(id: ArtifactId, url: string | null): Promise<void> {
    await this.require(id);
    const at = nowIso();
    await appendJsonl(
      artifactPaths(this.rootDir, id).journal,
      url
        ? ({ type: 'shared', at, url } satisfies ArtifactEvent)
        : ({ type: 'unshared', at } satisfies ArtifactEvent),
    );
  }

  /** Soft delete: the directory moves to the trash, the journal records it. */
  async delete(id: ArtifactId): Promise<void> {
    const loaded = this.index.get(id);
    if (!loaded || loaded.record.deletedAt) {
      throw new ArtifactStoreError('not_found', `No artifact with id ${id}.`);
    }
    const at = nowIso();
    await appendJsonl(artifactPaths(this.rootDir, id).journal, {
      type: 'deleted',
      at,
    } satisfies ArtifactEvent);
    loaded.record = { ...loaded.record, deletedAt: at };
    this.emit('deleted', id);
  }

  async restore(id: ArtifactId): Promise<ArtifactRecord> {
    const loaded = this.index.get(id);
    if (!loaded || !loaded.record.deletedAt) {
      throw new ArtifactStoreError(
        'not_found',
        `No deleted artifact with id ${id}.`,
      );
    }
    const at = nowIso();
    await appendJsonl(artifactPaths(this.rootDir, id).journal, {
      type: 'restored',
      at,
    } satisfies ArtifactEvent);
    loaded.record = withoutDeletedAt(loaded.record, at);
    this.emit('restored', loaded.record);
    return loaded.record;
  }

  /**
   * Permanently removes artifacts deleted more than the retention period
   * ago by moving their directory into `.trash` and deleting it. Returns
   * the ids purged. Safe to call at every startup.
   */
  async purgeExpired(now: Date = new Date()): Promise<ArtifactId[]> {
    await this.load();
    const cutoff = now.getTime() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const purged: ArtifactId[] = [];
    for (const [id, loaded] of this.index) {
      const deletedAt = loaded.record.deletedAt;
      if (!deletedAt || Date.parse(deletedAt) > cutoff) continue;
      const trashDir = path.join(this.rootDir, TRASH_DIR_NAME);
      await fsp.mkdir(trashDir, { recursive: true });
      const target = path.join(trashDir, `${id}-${Date.now().toString(36)}`);
      try {
        await fsp.rename(artifactPaths(this.rootDir, id).root, target);
        await fsp.rm(target, { recursive: true, force: true });
      } catch {
        // Locked by another process; try again next startup.
        continue;
      }
      this.index.delete(id);
      purged.push(id);
    }
    return purged;
  }
}

function withoutDeletedAt(record: ArtifactRecord, at: string): ArtifactRecord {
  const { deletedAt: _dropped, ...rest } = record;
  return { ...rest, updatedAt: at };
}

function validatePublishInput(input: PublishInput): void {
  if (typeof input.body !== 'string') {
    throw new ArtifactStoreError('invalid_argument', 'body must be a string');
  }
  if (input.favicon !== undefined) {
    const error = validateFavicon(input.favicon);
    if (error) throw new ArtifactStoreError('invalid_argument', error);
  }
  if (
    input.description !== undefined &&
    input.description.length > MAX_DESCRIPTION_CHARS
  ) {
    throw new ArtifactStoreError(
      'invalid_argument',
      `description must be at most ${MAX_DESCRIPTION_CHARS} characters`,
    );
  }
  if (input.label !== undefined && input.label.length > MAX_LABEL_CHARS) {
    throw new ArtifactStoreError(
      'invalid_argument',
      `label must be at most ${MAX_LABEL_CHARS} characters`,
    );
  }
}

export function toSummary(record: ArtifactRecord): ArtifactSummary {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    favicon: record.favicon,
    latestVersion: record.latestVersion,
    pinnedVersion: record.pinnedVersion,
    pinned: record.pinned,
    capabilities: record.capabilities,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sampleConsent: record.sampleConsent,
  };
}
