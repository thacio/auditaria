/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lockSync } from 'proper-lockfile';
import {
  LEASE_HEARTBEAT_MS,
  acquireLease,
  leaseStalenessMs,
  readLease,
  type AcquiredLease,
  type Lease,
} from './leaseFile.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const tempPrefix = path.join(os.tmpdir(), 'wf-lease-test-');
const leases: AcquiredLease[] = [];
const mutexes = new Set<() => void>();
let directory: string;
let file: string;

beforeEach(() => {
  directory = fs.mkdtempSync(tempPrefix);
  file = path.join(directory, 'lease.json');
  vi.stubEnv('AUDITARIA_WORKFLOW_LEASE_STALENESS_MS', '30000');
});

afterEach(async () => {
  for (const release of mutexes) release();
  mutexes.clear();
  await Promise.all(leases.splice(0).map((lease) => lease.release()));
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (!path.resolve(directory).startsWith(path.resolve(tempPrefix))) {
    throw new Error('Unexpected lease test directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function claim(taskId: string): AcquiredLease {
  const result = acquireLease(file, taskId);
  if (!result.ok) throw new Error(`Lease claim failed: ${taskId}`);
  leases.push(result.lease);
  return result.lease;
}

function holdMutex(): () => void {
  const unlock = lockSync(file, {
    realpath: false,
    lockfilePath: `${file}.mutex`,
    stale: 30_000,
  });
  const release = () => {
    if (mutexes.delete(release)) unlock();
  };
  mutexes.add(release);
  return release;
}

function previousOwner(): Lease {
  return {
    pid: process.pid + 10_000,
    taskId: 'previous-owner',
    startedAtMs: Date.now() - 120_000,
    heartbeatAtMs: Date.now() - 60_000,
    ownerToken: 'previous-token',
  };
}

describe('workflow lease ownership', () => {
  it('allows only one owner, even when its live process has an expired heartbeat', async () => {
    const first = claim('first');
    expect(acquireLease(file, 'second')).toMatchObject({
      ok: false,
      existing: { taskId: 'first' },
    });

    const owner = readLease(file);
    if (!owner) throw new Error('Missing owner');
    fs.writeFileSync(
      file,
      JSON.stringify({ ...owner, heartbeatAtMs: Date.now() - 120_000 }),
    );
    expect(acquireLease(file, 'third')).toMatchObject({
      ok: false,
      existing: { taskId: 'first' },
    });

    await first.release();
    claim('successor');
    expect(readLease(file)?.taskId).toBe('successor');
  });

  it.each(['', '{"pid":'])(
    'does not replace fresh incomplete metadata %j but can recover it after expiry',
    async (contents) => {
      fs.writeFileSync(file, contents);
      expect(acquireLease(file, 'too-early').ok).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(contents);

      const expired = new Date(Date.now() - leaseStalenessMs() - 1_000);
      fs.utimesSync(file, expired, expired);
      claim('recovered');
      expect(readLease(file)?.taskId).toBe('recovered');
    },
  );

  it('recovers an expired dead process but treats EPERM as a live owner', () => {
    fs.writeFileSync(file, JSON.stringify(previousOwner()));
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('Access denied'), { code: 'EPERM' });
    });
    expect(acquireLease(file, 'blocked').ok).toBe(false);
    expect(readLease(file)?.taskId).toBe('previous-owner');

    kill.mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });
    claim('recovered');
    expect(readLease(file)?.taskId).toBe('recovered');
  });

  it('leaves successor metadata untouched by an old heartbeat and repeated release', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const original = claim('original');
    const successor = {
      ...readLease(file),
      pid: process.pid,
      taskId: 'successor',
      ownerToken: 'successor-token',
    };
    const bytes = JSON.stringify(successor);
    fs.writeFileSync(file, bytes);

    vi.advanceTimersByTime(LEASE_HEARTBEAT_MS);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    await original.release();
    await original.release();
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('fails closed while the metadata mutex is held', () => {
    const unlock = holdMutex();
    expect(acquireLease(file, 'contender').ok).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    unlock();
    claim('winner');
    expect(readLease(file)?.taskId).toBe('winner');
  });

  it('retries release after contention and preserves a replacement owner', async () => {
    const original = claim('original');
    const unlock = holdMutex();
    const releasing = original.release();

    // A metadata operation that already holds the mutex publishes a successor
    // before the old release gets to inspect ownership.
    const successor = {
      ...readLease(file),
      taskId: 'replacement',
      ownerToken: 'replacement-token',
    };
    const bytes = JSON.stringify(successor);
    fs.writeFileSync(file, bytes);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    unlock();

    await releasing;
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('finishes a contended release before allowing the next owner', async () => {
    const original = claim('original');
    const unlock = holdMutex();
    const releasing = original.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(acquireLease(file, 'premature').ok).toBe(false);
    unlock();
    await releasing;

    expect(fs.existsSync(file)).toBe(false);
    claim('next');
    expect(readLease(file)?.taskId).toBe('next');
  });

  it('preserves old metadata and cleans temporary files when publication fails', () => {
    const bytes = JSON.stringify(previousOwner());
    fs.writeFileSync(file, bytes);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
    });
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('Publication denied'), { code: 'EACCES' });
    });

    expect(() => acquireLease(file, 'failed')).toThrow('Publication denied');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.readdirSync(directory)).toEqual(['lease.json']);
    claim('retry');
    expect(readLease(file)?.taskId).toBe('retry');
  });
});
