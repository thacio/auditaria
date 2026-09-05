/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DOCUMENTS, normalizeQuerySpec } from './dbEngine.js';
import { ArtifactDb } from './dbStore.js';

describe('ArtifactDb', () => {
  let dir: string;
  let db: ArtifactDb;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifact-db-'));
    db = new ArtifactDb(path.join(dir, 'db.jsonl'));
    await db.load();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('sets, versions, updates, deletes, and emits changes', async () => {
    const changes: string[][] = [];
    db.on('change', (paths) => changes.push(paths));

    const first = await db.set('tasks/t1', { title: 'A', meta: { x: 1 } });
    expect(first).toMatchObject({ path: 'tasks/t1', version: 1 });
    expect(db.get('tasks/t1')?.data).toEqual({ title: 'A', meta: { x: 1 } });

    const updated = await db.update('tasks/t1', { meta: { y: 2 }, done: true });
    expect(updated.version).toBe(2);
    expect(updated.data).toEqual({
      title: 'A',
      meta: { x: 1, y: 2 },
      done: true,
    });
    await expect(db.update('tasks/nope', { a: 1 })).rejects.toMatchObject({
      code: 'invalid_argument',
    });

    await db.set('tasks/t1/sub/s1', { nested: true });
    expect(await db.delete('tasks/t1')).toBe(true);
    expect(await db.delete('tasks/t1')).toBe(false);
    expect(db.get('tasks/t1')).toBeNull();
    expect(db.get('tasks/t1/sub/s1')).not.toBeNull(); // nested survive
    expect(changes).toEqual([
      ['tasks/t1'],
      ['tasks/t1'],
      ['tasks/t1/sub/s1'],
      ['tasks/t1'],
    ]);
    expect(() => db.get('tasks')).toThrow(TypeError);
  });

  it('lists direct children only and answers queries', async () => {
    await db.set('tasks/a', { n: 2 });
    await db.set('tasks/b', { n: 1 });
    await db.set('tasks/a/sub/x', { n: 9 });
    await db.set('other/c', { n: 0 });
    expect(db.list('tasks').map((d) => d.path)).toEqual(['tasks/a', 'tasks/b']);
    const spec = normalizeQuerySpec({
      path: 'tasks',
      where: [{ f: 'n', op: '>=', v: 1 }],
      orderBy: { f: 'n', dir: 'desc' },
    });
    expect(db.query(spec).map((d) => d.path)).toEqual(['tasks/a', 'tasks/b']);
  });

  it('replays the journal on reload and tolerates a torn last line', async () => {
    await db.set('tasks/a', { n: 1 });
    await db.set('tasks/a', { n: 2 });
    await db.set('tasks/b', { n: 3 });
    await db.delete('tasks/b');
    await appendFile(db.file, '{"op":"set","path":"tasks/torn"');

    const reloaded = new ArtifactDb(db.file);
    await reloaded.load();
    expect(reloaded.size).toBe(1);
    expect(reloaded.get('tasks/a')).toMatchObject({
      version: 2,
      data: { n: 2 },
    });
    expect(reloaded.get('tasks/b')).toBeNull();
  });

  it('applies a batch all-or-nothing as one journal line', async () => {
    await db.set('tasks/a', { n: 1 });
    await expect(
      db.batch([
        { op: 'set', path: 'tasks/b', data: { n: 2 } },
        { op: 'update', path: 'tasks/missing', data: { n: 3 } },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(db.get('tasks/b')).toBeNull(); // nothing landed

    await expect(
      db.batch([
        { op: 'set', path: 'tasks/b', data: { n: 2 } },
        { op: 'set', path: 'tasks/b', data: { n: 3 } },
      ]),
    ).rejects.toThrow(/once/);

    const applied = await db.batch([
      { op: 'set', path: 'tasks/b', data: { n: 2 } },
      { op: 'update', path: 'tasks/a', data: { n: 10 } },
      { op: 'delete', path: 'tasks/never' },
    ]);
    expect(applied.map((d) => d.path)).toEqual(['tasks/b', 'tasks/a']);
    expect(db.get('tasks/a')).toMatchObject({ version: 2, data: { n: 10 } });
    const lines = (await readFile(db.file, 'utf-8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1])).toMatchObject({ op: 'batch' });

    const reloaded = new ArtifactDb(db.file);
    await reloaded.load();
    expect(reloaded.get('tasks/b')?.data).toEqual({ n: 2 });
  });

  it('enforces the document quota for creates only', async () => {
    const writes = Array.from({ length: 50 }, (_, i) => ({
      op: 'set' as const,
      path: `bulk/d${i}`,
      data: { i },
    }));
    for (let round = 0; round < MAX_DOCUMENTS / 50; round++) {
      await db.batch(writes.map((w) => ({ ...w, path: `${w.path}-${round}` })));
    }
    expect(db.size).toBe(MAX_DOCUMENTS);
    await expect(db.set('bulk/one-more', { x: 1 })).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await expect(db.set('bulk/d0-0', { x: 1 })).resolves.toMatchObject({
      version: 2,
    });
  }, 60_000);

  it('compacts a long journal into one line per document', async () => {
    for (let i = 0; i < 1100; i++) await db.set('counter/c', { i });
    const before = (await readFile(db.file, 'utf-8')).trim().split('\n').length;
    expect(before).toBe(1100);
    const reloaded = new ArtifactDb(db.file);
    await reloaded.load();
    const after = (await readFile(db.file, 'utf-8')).trim().split('\n').length;
    expect(after).toBe(1);
    expect(reloaded.get('counter/c')).toMatchObject({
      version: 1100,
      data: { i: 1099 },
    });
  }, 60_000);

  it('grants, refuses, renews and expires leases', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
      const granted = await db.acquire('locks/editor', {
        holder: 'tab-1',
        ttlMs: 5_000,
        data: { by: 'tab-1' },
      });
      expect(granted).toMatchObject({
        acquired: true,
        version: 1,
        holder: 'tab-1',
      });
      expect(granted.expiresAt).toBe('2026-09-04T12:00:05.000Z');
      expect(db.get('locks/editor')?.data).toEqual({ by: 'tab-1' });

      const busy = await db.acquire('locks/editor', { holder: 'tab-2' });
      expect(busy).toEqual({
        acquired: false,
        expiresAt: '2026-09-04T12:00:05.000Z',
      });

      const renewed = await db.acquire('locks/editor', {
        holder: 'tab-1',
        ttlMs: 10,
      });
      expect(renewed).toMatchObject({ acquired: true, version: 2 });
      expect(renewed.expiresAt).toBe('2026-09-04T12:00:01.000Z'); // clamped to 1 s

      vi.setSystemTime(new Date('2026-09-04T12:00:02Z'));
      const taken = await db.acquire('locks/editor', { holder: 'tab-2' });
      expect(taken).toMatchObject({
        acquired: true,
        holder: 'tab-2',
        version: 3,
      });
      await expect(
        db.acquire('locks/editor', { holder: '' }),
      ).rejects.toMatchObject({ code: 'invalid_argument' });
    } finally {
      vi.useRealTimers();
    }
  });
});
