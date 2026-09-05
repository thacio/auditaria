/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_BYTES,
  clampLeaseTtl,
  compareValues,
  decodeCursor,
  encodeCursor,
  evaluateQuery,
  matchesWhere,
  mayAccess,
  mergeBodies,
  normalizeQuerySpec,
  orderDocs,
  pageAfter,
  parseCollectionPath,
  parseDocPath,
  parsePath,
  validateBody,
  validateRules,
  type StoredDoc,
} from './dbEngine.js';

const doc = (path: string, data: Record<string, unknown>): StoredDoc => ({
  path,
  data,
  version: 1,
  updatedAt: '2026-09-04T00:00:00.000Z',
});

describe('path grammar', () => {
  it('accepts the documented charset and rejects the rest', () => {
    expect(parsePath('tasks/t1')).toEqual(['tasks', 't1']);
    expect(parsePath('a.b-c_d~e:f@g+h')).toEqual(['a.b-c_d~e:f@g+h']);
    expect(parsePath('')).toEqual([]);
    expect(() => parsePath('tasks/t 1')).toThrow(TypeError);
    expect(() => parsePath('tasks/./x')).toThrow(/not allowed/);
    expect(() => parsePath('../x')).toThrow(/not allowed/);
    expect(() => parsePath('x'.repeat(201))).toThrow(/1-200/);
    expect(() => parsePath(Array(17).fill('a').join('/'))).toThrow(
      /17 segments/,
    );
    expect(() => parsePath('a/'.repeat(510) + 'b')).toThrow(/bytes|segments/);
  });

  it('checks parity for documents and collections', () => {
    expect(parseDocPath('boards/b1/columns/c2')).toHaveLength(4);
    expect(() => parseDocPath('tasks')).toThrow(/1 segments/);
    expect(() => parseDocPath('')).toThrow(/document path/);
    expect(parseCollectionPath('data/users/u1')).toHaveLength(3);
    expect(() => parseCollectionPath('tasks/t1')).toThrow(/2 segments/);
    expect(() => parseCollectionPath('')).toThrow(/0 segments/);
    expect(() => parsePath('data/users/{self}')).toThrow(TypeError);
    expect(parsePath('data/users/{self}', true)).toHaveLength(3);
  });
});

describe('bodies and merge', () => {
  it('validates bodies against the contract limits', () => {
    expect(validateBody({ a: 1 })).toEqual({ a: 1 });
    expect(() => validateBody([1])).toThrow(/plain JSON object/);
    expect(() => validateBody(null)).toThrow(/plain JSON object/);
    expect(() => validateBody('x')).toThrow(/plain JSON object/);
    expect(() => validateBody({ big: 'x'.repeat(MAX_BODY_BYTES) })).toThrow(
      /bytes/,
    );
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 33; i++) deep = { child: deep };
    expect(() => validateBody(deep)).toThrow(/levels deep/);
    // Round-trips to plain JSON: undefined members are dropped.
    expect(validateBody({ a: undefined, b: 2 })).toEqual({ b: 2 });
  });

  it('merges nested objects recursively and replaces everything else', () => {
    const base = { a: { x: 1, y: [1, 2] }, b: 'keep', c: [1] };
    const merged = mergeBodies(base, {
      a: { y: [3], z: 9 },
      c: { now: 'object' },
      d: null,
    });
    expect(merged).toEqual({
      a: { x: 1, y: [3], z: 9 },
      b: 'keep',
      c: { now: 'object' },
      d: null,
    });
    expect(base.a).toEqual({ x: 1, y: [1, 2] }); // inputs untouched
  });
});

