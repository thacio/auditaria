/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// eslint-plugin-import cannot parse this generated WASM loader; tsc validates the API.
// eslint-disable-next-line import/namespace
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { amcheck } from '@electric-sql/pglite/contrib/amcheck';
import { embeddedPGliteOptions } from './pglite-assets.js';

/** The storage layer uses only this stable subset across PostgreSQL major versions. */
export interface SearchDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
  transaction<T>(
    callback: (tx: Pick<SearchDatabase, 'query' | 'exec'>) => Promise<T>,
  ): Promise<T>;
}

/** PostgreSQL data directories cannot be opened by another major version. */
export function postgresMajor(dataDir?: string): number | undefined {
  if (!dataDir) return undefined;
  const versionFile = join(dataDir, 'PG_VERSION');
  if (!existsSync(versionFile)) return undefined;
  const major = Number(readFileSync(versionFile, 'utf8').trim());
  if (major !== 17 && major !== 18) {
    throw new Error(
      `Unsupported knowledge base PostgreSQL version: ${major}. Keep the original database and rebuild into a new path.`,
    );
  }
  return major;
}

export async function openSearchDatabase(
  dataDir?: string,
): Promise<SearchDatabase> {
  let db: SearchDatabase;
  if (postgresMajor(dataDir) === 17) {
    // Compatibility runtime, loaded only for existing PG17 indexes. No implicit migration.
    const [
      { PGlite: LegacyPGlite },
      { vector: legacyVector },
      { amcheck: legacyAmcheck },
    ] = await Promise.all([
      import('@electric-sql/pglite-pg17'),
      import('@electric-sql/pglite-pg17/vector'),
      import('@electric-sql/pglite-pg17/contrib/amcheck'),
    ]);
    db = await LegacyPGlite.create({
      dataDir,
      extensions: { vector: legacyVector, amcheck: legacyAmcheck },
      ...(await embeddedPGliteOptions(17)),
    });
  } else {
    db = await PGlite.create({
      dataDir,
      extensions: { vector, amcheck },
      ...(await embeddedPGliteOptions(18)),
    });
  }
  // Timestamps supplied by the application are ISO UTC. PostgreSQL 18 otherwise
  // inherits the host zone for CURRENT_TIMESTAMP, shifting update times.
  try {
    await db.exec("SET TIME ZONE 'UTC'");
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
