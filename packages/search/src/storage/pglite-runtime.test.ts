/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSearchDatabase, postgresMajor } from './pglite-runtime.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('PGlite runtime compatibility', () => {
  it('creates PostgreSQL 18 databases with working vector search', async () => {
    const db = await openSearchDatabase();
    try {
      expect(
        (await db.query<{ version: string }>('select version()')).rows[0]
          .version,
      ).toContain('PostgreSQL 18');
      await db.exec(
        'create extension vector; create table probes (id int, embedding vector(3));',
      );
      await db.exec(
        "insert into probes values (1, '[1,0,0]'), (2, '[0,1,0]');",
      );
      expect(
        (
          await db.query<{ id: number }>(
            "select id from probes order by embedding <=> '[1,0,0]' limit 1",
          )
        ).rows[0].id,
      ).toBe(1);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('reopens a PostgreSQL 17 index without migrating or losing its data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auditaria-pg17-'));
    directories.push(dir);
    const { PGlite } = await import('@electric-sql/pglite-pg17');
    const legacy = await PGlite.create(dir);
    await legacy.exec(
      "create table preserved (message text); insert into preserved values ('keep this index');",
    );
    await legacy.close();
    expect(postgresMajor(dir)).toBe(17);
    const reopened = await openSearchDatabase(dir);
    try {
      expect(
        (await reopened.query('select message from preserved')).rows,
      ).toEqual([{ message: 'keep this index' }]);
      expect(postgresMajor(dir)).toBe(17);
      await reopened.exec('create extension vector');
    } finally {
      await reopened.close();
    }
  }, 30_000);

  it('rejects unknown data formats before trying to initialize them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'auditaria-pg-version-'));
    directories.push(dir);
    await writeFile(join(dir, 'PG_VERSION'), '19');
    await expect(openSearchDatabase(dir)).rejects.toThrow(
      'Unsupported knowledge base PostgreSQL version',
    );
  });
});
