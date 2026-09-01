/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.
//
// Hive OBJECTS: small shared/private state records living AT THE HUB —
// checklists, roadmaps, resource claims (the GPU case), notes. Peers create
// an object with agent-defined attributes, track a status with observation
// notes, and read the modification history. Deliberately PULL-only: object
// changes never generate hive mail (agents announce important transitions
// themselves with hive_send), so a ticking checklist can't wake anyone.
//
// Authority + concurrency: the hub applies ops serially and is the single
// source of truth (same availability as messaging). Last-writer-wins;
// `version` increments per change and the capped history shows every hand.
//
// Trust: MUTATIONS require a full-trust peer; consult peers read shared
// objects only. Private objects are visible/writable by their owner alone.
//
// Kept free of any @google/gemini-cli-core import: used by the hub, the
// native HiveService transport AND the hive-mcp shim, and unit-tested in
// the lean vitest.hive.config.ts suite.

import { makeUlid, sanitizeInline } from './HiveCrypto.js';
import type { TrustLevel } from './types.js';

// -------------------------------------------------------------------
// Caps
// -------------------------------------------------------------------

export const MAX_OBJECTS = 200;
export const MAX_OBJECT_NAME = 80;
export const MAX_OBJECT_TYPE = 24;
export const MAX_OBJECT_STATUS = 40;
export const MAX_OBJECT_NOTE = 500;
export const MAX_OBJECT_ATTR_BYTES = 8 * 1024;
export const MAX_OBJECT_HISTORY = 100;

// -------------------------------------------------------------------
// Model
// -------------------------------------------------------------------

export interface HiveObjectHistoryEntry {
  /** Version this change produced. */
  v: number;
  ts: number;
  /** nodeId of the peer that made the change. */
  by: string;
  action: 'create' | 'update' | 'delete';
  /** Status AFTER the change, present when it changed. */
  status?: string;
  /** Attribute keys touched by this change. */
  changedKeys?: string[];
  /** Free-form observation supplied with the change. */
  note?: string;
}

export interface HiveObjectRecord {
  id: string; // obj_<ulid>
  name: string;
  /** Free-form kind: "resource" | "checklist" | "roadmap" | "note" | … */
  type: string;
  /** nodeId of the creator. */
  owner: string;
  visibility: 'shared' | 'private';
  status?: string;
  /** Agent-defined JSON (≤8KB serialized). */
  attributes: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  /** Newest LAST, capped at MAX_OBJECT_HISTORY. */
  history: HiveObjectHistoryEntry[];
}

export interface HiveObjectOpParams {
  action: 'create' | 'update' | 'get' | 'list' | 'history' | 'delete';
  id?: string;
  name?: string;
  type?: string;
  visibility?: 'shared' | 'private';
  status?: string;
  /** Shallow-merged into the object's attributes; a null value deletes the key. */
  attributes?: Record<string, unknown>;
  /** Observation recorded in the history entry. */
  note?: string;
  /** list: only objects of this type. */
  filter_type?: string;
  /** list: only objects this peer owns. */
  mine?: boolean;
}

export interface ObjOpContext {
  nodeId: string;
  trust: TrustLevel;
  now?: number;
}

export interface ObjOpResult {
  ok: boolean;
  error?: string;
  /** True when the store mutated (caller persists). */
  changed?: boolean;
  record?: HiveObjectRecord;
  records?: HiveObjectRecord[];
}

// -------------------------------------------------------------------
// Apply (hub-side; mutates the passed store when changed=true)
// -------------------------------------------------------------------

function err(error: string): ObjOpResult {
  return { ok: false, error };
}

function canRead(rec: HiveObjectRecord, nodeId: string): boolean {
  return rec.visibility === 'shared' || rec.owner === nodeId;
}

function canWrite(rec: HiveObjectRecord, ctx: ObjOpContext): boolean {
  if (ctx.trust !== 'full') return false;
  return rec.visibility === 'shared' || rec.owner === ctx.nodeId;
}

function attrBytes(attributes: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(attributes), 'utf-8');
  } catch {
    return Number.MAX_SAFE_INTEGER; // circular/unserializable → reject
  }
}

function pushHistory(
  rec: HiveObjectRecord,
  entry: HiveObjectHistoryEntry,
): void {
  rec.history.push(entry);
  if (rec.history.length > MAX_OBJECT_HISTORY) {
    rec.history.splice(0, rec.history.length - MAX_OBJECT_HISTORY);
  }
}

