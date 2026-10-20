/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Short locks serialize lease metadata operations.
// Ownership tokens keep an old heartbeat/release from changing a new owner.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lock, lockSync } from 'proper-lockfile';
import { errnoCode, isRecord, numberField, stringField } from './guards.js';

export interface Lease {
  pid: number;
  taskId: string;
  startedAtMs: number;
  heartbeatAtMs: number;
  ownerToken?: string;
}

export const LEASE_HEARTBEAT_MS = 10_000;

export function leaseStalenessMs(): number {
  const raw = Number(process.env['AUDITARIA_WORKFLOW_LEASE_STALENESS_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

export function readLease(leasePath: string): Lease | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    if (!isRecord(parsed)) return undefined;
    const pid = numberField(parsed, 'pid');
    const heartbeatAtMs = numberField(parsed, 'heartbeatAtMs');
    if (
      pid !== undefined &&
      Number.isInteger(pid) &&
      pid > 0 &&
      heartbeatAtMs !== undefined
    ) {
      return {
        pid,
        taskId: stringField(parsed, 'taskId') ?? '',
        startedAtMs: numberField(parsed, 'startedAtMs') ?? 0,
        heartbeatAtMs,
        ownerToken: stringField(parsed, 'ownerToken'),
      };
    }
  } catch {
    /* missing or torn */
  }
  return undefined;
}

function processExists(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoCode(e) === 'EPERM';
  }
}

/** A delayed heartbeat never permits stealing work from a live process. */
export function isLeaseLive(lease: Lease | undefined): boolean {
  return lease !== undefined && processExists(lease.pid);
}

export interface AcquiredLease {
  release: () => Promise<void>;
}

export type AcquireResult =
  | { ok: true; lease: AcquiredLease }
  | { ok: false; existing: Lease };

function mutexOptions(leasePath: string) {
  return {
    realpath: false,
    lockfilePath: `${leasePath}.mutex`,
    stale: 30_000,
    retries: 0,
  };
}

function unknownOwner(): Lease {
  return { pid: -1, taskId: '', startedAtMs: 0, heartbeatAtMs: Date.now() };
}

function writeLease(leasePath: string, lease: Lease): void {
  const temporary = `${leasePath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(lease), {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, leasePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function acquireLease(leasePath: string, taskId: string): AcquireResult {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  let unlock: () => void;
  try {
    unlock = lockSync(leasePath, mutexOptions(leasePath));
  } catch (error) {
    if (errnoCode(error) === 'ELOCKED')
      return { ok: false, existing: readLease(leasePath) ?? unknownOwner() };
    throw error;
  }
  try {
    const existing = readLease(leasePath);
    if (existing && isLeaseLive(existing)) return { ok: false, existing };
    // A legacy writer may still be publishing its first record.
    if (
      !existing &&
      fs.existsSync(leasePath) &&
      Date.now() - fs.statSync(leasePath).mtimeMs < leaseStalenessMs()
    )
      return { ok: false, existing: unknownOwner() };
    const lease: Lease = {
      pid: process.pid,
      taskId,
      startedAtMs: Date.now(),
      heartbeatAtMs: Date.now(),
      ownerToken: randomUUID(),
    };
    writeLease(leasePath, lease);
    return { ok: true, lease: startHeartbeat(leasePath, lease) };
  } finally {
    unlock();
  }
}

function startHeartbeat(leasePath: string, owner: Lease): AcquiredLease {
  const owns = () => readLease(leasePath)?.ownerToken === owner.ownerToken;
  const beat = () => {
    let unlock: (() => void) | undefined;
    try {
      unlock = lockSync(leasePath, mutexOptions(leasePath));
      if (!owns()) {
        clearInterval(timer);
        return;
      }
      writeLease(leasePath, { ...owner, heartbeatAtMs: Date.now() });
    } catch {
      // A missed heartbeat cannot make a live owner reclaimable.
    } finally {
      unlock?.();
    }
  };
  const timer = setInterval(beat, LEASE_HEARTBEAT_MS);
  timer.unref();
  let releasing: Promise<void> | undefined;
  return {
    release: () => {
      clearInterval(timer);
      releasing ??= (async () => {
        const unlock = await lock(leasePath, {
          ...mutexOptions(leasePath),
          retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
        });
        try {
          if (owns()) fs.rmSync(leasePath, { force: true });
        } finally {
          await unlock();
        }
      })();
      return releasing;
    },
  };
}
