/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonlQueueStore, SeenStore } from './HiveStore.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-store-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold fds briefly; harmless for temp dirs */
  }
});

describe('JsonlQueueStore', () => {
  it('enqueues, acks and reports pending entries in order', () => {
    const q = new JsonlQueueStore<string>(path.join(dir, 'q.jsonl'));
    q.load();
    const s1 = q.enqueue('one');
    const s2 = q.enqueue('two');
    const s3 = q.enqueue('three');
    expect(q.size).toBe(3);
    q.ack(s2);
    expect(q.size).toBe(2);
    expect(q.entries().map((e) => e.value)).toEqual(['one', 'three']);
    expect(q.peek()?.seq).toBe(s1);
    q.ack(s1);
    q.ack(s3);
    expect(q.size).toBe(0);
    q.dispose();
  });

  it('restores unacked entries across restarts (hub-died scenario)', () => {
    const file = path.join(dir, 'q.jsonl');
    const q1 = new JsonlQueueStore<{ id: string }>(file);
    q1.load();
    q1.enqueue({ id: 'a' });
    const sb = q1.enqueue({ id: 'b' });
    q1.enqueue({ id: 'c' });
    q1.ack(sb);
    q1.dispose();

    const q2 = new JsonlQueueStore<{ id: string }>(file);
    q2.load();
    expect(q2.entries().map((e) => e.value.id)).toEqual(['a', 'c']);
    // Sequence numbering continues past the restored high-water mark.
    const s4 = q2.enqueue({ id: 'd' });
    expect(s4).toBeGreaterThan(sb);
    q2.dispose();
  });

  it('ignores a torn tail line from a crash mid-append', () => {
    const file = path.join(dir, 'q.jsonl');
    const q1 = new JsonlQueueStore<string>(file);
    q1.load();
    q1.enqueue('good');
    q1.dispose();
    // Simulate a crash: a partial JSON line at the tail.
    fs.appendFileSync(file, '{"op":"enq","seq":2,"v":"tor');
    const q2 = new JsonlQueueStore<string>(file);
    q2.load();
    expect(q2.entries().map((e) => e.value)).toEqual(['good']);
    q2.dispose();
  });

  it('compacts acked entries away on load', () => {
    const file = path.join(dir, 'q.jsonl');
    const q1 = new JsonlQueueStore<string>(file);
    q1.load();
    for (let i = 0; i < 50; i++) {
      const seq = q1.enqueue(`m${i}`, false);
      if (i % 2 === 0) q1.ack(seq);
    }
    q1.dispose();
    const sizeBefore = fs.statSync(file).size;
    const q2 = new JsonlQueueStore<string>(file);
    q2.load();
    const sizeAfter = fs.statSync(file).size;
    expect(q2.size).toBe(25);
    expect(sizeAfter).toBeLessThan(sizeBefore);
    q2.dispose();
  });

  it('ack is idempotent', () => {
    const q = new JsonlQueueStore<string>(path.join(dir, 'q.jsonl'));
    q.load();
    const s = q.enqueue('x');
    q.ack(s);
    q.ack(s); // repeat ack is a no-op
    expect(q.size).toBe(0);
    q.dispose();
  });
});

describe('SeenStore (dedup)', () => {
  it('persists seen ids across restarts', () => {
    const file = path.join(dir, 'seen.jsonl');
    const s1 = new SeenStore(file, 60_000);
    s1.load();
    s1.add('01ABC');
    s1.add('01DEF');
    expect(s1.has('01ABC')).toBe(true);
    s1.dispose();

    const s2 = new SeenStore(file, 60_000);
    s2.load();
    expect(s2.has('01ABC')).toBe(true);
    expect(s2.has('01DEF')).toBe(true);
    expect(s2.has('01XYZ')).toBe(false);
    s2.dispose();
  });

  it('prunes entries older than the retention window at load', () => {
    const file = path.join(dir, 'seen.jsonl');
    const s1 = new SeenStore(file, 1_000);
    s1.load();
    s1.add('old', Date.now() - 10_000);
    s1.add('fresh', Date.now());
    s1.dispose();

    const s2 = new SeenStore(file, 1_000);
    s2.load();
    expect(s2.has('old')).toBe(false);
    expect(s2.has('fresh')).toBe(true);
    s2.dispose();
  });

  it('duplicate add is a no-op', () => {
    const s = new SeenStore(path.join(dir, 'seen.jsonl'), 60_000);
    s.load();
    s.add('id1');
    s.add('id1');
    expect(s.size).toBe(1);
    s.dispose();
  });
});
