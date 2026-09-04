/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { isCode } from './journal.js';

/**
 * The local user's stable viewer identity for artifacts: what a page sees
 * as `user.id()` and what owns every artifact published from this machine.
 * Minted once, kept in the global config dir, never derived from anything
 * that could leak (no hive keys, no e-mail).
 */
export interface OwnerIdentity {
  readonly ownerId: string;
  readonly createdAt: string;
}

export const OWNER_FILE_NAME = 'artifacts-owner.json';

const ID_RE = /^u_[0-9a-f]{16}$/;

export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** Reads the owner identity, minting it on first use. */
export async function loadOwnerIdentity(
  globalConfigDir: string,
): Promise<OwnerIdentity> {
  const file = path.join(globalConfigDir, OWNER_FILE_NAME);
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf-8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'ownerId' in parsed &&
      isOwnerId(parsed.ownerId)
    ) {
      const createdAt =
        'createdAt' in parsed && typeof parsed.createdAt === 'string'
          ? parsed.createdAt
          : new Date(0).toISOString();
      return { ownerId: parsed.ownerId, createdAt };
    }
  } catch (error) {
    if (!isCode(error, 'ENOENT') && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  const identity: OwnerIdentity = {
    ownerId: `u_${randomBytes(8).toString('hex')}`,
    createdAt: new Date().toISOString(),
  };
  await fsp.mkdir(globalConfigDir, { recursive: true });
  try {
    await fsp.writeFile(file, JSON.stringify(identity, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    // A concurrent process minted it first: read theirs.
    if (isCode(error, 'EEXIST')) return loadOwnerIdentity(globalConfigDir);
    throw error;
  }
  return identity;
}