describe('queries', () => {
  const docs = [
    doc('tasks/a', { n: 3, tag: 'x', tags: ['p', 'q'], done: false }),
    doc('tasks/b', { n: 1, tag: 'y', tags: ['q'], done: true }),
    doc('tasks/c', { n: 2, tag: 'x', tags: [], done: false }),
    doc('tasks/d', { tag: 'z' }),
    doc('other/e', { n: 0 }),
  ];
  const spec = (over: Record<string, unknown>) =>
    normalizeQuerySpec({
      path: 'tasks',
      where: [],
      orderBy: null,
      limit: null,
      ...over,
    });

  it('normalizes specs and rejects bad ones', () => {
    expect(spec({}).path).toBe('tasks');
    expect(() => normalizeQuerySpec({ path: 'tasks/t1' })).toThrow(
      /2 segments/,
    );
    expect(() =>
      spec({ where: Array(11).fill({ f: 'n', op: '==', v: 1 }) }),
    ).toThrow(/10 filters/);
    expect(() => spec({ where: [{ f: 'n', op: '~', v: 1 }] })).toThrow(
      /unknown filter operator/,
    );
    expect(() => spec({ where: [{ f: 'n', op: 'in', v: 'x' }] })).toThrow(
      /1-30 values/,
    );
    expect(() =>
      spec({ where: [{ f: 'n', op: 'in', v: Array(31).fill(1) }] }),
    ).toThrow(/1-30/);
    expect(() => spec({ limit: 0 })).toThrow(/between 1 and 1000/);
    expect(() => spec({ limit: 1001 })).toThrow(/between 1 and 1000/);
    expect(spec({ where: [{ f: 'n', op: 'gte', v: 1 }] }).where[0].op).toBe(
      '>=',
    );
    expect(spec({ orderBy: { f: 'n' } }).orderBy).toEqual({
      f: 'n',
      dir: 'asc',
    });
  });

  it('evaluates every operator; a missing field never matches', () => {
    const ids = (where: unknown[]) =>
      evaluateQuery(spec({ where }), docs).map((d) => d.path.split('/')[1]);
    expect(ids([{ f: 'tag', op: '==', v: 'x' }])).toEqual(['a', 'c']);
    expect(ids([{ f: 'tag', op: '!=', v: 'x' }])).toEqual(['b', 'd']);
    expect(ids([{ f: 'n', op: '<', v: 3 }])).toEqual(['b', 'c']);
    expect(ids([{ f: 'n', op: '<=', v: 2 }])).toEqual(['b', 'c']);
    expect(ids([{ f: 'n', op: '>', v: 1 }])).toEqual(['a', 'c']);
    expect(ids([{ f: 'n', op: '>=', v: 3 }])).toEqual(['a']);
    expect(ids([{ f: 'tag', op: 'in', v: ['y', 'z'] }])).toEqual(['b', 'd']);
    expect(ids([{ f: 'tag', op: 'not-in', v: ['y', 'z'] }])).toEqual([
      'a',
      'c',
    ]);
    expect(ids([{ f: 'tags', op: 'array-contains', v: 'q' }])).toEqual([
      'a',
      'b',
    ]);
    expect(ids([{ f: 'n', op: '<', v: 'string' }])).toEqual([]); // type mismatch
    expect(ids([{ f: 'missing', op: '!=', v: 1 }])).toEqual([]);
    expect(
      ids([
        { f: 'done', op: '==', v: false },
        { f: 'n', op: '>', v: 2 },
      ]),
    ).toEqual(['a']);
    expect(
      matchesWhere({ a: { b: 1 } }, [{ f: 'a', op: '==', v: { b: 1 } }]),
    ).toBe(true);
  });

  it('orders by the field with missing last, id tiebreak, then id by default', () => {
    const order = (orderBy: { f: string; dir: 'asc' | 'desc' } | null) =>
      orderDocs(
        docs.filter((d) => d.path.startsWith('tasks/')),
        orderBy,
      ).map((d) => d.path.split('/')[1]);
    expect(order(null)).toEqual(['a', 'b', 'c', 'd']);
    expect(order({ f: 'n', dir: 'asc' })).toEqual(['b', 'c', 'a', 'd']);
    expect(order({ f: 'n', dir: 'desc' })).toEqual(['a', 'c', 'b', 'd']); // missing still last
    expect(order({ f: 'tag', dir: 'asc' })).toEqual(['a', 'c', 'b', 'd']); // ties by id
    expect(compareValues(null, false)).toBeLessThan(0);
    expect(compareValues(false, 0)).toBeLessThan(0);
    expect(compareValues(1, 'a')).toBeLessThan(0);
    expect(compareValues('a', [1])).toBeLessThan(0);
  });

  it('pages with an opaque cursor and restarts when the cursor vanished', () => {
    const ordered = evaluateQuery(
      spec({ orderBy: { f: 'n', dir: 'asc' } }),
      docs,
    );
    const first = pageAfter(ordered, undefined, 2);
    expect(first.rows.map((d) => d.path)).toEqual(['tasks/b', 'tasks/c']);
    expect(first.nextCursor).toBe(encodeCursor('c'));
    expect(decodeCursor(first.nextCursor!)).toBe('c');
    const second = pageAfter(ordered, first.nextCursor!, 2);
    expect(second.rows.map((d) => d.path)).toEqual(['tasks/a', 'tasks/d']);
    expect(second.nextCursor).toBeNull();
    const restarted = pageAfter(ordered, encodeCursor('gone'), 10);
    expect(restarted.rows).toHaveLength(4);
  });
});

