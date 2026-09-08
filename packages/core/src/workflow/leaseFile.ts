/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: A run's liveness lease — the cross-process guard behind
// "Workflow <id> is still running ... Stop it first" (research 11 §7.5,
// refute-resume.md): acquired ATOMICALLY (`wx` create) before a launch or
// resume is accepted, refreshed every 10 s, judged stale after 30 s.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errnoCode, isRecord, numberField, stringField } from './guards.js';

export interface Lease {
  pid: number;
  taskId: string;
  startedAtMs: number;
  heartbeatAtMs: number;
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
    if (pid !== undefined && heartbeatAtMs !== undefined) {
      return {
        pid,
        taskId: stringField(parsed, 'taskId') ?? '',
        startedAtMs: numberField(parsed, 'startedAtMs') ?? 0,
        heartbeatAtMs,
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

/**
 * A lease is live only when its heartbeat is fresh AND its process exists.
 * (The 30 s staleness window bounds the PID-reuse exposure; a start-time
 * cross-check can be layered on later without changing callers.)
 */
export function isLeaseLive(
  lease: Lease | undefined,
  now = Date.now(),
): boolean {
  if (!lease) return false;
  if (now - lease.heartbeatAtMs > leaseStalenessMs()) return false;
  return processExists(lease.pid);
}

export interface AcquiredLease {
  release: () => void;
}

export type AcquireResult =
  | { ok: true; lease: AcquiredLease }
  | { ok: false; existing: Lease };

/**
 * Atomically claim `leasePath`. On EEXIST the existing lease is judged: a
 * dead one is replaced (one retry), a live one is reported to the caller.
 */
export function acquireLease(leasePath: string, taskId: string): AcquireResult {
  fs.mkdirSync(path.dirname(leasePath), { recursive: true });
  const write = (): boolean => {
    const lease: Lease = {
      pid: process.pid,
      taskId,
      startedAtMs: Date.now(),
      heartbeatAtMs: Date.now(),
    };
    try {
      fs.writeFileSync(leasePath, JSON.stringify(lease), { flag: 'wx' });
      return true;
    } catch (e) {
      if (errnoCode(e) === 'EEXIST') return false;
      throw e;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (write()) return { ok: true, lease: startHeartbeat(leasePath, taskId) };
    const existing = readLease(leasePath);
    if (existing && isLeaseLive(existing)) return { ok: false, existing };
    try {
      fs.unlinkSync(leasePath);
    } catch {
      /* raced with another acquirer; the retry decides */
    }
  }
  const existing = readLease(leasePath);
  return {
    ok: false,
    existing: existing ?? {
      pid: -1,
      taskId: '',
      startedAtMs: 0,
      heartbeatAtMs: Date.now(),
    },
  };
}

function startHeartbeat(leasePath: string, taskId: string): AcquiredLease {
  const startedAtMs = Date.now();
  const beat = () => {
    const lease: Lease = {
      pid: process.pid,
      taskId,
      startedAtMs,
      heartbeatAtMs: Date.now(),
    };
    try {
      fs.writeFileSync(leasePath, JSON.stringify(lease));
    } catch {
      /* the run keeps going; a missing heartbeat only makes the lease stale */
    }
  };
  const timer = setInterval(beat, LEASE_HEARTBEAT_MS);
  timer.unref();
  return {
    release: () => {
      clearInterval(timer);
      try {
        fs.unlinkSync(leasePath);
      } catch {
        /* already gone */
      }
    },
  };
}
