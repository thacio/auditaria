/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

/**
 * The pure part of the artifact document store: path grammar, body
 * validation, merge semantics, query evaluation, access rules. No I/O,
 * no state — everything here is a function of its arguments, so the
 * page runtime, the tool and the tests share one implementation of the
 * contract (Claude's db 0.2.41).
 */

export const MAX_SEGMENT_BYTES = 200;
export const MAX_PATH_BYTES = 1000;
export const MAX_PATH_SEGMENTS = 16;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_BODY_DEPTH = 32;
export const MAX_FILTERS = 10;
export const MAX_IN_VALUES = 30;
export const MAX_LIMIT = 1000;
export const MAX_DOCUMENTS = 5000;
export const MAX_RULES = 64;
export const MAX_SUBSCRIPTIONS_PER_VIEW = 64;
export const LEASE_DEFAULT_MS = 30_000;
export const LEASE_MIN_MS = 1_000;
export const LEASE_MAX_MS = 600_000;

const SEGMENT_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

export class DbError extends Error {
  constructor(
    readonly code:
      | 'invalid_argument'
      | 'resource_exhausted'
      | 'quota_exceeded'
      | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

// ---------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------

/**
 * Splits and validates a path. Throws a TypeError naming the broken rule
 * (the contract: a malformed path is a programming error, not a store
 * condition). `{self}` is allowed only when `allowSelf` is set (rules).
 */
export function parsePath(path: string, allowSelf = false): string[] {
  if (typeof path !== 'string') {
    throw new TypeError('path must be a string');
  }
  if (path === '') return [];
  if (Buffer.byteLength(path, 'utf-8') > MAX_PATH_BYTES) {
    throw new TypeError(`path exceeds ${MAX_PATH_BYTES} bytes`);
  }
  const segments = path.split('/');
  if (segments.length > MAX_PATH_SEGMENTS) {
    throw new TypeError(
      `path has ${segments.length} segments; at most ${MAX_PATH_SEGMENTS} are allowed`,
    );
  }
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new TypeError(`path segment "${segment}" is not allowed`);
    }
    if (allowSelf && segment === '{self}') continue;
    if (!SEGMENT_RE.test(segment)) {
      throw new TypeError(
        `path segment "${segment}" must be 1-${MAX_SEGMENT_BYTES} characters of letters, digits, _ - . ~ : @ +`,
      );
    }
    if (Buffer.byteLength(segment, 'utf-8') > MAX_SEGMENT_BYTES) {
      throw new TypeError(`path segment exceeds ${MAX_SEGMENT_BYTES} bytes`);
    }
  }
  return segments;
}

/** A document path: an even, non-zero number of segments. */
export function parseDocPath(path: string): string[] {
  const segments = parsePath(path);
  if (segments.length === 0 || segments.length % 2 !== 0) {
    throw new TypeError(
      `"${path}" is not a document path: it has ${segments.length} segments (a document path has an even number, like "tasks/t1")`,
    );
  }
  return segments;
}

/** A collection path: an odd number of segments. */
export function parseCollectionPath(path: string): string[] {
  const segments = parsePath(path);
  if (segments.length % 2 !== 1) {
    throw new TypeError(
      `"${path}" is not a collection path: it has ${segments.length} segments (a collection path has an odd number, like "tasks")`,
    );
  }
  return segments;
}

export function collectionOf(docPath: string): string {
  const segments = docPath.split('/');
  return segments.slice(0, -1).join('/');
}

export function idOf(docPath: string): string {
  const segments = docPath.split('/');
  return segments[segments.length - 1];
}

// ---------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------

export type Body = Record<string, unknown>;

/** Reads a string member (the lint rule forbids typeof on a property). */
function readString(obj: Body, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

export function isPlainObject(value: unknown): value is Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function depthOf(value: unknown, depth: number): number {
  if (typeof value !== 'object' || value === null) return depth;
  let deepest = depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) {
    if (typeof child === 'object' && child !== null) {
      deepest = Math.max(deepest, depthOf(child, depth + 1));
      if (deepest > MAX_BODY_DEPTH) return deepest;
    }
  }
  return deepest;
}

/** Validates a document body against the contract's limits. */
export function validateBody(body: unknown): Body {
  if (!isPlainObject(body)) {
    throw new DbError(
      'invalid_argument',
      'a document body must be a plain JSON object (not an array, null or a scalar)',
    );
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    throw new DbError('invalid_argument', 'a document body must be plain JSON');
  }
  if (serialized === undefined) {
    throw new DbError('invalid_argument', 'a document body must be plain JSON');
  }
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_BODY_BYTES) {
    throw new DbError(
      'invalid_argument',
      `a document body must be at most ${MAX_BODY_BYTES} bytes serialized`,
    );
  }
  if (depthOf(body, 1) > MAX_BODY_DEPTH) {
    throw new DbError(
      'invalid_argument',
      `a document body must nest at most ${MAX_BODY_DEPTH} levels deep`,
    );
  }
  // Round-trip so the stored value is plain JSON (drops undefined, functions).
  const parsed: unknown = JSON.parse(serialized);
  if (!isPlainObject(parsed)) {
    throw new DbError('invalid_argument', 'a document body must be plain JSON');
  }
  return parsed;
}