describe('access rules', () => {
  it('validates declarations', () => {
    expect(validateRules(undefined)).toEqual([]);
    expect(
      validateRules([{ path: '', read: 'interact', write: 'admin' }]),
    ).toEqual([{ path: '', read: 'interact', write: 'admin' }]);
    expect(() => validateRules('x')).toThrow(/array/);
    expect(() =>
      validateRules(Array(65).fill({ path: '', read: 'view' })),
    ).toThrow(/64/);
    expect(() =>
      validateRules([{ path: 'a/{self}/b', write: 'interact' }]),
    ).toThrow(/last segment/);
    expect(() => validateRules([{ path: 'a', read: 'boss' }])).toThrow(
      /bad read level/,
    );
    expect(() => validateRules([{ path: 'a' }])).toThrow(/neither/);
    expect(() =>
      validateRules([
        { path: 'votes', read: 'view' },
        { path: 'votes/{self}', write: 'interact' },
      ]),
    ).toThrow(/must set both read and write/);
    expect(
      validateRules([
        { path: 'votes', read: 'view', write: 'admin' },
        { path: 'votes/{self}', write: 'interact' },
      ]),
    ).toHaveLength(2);
  });

  it('applies the defaults: shared data open to interact, own subtree private', () => {
    const me = { id: 'u_me', level: 'interact' as const };
    const owner = { id: 'u_owner', level: 'owner' as const };
    const viewer = { id: 'u_view', level: 'view' as const };
    expect(mayAccess([], me, 'tasks/t1', 'read')).toBe(true);
    expect(mayAccess([], me, 'tasks/t1', 'write')).toBe(true);
    expect(mayAccess([], viewer, 'tasks/t1', 'read')).toBe(true);
    expect(mayAccess([], viewer, 'tasks/t1', 'write')).toBe(false);
    expect(mayAccess([], me, 'data/users/u_me/profile', 'read')).toBe(true);
    expect(mayAccess([], me, 'data/users/u_me/profile', 'write')).toBe(true);
    expect(mayAccess([], me, 'data/users/u_other/profile', 'read')).toBe(false);
    expect(mayAccess([], me, 'data/users/u_other/profile', 'write')).toBe(
      false,
    );
    // The owner meets every level but never sees another viewer's subtree.
    expect(mayAccess([], owner, 'tasks/t1', 'write')).toBe(true);
    expect(mayAccess([], owner, 'data/users/u_other/profile', 'read')).toBe(
      false,
    );
    expect(mayAccess([], owner, 'data/users/u_owner/x', 'write')).toBe(true);
  });

  it('applies declared rules: deeper overrides, prefix rules open siblings', () => {
    const rules = validateRules([
      { path: '', read: 'interact', write: 'admin' },
      { path: 'votes', read: 'view', write: 'admin' },
      { path: 'votes/{self}', write: 'interact' },
      { path: 'data/users', read: 'admin', write: 'admin' },
    ]);
    const me = { id: 'u_me', level: 'interact' as const };
    const admin = { id: 'u_admin', level: 'admin' as const };
    const viewer = { id: 'u_view', level: 'view' as const };
    expect(mayAccess(rules, me, 'tasks/t1', 'read')).toBe(true);
    expect(mayAccess(rules, me, 'tasks/t1', 'write')).toBe(false);
    expect(mayAccess(rules, admin, 'tasks/t1', 'write')).toBe(true);
    expect(mayAccess(rules, viewer, 'votes/u_x', 'read')).toBe(true);
    expect(mayAccess(rules, me, 'votes/u_me', 'write')).toBe(true);
    expect(mayAccess(rules, me, 'votes/u_other', 'write')).toBe(false);
    expect(mayAccess(rules, admin, 'votes/u_other', 'write')).toBe(true); // prefix opens siblings
    expect(mayAccess(rules, admin, 'data/users/u_other/profile', 'read')).toBe(
      true,
    );
    expect(mayAccess(rules, me, 'data/users/u_other/profile', 'read')).toBe(
      false,
    );
  });
});

describe('leases', () => {
  it('clamps the ttl', () => {
    expect(clampLeaseTtl(undefined)).toBe(30_000);
    expect(clampLeaseTtl(0)).toBe(30_000);
    expect(clampLeaseTtl(10)).toBe(1_000);
    expect(clampLeaseTtl(5_000)).toBe(5_000);
    expect(clampLeaseTtl(9_999_999)).toBe(600_000);
    expect(clampLeaseTtl('x')).toBe(30_000);
  });
});