export function applyObjectOp(
  objects: Record<string, HiveObjectRecord>,
  params: HiveObjectOpParams,
  ctx: ObjOpContext,
): ObjOpResult {
  const now = ctx.now ?? Date.now();
  const note = params.note
    ? sanitizeInline(String(params.note), MAX_OBJECT_NOTE)
    : undefined;

  switch (params.action) {
    case 'create': {
      if (ctx.trust !== 'full') {
        return err('not permitted — creating objects requires a trusted peer');
      }
      const name = sanitizeInline(String(params.name ?? ''), MAX_OBJECT_NAME);
      if (!name) return err('name is required');
      if (Object.keys(objects).length >= MAX_OBJECTS) {
        return err(
          `object cap reached (${MAX_OBJECTS}) — delete unused objects first`,
        );
      }
      const attributes = params.attributes ?? {};
      if (attrBytes(attributes) > MAX_OBJECT_ATTR_BYTES) {
        return err('attributes too large (max 8KB serialized)');
      }
      const rec: HiveObjectRecord = {
        id: `obj_${makeUlid().toLowerCase()}`,
        name,
        type: sanitizeInline(String(params.type ?? 'note'), MAX_OBJECT_TYPE),
        owner: ctx.nodeId,
        visibility: params.visibility === 'private' ? 'private' : 'shared',
        status: params.status
          ? sanitizeInline(String(params.status), MAX_OBJECT_STATUS)
          : undefined,
        attributes,
        version: 1,
        createdAt: now,
        updatedAt: now,
        history: [],
      };
      pushHistory(rec, {
        v: 1,
        ts: now,
        by: ctx.nodeId,
        action: 'create',
        status: rec.status,
        changedKeys: Object.keys(attributes),
        note,
      });
      objects[rec.id] = rec;
      return { ok: true, changed: true, record: rec };
    }

    case 'update': {
      const rec = params.id ? objects[params.id] : undefined;
      if (!rec || !canRead(rec, ctx.nodeId)) return err('no such object');
      if (!canWrite(rec, ctx)) {
        return err(
          rec.visibility === 'private'
            ? 'not permitted — only the owner updates a private object'
            : 'not permitted — updating objects requires a trusted peer',
        );
      }
      // Structural fields (name/type/visibility) are owner-only; status,
      // attributes and notes are open to any writer.
      const structural =
        params.name !== undefined ||
        params.type !== undefined ||
        params.visibility !== undefined;
      if (structural && rec.owner !== ctx.nodeId) {
        return err(
          'not permitted — only the owner renames/retypes an object or changes its visibility',
        );
      }
      const changedKeys: string[] = [];
      let statusChanged = false;
      if (params.status !== undefined) {
        const s = sanitizeInline(String(params.status), MAX_OBJECT_STATUS);
        if (s !== rec.status) {
          rec.status = s || undefined;
          statusChanged = true;
        }
      }
      if (params.attributes) {
        const merged = { ...rec.attributes };
        for (const [k, v] of Object.entries(params.attributes)) {
          if (v === null) {
            if (k in merged) {
              delete merged[k];
              changedKeys.push(k);
            }
          } else {
            merged[k] = v;
            changedKeys.push(k);
          }
        }
        if (attrBytes(merged) > MAX_OBJECT_ATTR_BYTES) {
          return err('attributes too large (max 8KB serialized)');
        }
        rec.attributes = merged;
      }
      if (params.name !== undefined) {
        const n = sanitizeInline(String(params.name), MAX_OBJECT_NAME);
        if (n) rec.name = n;
      }
      if (params.type !== undefined) {
        rec.type = sanitizeInline(String(params.type), MAX_OBJECT_TYPE);
      }
      if (params.visibility !== undefined) {
        rec.visibility = params.visibility === 'private' ? 'private' : 'shared';
      }
      if (!statusChanged && changedKeys.length === 0 && !structural && !note) {
        return err('nothing to update — provide status, attributes or note');
      }
      rec.version += 1;
      rec.updatedAt = now;
      pushHistory(rec, {
        v: rec.version,
        ts: now,
        by: ctx.nodeId,
        action: 'update',
        status: statusChanged ? rec.status : undefined,
        changedKeys: changedKeys.length ? changedKeys : undefined,
        note,
      });
      return { ok: true, changed: true, record: rec };
    }

    case 'delete': {
      const rec = params.id ? objects[params.id] : undefined;
      if (!rec || !canRead(rec, ctx.nodeId)) return err('no such object');
      if (ctx.trust !== 'full' || rec.owner !== ctx.nodeId) {
        return err('not permitted — only the owner deletes an object');
      }
      delete objects[rec.id];
      return { ok: true, changed: true, record: rec };
    }

    case 'get':
    case 'history': {
      const rec = params.id ? objects[params.id] : undefined;
      if (!rec || !canRead(rec, ctx.nodeId)) return err('no such object');
      return { ok: true, record: rec };
    }

    case 'list': {
      const records = Object.values(objects)
        .filter((r) => canRead(r, ctx.nodeId))
        .filter((r) => !params.filter_type || r.type === params.filter_type)
        .filter((r) => !params.mine || r.owner === ctx.nodeId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        // Light payload: history rides only on get/history.
        .map((r) => ({ ...r, history: [] }));
      return { ok: true, records };
    }

    default:
      return err(`unknown action "${String(params.action)}"`);
  }
}

// -------------------------------------------------------------------
// Formatting (client-side: native HiveService AND the hive-mcp shim)
// -------------------------------------------------------------------

type NickOf = (nodeId: string) => string;

function ago(ts: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function compactJson(value: unknown, maxLen: number): string {
  let s: string;
  try {
    s = JSON.stringify(value) ?? '{}';
  } catch {
    s = '{}';
  }
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

export function formatObjectLine(
  rec: HiveObjectRecord,
  nickOf: NickOf,
  selfNodeId?: string,
): string {
  const owner = nickOf(rec.owner) + (rec.owner === selfNodeId ? ' (you)' : '');
  const bits = [
    rec.status ? `status=${rec.status}` : undefined,
    `v${rec.version}`,
    rec.visibility,
    `owner ${owner}`,
    `updated ${ago(rec.updatedAt)}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const attrs =
    Object.keys(rec.attributes).length > 0
      ? `\n    ${compactJson(rec.attributes, 160)}`
      : '';
  return `- [${rec.type}] "${rec.name}" (${rec.id}) — ${bits}${attrs}`;
}

export function formatObjectHistoryLines(
  rec: HiveObjectRecord,
  nickOf: NickOf,
  limit = 20,
): string {
  const entries = rec.history.slice(-limit);
  if (entries.length === 0) return '(no history)';
  return entries
    .map((h) => {
      const bits = [
        h.status !== undefined ? `status→${h.status}` : undefined,
        h.changedKeys?.length
          ? `keys [${h.changedKeys.join(', ')}]`
          : undefined,
        h.note ? `note: "${h.note}"` : undefined,
      ]
        .filter(Boolean)
        .join(', ');
      return `  v${h.v} ${ago(h.ts)} by ${nickOf(h.by)} — ${h.action}${bits ? `: ${bits}` : ''}`;
    })
    .join('\n');
}

export function formatObjectFull(
  rec: HiveObjectRecord,
  nickOf: NickOf,
  selfNodeId?: string,
): string {
  return (
    `${formatObjectLine(rec, nickOf, selfNodeId)}\n` +
    `  attributes: ${compactJson(rec.attributes, 4_000)}\n` +
    `  recent history:\n${formatObjectHistoryLines(rec, nickOf, 5)}`
  );
}

/** One shared result formatter for both the native transport and the shim. */
export function formatObjectOpResult(
  params: HiveObjectOpParams,
  res: { record?: HiveObjectRecord; records?: HiveObjectRecord[] },
  nickOf: NickOf,
  selfNodeId?: string,
): string {
  switch (params.action) {
    case 'list': {
      const records = res.records ?? [];
      if (records.length === 0) {
        return 'No hive objects yet. Create one with action="create" (name, type, status, attributes) — e.g. a shared "resource" object for the GPU, or a "checklist".';
      }
      return (
        `${records.length} hive object(s) — get/history by id, update with a note so peers see why:\n` +
        records.map((r) => formatObjectLine(r, nickOf, selfNodeId)).join('\n')
      );
    }
    case 'history': {
      const rec = res.record!;
      return (
        `History of [${rec.type}] "${rec.name}" (${rec.id}), v${rec.version}:\n` +
        formatObjectHistoryLines(rec, nickOf)
      );
    }
    case 'delete': {
      const rec = res.record!;
      return `Deleted [${rec.type}] "${rec.name}" (${rec.id}).`;
    }
    case 'create': {
      const rec = res.record!;
      return `Created:\n${formatObjectFull(rec, nickOf, selfNodeId)}\nPeers see it via hive_object list — announce it with hive_send only if it needs attention NOW.`;
    }
    default: {
      const rec = res.record!;
      return formatObjectFull(rec, nickOf, selfNodeId);
    }
  }
}