/**
 * The `update` merge: nested plain objects merge recursively; anything
 * else (arrays included) replaces the field wholesale. Returns a new
 * object; inputs are not mutated.
 */
export function mergeBodies(base: Body, patch: Body): Body {
  const out: Body = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = mergeBodies(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------

export const WHERE_OPS = [
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'in',
  'not-in',
  'array-contains',
] as const;
export type WhereOp = (typeof WHERE_OPS)[number];

function isWhereOp(value: string): value is WhereOp {
  return (WHERE_OPS as readonly string[]).includes(value);
}

/** Operator spellings the tool accepts besides the symbols. */
const OP_ALIASES: Readonly<Partial<Record<string, WhereOp>>> = {
  eq: '==',
  ne: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

export interface WhereClause {
  readonly f: string;
  readonly op: WhereOp;
  readonly v: unknown;
}

export interface QuerySpec {
  /** Collection path. */
  readonly path: string;
  readonly where: readonly WhereClause[];
  readonly orderBy: { readonly f: string; readonly dir: 'asc' | 'desc' } | null;
  readonly limit: number | null;
}

export interface StoredDoc {
  readonly path: string;
  readonly data: Body;
  readonly version: number;
  readonly updatedAt: string;
}

/** Validates a raw spec (from the page runtime or the tool) into a QuerySpec. */
export function normalizeQuerySpec(raw: unknown): QuerySpec {
  if (!isPlainObject(raw) || readString(raw, 'path') === undefined) {
    throw new DbError('invalid_argument', 'a query needs a collection path');
  }
  const path = readString(raw, 'path') ?? '';
  try {
    parseCollectionPath(path);
  } catch (error) {
    throw new DbError(
      'invalid_argument',
      error instanceof Error ? error.message : String(error),
    );
  }
  const whereRaw = Array.isArray(raw['where']) ? raw['where'] : [];
  if (whereRaw.length > MAX_FILTERS) {
    throw new DbError(
      'invalid_argument',
      `a query may have at most ${MAX_FILTERS} filters`,
    );
  }
  const where: WhereClause[] = whereRaw.map((clause: unknown) => {
    if (!isPlainObject(clause) || readString(clause, 'f') === undefined) {
      throw new DbError('invalid_argument', 'a filter needs a field name');
    }
    const opRaw = String(clause['op']);
    const op: string = OP_ALIASES[opRaw] ?? opRaw;
    if (!isWhereOp(op)) {
      throw new DbError(
        'invalid_argument',
        `unknown filter operator "${opRaw}" (use ${WHERE_OPS.join(', ')})`,
      );
    }
    const v = clause['v'];
    if (op === 'in' || op === 'not-in') {
      if (!Array.isArray(v) || v.length === 0 || v.length > MAX_IN_VALUES) {
        throw new DbError(
          'invalid_argument',
          `"${op}" needs an array of 1-${MAX_IN_VALUES} values`,
        );
      }
    }
    return { f: readString(clause, 'f') ?? '', op, v };
  });
  let orderBy: QuerySpec['orderBy'] = null;
  const orderRaw = raw['orderBy'];
  if (orderRaw !== undefined && orderRaw !== null) {
    if (!isPlainObject(orderRaw) || readString(orderRaw, 'f') === undefined) {
      throw new DbError('invalid_argument', 'orderBy needs a field name');
    }
    const dir = orderRaw['dir'] === 'desc' ? 'desc' : 'asc';
    orderBy = { f: readString(orderRaw, 'f') ?? '', dir };
  }
  let limit: number | null = null;
  const limitRaw = raw['limit'];
  if (limitRaw !== undefined && limitRaw !== null) {
    if (
      typeof limitRaw !== 'number' ||
      !Number.isInteger(limitRaw) ||
      limitRaw < 1 ||
      limitRaw > MAX_LIMIT
    ) {
      throw new DbError(
        'invalid_argument',
        `limit must be an integer between 1 and ${MAX_LIMIT}`,
      );
    }
    limit = limitRaw;
  }
  return { path, where, orderBy, limit };
}

function typeRank(value: unknown): number {
  if (value === null) return 0;
  switch (typeof value) {
    case 'boolean':
      return 1;
    case 'number':
      return 2;
    case 'string':
      return 3;
    default:
      return Array.isArray(value) ? 4 : 5;
  }
}

/** Total order over JSON values, used for ordering and range filters. */
export function compareValues(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return Number(a) - Number(b);
  }
  if (a === null && b === null) return 0;
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (typeRank(a) !== typeRank(b)) return false;
  if (typeof a !== 'object' || a === null) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Whether one document matches every filter. A missing field never matches. */
export function matchesWhere(
  data: Body,
  where: readonly WhereClause[],
): boolean {
  for (const { f, op, v } of where) {
    if (!(f in data)) return false;
    const actual = data[f];
    switch (op) {
      case '==':
        if (!valuesEqual(actual, v)) return false;
        break;
      case '!=':
        if (valuesEqual(actual, v)) return false;
        break;
      case '<':
      case '<=':
      case '>':
      case '>=': {
        if (typeRank(actual) !== typeRank(v)) return false;
        const c = compareValues(actual, v);
        if (op === '<' && !(c < 0)) return false;
        if (op === '<=' && !(c <= 0)) return false;
        if (op === '>' && !(c > 0)) return false;
        if (op === '>=' && !(c >= 0)) return false;
        break;
      }
      case 'in':
        if (!Array.isArray(v) || !v.some((x) => valuesEqual(actual, x)))
          return false;
        break;
      case 'not-in':
        if (Array.isArray(v) && v.some((x) => valuesEqual(actual, x)))
          return false;
        break;
      case 'array-contains':
        if (!Array.isArray(actual) || !actual.some((x) => valuesEqual(x, v))) {
          return false;
        }
        break;
      default:
        return false;
    }
  }
  return true;
}

/**
 * Orders documents per the contract: by the orderBy field (documents
 * missing the field sort LAST regardless of direction), then by id
 * ascending; without orderBy, by id ascending.
 */
export function orderDocs(
  docs: readonly StoredDoc[],
  orderBy: QuerySpec['orderBy'],
): StoredDoc[] {
  const sorted = [...docs];
  sorted.sort((a, b) => {
    if (orderBy) {
      const av = a.data[orderBy.f];
      const bv = b.data[orderBy.f];
      const aMissing = !(orderBy.f in a.data);
      const bMissing = !(orderBy.f in b.data);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      if (!aMissing) {
        const c = compareValues(av, bv);
        if (c !== 0) return orderBy.dir === 'desc' ? -c : c;
      }
    }
    const ai = idOf(a.path);
    const bi = idOf(b.path);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return sorted;
}

/**
 * Evaluates a query over the docs of ONE collection (callers pass the
 * direct children of `spec.path`). Returns the full ordered match; the
 * caller applies the limit window or a cursor.
 */
export function evaluateQuery(
  spec: QuerySpec,
  candidates: readonly StoredDoc[],
): StoredDoc[] {
  const matched = candidates.filter(
    (doc) =>
      collectionOf(doc.path) === spec.path &&
      matchesWhere(doc.data, spec.where),
  );
  return orderDocs(matched, spec.orderBy);
}

/** Opaque cursor for tool paging: the id of the last row delivered. */
export function encodeCursor(lastId: string): string {
  return Buffer.from(lastId, 'utf-8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf-8');
}

/**
 * Applies a tool cursor to an ordered result: rows strictly after the
 * cursor's document. A cursor whose document vanished starts over.
 */
export function pageAfter(
  ordered: readonly StoredDoc[],
  cursor: string | undefined,
  limit: number,
): { rows: StoredDoc[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    const lastId = decodeCursor(cursor);
    const index = ordered.findIndex((doc) => idOf(doc.path) === lastId);
    if (index >= 0) start = index + 1;
  }
  const rows = ordered.slice(start, start + limit);
  const nextCursor =
    start + limit < ordered.length && rows.length > 0
      ? encodeCursor(idOf(rows[rows.length - 1].path))
      : null;
  return { rows, nextCursor };
}

// ---------------------------------------------------------------------
// Access rules
// ---------------------------------------------------------------------

export const LEVELS = ['view', 'interact', 'admin', 'owner'] as const;
export type Level = (typeof LEVELS)[number];

export function levelRank(level: Level): number {
  return LEVELS.indexOf(level);
}

export interface AccessRule {
  /** Document-path grammar; `{self}` allowed as the LAST segment; '' = root. */
  readonly path: string;
  readonly read?: Level;
  readonly write?: Level;
}

const ROOT_READ: Level = 'view';
const ROOT_WRITE: Level = 'interact';
/** Each viewer's own subtree: readable and writable by them alone. */
const DEFAULT_SELF_RULE: AccessRule = {
  path: 'data/users/{self}',
  read: 'view',
  write: 'interact',
};

function isLevel(value: unknown): value is Level {
  return (
    typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Validates a `db.rules` declaration at publish time. Returns the
 * normalized rules (the default `data/users/{self}` rule is implied and
 * need not be declared).
 */
export function validateRules(raw: unknown): AccessRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new DbError('invalid_argument', 'db.rules must be an array');
  }
  if (raw.length > MAX_RULES) {
    throw new DbError(
      'invalid_argument',
      `db.rules may have at most ${MAX_RULES} rules`,
    );
  }
  const rules: AccessRule[] = raw.map((entry: unknown) => {
    if (!isPlainObject(entry) || readString(entry, 'path') === undefined) {
      throw new DbError('invalid_argument', 'each db rule needs a path');
    }
    const path = readString(entry, 'path') ?? '';
    let segments: string[];
    try {
      segments = parsePath(path, true);
    } catch (error) {
      throw new DbError(
        'invalid_argument',
        `db rule path "${path}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const selfIndex = segments.indexOf('{self}');
    if (selfIndex !== -1 && selfIndex !== segments.length - 1) {
      throw new DbError(
        'invalid_argument',
        `db rule path "${path}": {self} must be the last segment`,
      );
    }
    const read = entry['read'];
    const write = entry['write'];
    if (read !== undefined && !isLevel(read)) {
      throw new DbError(
        'invalid_argument',
        `db rule "${path}": bad read level`,
      );
    }
    if (write !== undefined && !isLevel(write)) {
      throw new DbError(
        'invalid_argument',
        `db rule "${path}": bad write level`,
      );
    }
    if (read === undefined && write === undefined) {
      throw new DbError(
        'invalid_argument',
        `db rule "${path}" sets neither read nor write`,
      );
    }
    return {
      path,
      ...(read !== undefined ? { read } : {}),
      ...(write !== undefined ? { write } : {}),
    };
  });
  // A rule at the prefix of a {self} rule must set both levels.
  for (const rule of rules) {
    if (!rule.path.endsWith('{self}')) continue;
    const prefix = rule.path.slice(0, -'{self}'.length).replace(/\/$/, '');
    const atPrefix = rules.find((r) => r.path === prefix);
    if (
      atPrefix &&
      (atPrefix.read === undefined || atPrefix.write === undefined)
    ) {
      throw new DbError(
        'invalid_argument',
        `db rule "${prefix}" must set both read and write because "${rule.path}" is declared below it`,
      );
    }
  }
  return rules;
}

export interface Viewer {
  readonly id: string;
  readonly level: Level;
}

/**
 * Decides whether a viewer may read or write a document path. The owner
 * meets every level; only another viewer's `{self}` subtree is closed to
 * everyone (including the owner) unless a rule at the prefix opens it.
 */
export function mayAccess(
  rules: readonly AccessRule[],
  viewer: Viewer,
  docPath: string,
  action: 'read' | 'write',
): boolean {
  const segments = docPath.split('/');
  const all = [DEFAULT_SELF_RULE, ...rules];
  let required: Level = action === 'read' ? ROOT_READ : ROOT_WRITE;
  let bestDepth = -1;
  let closed = false;

  for (const rule of all) {
    const ruleSegments = rule.path === '' ? [] : rule.path.split('/');
    if (ruleSegments.length > segments.length) continue;
    let matches = true;
    let selfMismatch = false;
    for (let i = 0; i < ruleSegments.length; i++) {
      const expected = ruleSegments[i];
      if (expected === '{self}') {
        if (segments[i] !== viewer.id) selfMismatch = true;
      } else if (expected !== segments[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const depth = ruleSegments.length;
    if (selfMismatch) {
      // Someone else's private subtree: closed unless a declared rule
      // sits exactly at the prefix (it then governs by its levels).
      const prefix = ruleSegments.slice(0, -1).join('/');
      const opener = rules.find((r) => r.path === prefix);
      if (!opener) {
        if (depth > bestDepth) {
          closed = true;
          bestDepth = depth;
        }
      }
      continue;
    }
    if (depth >= bestDepth) {
      const level = action === 'read' ? rule.read : rule.write;
      if (level !== undefined) {
        required = level;
        closed = false;
        bestDepth = depth;
      } else if (depth > bestDepth) {
        // Inherits the level from above; still the deepest match.
        closed = false;
        bestDepth = depth;
      }
    }
  }
  if (closed) return false;
  if (viewer.level === 'owner') return true;
  return levelRank(viewer.level) >= levelRank(required);
}

/** Lease clamp per the contract: absent/0 → 30 s, else [1 s, 600 s]. */
export function clampLeaseTtl(ttlMs: unknown): number {
  const n = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : 0;
  if (n <= 0) return LEASE_DEFAULT_MS;
  return Math.min(LEASE_MAX_MS, Math.max(LEASE_MIN_MS, Math.round(n)));
}
