/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { appendJsonl, isCode, readJsonl } from './journal.js';

/**
 * Files attached to an artifact (images, video, PDFs, fonts, text), the
 * agent's side of Claude's `upload_asset`/`list_assets`/`read_asset`/
 * `delete_asset`. Bytes live as write-once files under `assets/`; the
 * manifest is an append-only journal beside them. Served by the artifact
 * origin at `/__assets/<id>`.
 */

export interface AssetRecord {
  /** 32 lower-case hex characters. */
  readonly id: string;
  /** Original file name (basename), for people. */
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly ext: string;
  readonly at: string;
}

export type AssetEvent =
  | { readonly op: 'add'; readonly asset: AssetRecord }
  | { readonly op: 'remove'; readonly id: string; readonly at: string };

/** Types an artifact may carry, keyed by extension. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

export const MAX_ASSET_BYTES = 16 * 1024 * 1024;
export const MAX_ASSETS_TOTAL_BYTES = 256 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{32}$/;

export class AssetError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid_argument' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}

export function isAssetId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

function extensionOf(fileName: string): string {
  return path.extname(fileName).slice(1).toLowerCase();
}

export class AssetStore {
  private readonly assets = new Map<string, AssetRecord>();
  private loaded: Promise<void> | null = null;

  constructor(
    /** `<artifact>/assets` — files and the manifest live here. */
    readonly dir: string,
  ) {}

  get manifestFile(): string {
    return path.join(this.dir, 'assets.jsonl');
  }

  async load(): Promise<void> {
    this.loaded ??= (async () => {
      for (const event of await readJsonl<AssetEvent>(this.manifestFile)) {
        if (event.op === 'add') this.assets.set(event.asset.id, event.asset);
        else this.assets.delete(event.id);
      }
    })();
    return this.loaded;
  }

  get totalBytes(): number {
    let total = 0;
    for (const asset of this.assets.values()) total += asset.size;
    return total;
  }

  /** Path of an asset's bytes on disk. */
  fileOf(asset: AssetRecord): string {
    return path.join(this.dir, `${asset.id}.${asset.ext}`);
  }

  get(id: string): AssetRecord | null {
    return this.assets.get(id) ?? null;
  }

  /** Newest first, paged by an opaque `after` cursor (the last id seen). */
  list(options: { after?: string; limit?: number } = {}): {
    assets: AssetRecord[];
    next: string | null;
  } {
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));
    const all = Array.from(this.assets.values()).sort((a, b) =>
      b.at.localeCompare(a.at),
    );
    let start = 0;
    if (options.after) {
      const index = all.findIndex((a) => a.id === options.after);
      if (index >= 0) start = index + 1;
    }
    const page = all.slice(start, start + limit);
    const next =
      start + limit < all.length && page.length > 0
        ? page[page.length - 1].id
        : null;
    return { assets: page, next };
  }

  /** Copies a local file in as a new asset (write-once). */
  async add(sourcePath: string, displayName?: string): Promise<AssetRecord> {
    await this.load();
    const name = path.basename(displayName ?? sourcePath);
    const ext = extensionOf(name);
    const type = ASSET_TYPES[ext];
    if (!type) {
      throw new AssetError(
        'invalid_argument',
        `"${name}" is not an image, video, audio, PDF, font or text file (${Object.keys(ASSET_TYPES).join(', ')})`,
      );
    }
    let size: number;
    try {
      size = (await fsp.stat(sourcePath)).size;
    } catch (error) {
      if (isCode(error, 'ENOENT')) {
        throw new AssetError('not_found', `no file at ${sourcePath}`);
      }
      throw error;
    }
    if (size > MAX_ASSET_BYTES) {
      throw new AssetError(
        'too_large',
        `"${name}" is ${size} bytes; an asset may be at most ${MAX_ASSET_BYTES} bytes`,
      );
    }
    if (this.totalBytes + size > MAX_ASSETS_TOTAL_BYTES) {
      throw new AssetError(
        'too_large',
        `this artifact's assets would exceed ${MAX_ASSETS_TOTAL_BYTES} bytes in total`,
      );
    }
    const asset: AssetRecord = {
      id: randomBytes(16).toString('hex'),
      name,
      type,
      size,
      ext,
      at: new Date().toISOString(),
    };
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.copyFile(
      sourcePath,
      this.fileOf(asset),
      fsConstants.COPYFILE_EXCL,
    );
    await appendJsonl(this.manifestFile, {
      op: 'add',
      asset,
    } satisfies AssetEvent);
    this.assets.set(asset.id, asset);
    return asset;
  }

  /** Permanently removes an asset and its bytes. */
  async remove(id: string): Promise<AssetRecord> {
    await this.load();
    const asset = this.assets.get(id);
    if (!asset) throw new AssetError('not_found', `no asset ${id}`);
    await appendJsonl(this.manifestFile, {
      op: 'remove',
      id,
      at: new Date().toISOString(),
    } satisfies AssetEvent);
    this.assets.delete(id);
    await fsp.rm(this.fileOf(asset), { force: true });
    return asset;
  }
}
