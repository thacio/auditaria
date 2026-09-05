/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AssetStore, MAX_ASSET_BYTES, isAssetId } from './assets.js';

describe('AssetStore', () => {
  let dir: string;
  let store: AssetStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifact-assets-'));
    store = new AssetStore(path.join(dir, 'assets'));
    await store.load();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('adds allowlisted files as write-once copies and lists them newest first', async () => {
    const png = path.join(dir, 'chart.png');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const csv = path.join(dir, 'rows.csv');
    await writeFile(csv, 'a,b\n1,2\n', 'utf-8');

    const first = await store.add(png);
    expect(isAssetId(first.id)).toBe(true);
    expect(first).toMatchObject({
      name: 'chart.png',
      type: 'image/png',
      size: 4,
      ext: 'png',
    });
    expect((await stat(store.fileOf(first))).size).toBe(4);
    await new Promise((r) => setTimeout(r, 5));
    const second = await store.add(csv, 'renamed.csv');
    expect(second).toMatchObject({
      name: 'renamed.csv',
      type: 'text/csv; charset=utf-8',
    });

    const page = store.list();
    expect(page.assets.map((a) => a.id)).toEqual([second.id, first.id]);
    expect(page.next).toBeNull();
    const paged = store.list({ limit: 1 });
    expect(paged.assets).toHaveLength(1);
    expect(paged.next).toBe(second.id);
    expect(store.list({ after: paged.next!, limit: 1 }).assets[0].id).toBe(
      first.id,
    );
    expect(store.totalBytes).toBe(4 + 8);

    const reloaded = new AssetStore(store.dir);
    await reloaded.load();
    expect(reloaded.get(first.id)?.name).toBe('chart.png');
    expect(await readFile(reloaded.fileOf(second), 'utf-8')).toBe('a,b\n1,2\n');
  });

  it('rejects unknown types, missing files and oversize files', async () => {
    const exe = path.join(dir, 'tool.exe');
    await writeFile(exe, 'MZ');
    await expect(store.add(exe)).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    await expect(
      store.add(path.join(dir, 'missing.png')),
    ).rejects.toMatchObject({ code: 'not_found' });
    const big = path.join(dir, 'big.txt');
    await writeFile(big, Buffer.alloc(MAX_ASSET_BYTES + 1));
    await expect(store.add(big)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('removes an asset and its bytes permanently', async () => {
    const txt = path.join(dir, 'note.txt');
    await writeFile(txt, 'hi', 'utf-8');
    const asset = await store.add(txt);
    const file = store.fileOf(asset);
    expect(await store.remove(asset.id)).toEqual(asset);
    expect(store.get(asset.id)).toBeNull();
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.remove(asset.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    const reloaded = new AssetStore(store.dir);
    await reloaded.load();
    expect(reloaded.get(asset.id)).toBeNull();
  });
});
