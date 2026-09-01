/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: This entire file is part of the Hive integration.

import { describe, it, expect } from 'vitest';
import {
  applyObjectOp,
  formatObjectOpResult,
  MAX_OBJECTS,
  type HiveObjectRecord,
  type HiveObjectOpParams,
} from './hiveObjects.js';

const FULL = { nodeId: 'n_alice', trust: 'full' as const };
const FULL_B = { nodeId: 'n_bob', trust: 'full' as const };
const CONSULT = { nodeId: 'n_carol', trust: 'consult' as const };

function createGpu(objects: Record<string, HiveObjectRecord>) {
  const res = applyObjectOp(
    objects,
    {
      action: 'create',
      name: 'RTX4090-Tlaptop',
      type: 'resource',
      status: 'in-use',
      attributes: { vram_gb: 16, holder: 'olx-jogos', interruptible: true },
      note: 'gemma training running',
    },
    FULL,
  );
  expect(res.ok).toBe(true);
  return res.record!;
}

describe('applyObjectOp', () => {
  it('creates with attributes, status and a history entry', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const rec = createGpu(objects);
    expect(rec.id).toMatch(/^obj_/);
    expect(rec.version).toBe(1);
    expect(rec.owner).toBe('n_alice');
    expect(rec.visibility).toBe('shared');
    expect(rec.history).toHaveLength(1);
    expect(rec.history[0]).toMatchObject({
      v: 1,
      action: 'create',
      by: 'n_alice',
      status: 'in-use',
      note: 'gemma training running',
    });
    expect(objects[rec.id]).toBe(rec);
  });

  it('updates merge attributes (null deletes), bump version, append history', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const rec = createGpu(objects);
    const res = applyObjectOp(
      objects,
      {
        action: 'update',
        id: rec.id,
        status: 'available',
        attributes: { holder: null, freed_at: 'now' },
        note: 'batch done, freeing',
      },
      FULL_B, // another trusted peer can update a shared object
    );
    expect(res.ok).toBe(true);
    const updated = res.record!;
    expect(updated.version).toBe(2);
    expect(updated.status).toBe('available');
    expect(updated.attributes['holder']).toBeUndefined();
    expect(updated.attributes['freed_at']).toBe('now');
    expect(updated.attributes['vram_gb']).toBe(16); // untouched keys survive
    expect(updated.history).toHaveLength(2);
    expect(updated.history[1]).toMatchObject({
      v: 2,
      by: 'n_bob',
      status: 'available',
      note: 'batch done, freeing',
    });
    expect(updated.history[1].changedKeys).toEqual(['holder', 'freed_at']);
  });

  it('consult peers can read shared objects but never mutate', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const rec = createGpu(objects);
    expect(
      applyObjectOp(objects, { action: 'get', id: rec.id }, CONSULT).ok,
    ).toBe(true);
    expect(
      applyObjectOp(objects, { action: 'list' }, CONSULT).records,
    ).toHaveLength(1);
    for (const params of [
      { action: 'create', name: 'x' },
      { action: 'update', id: rec.id, status: 'free' },
      { action: 'delete', id: rec.id },
    ] as HiveObjectOpParams[]) {
      const res = applyObjectOp(objects, params, CONSULT);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('not permitted');
    }
  });

  it('private objects are invisible and untouchable for everyone but the owner', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const res = applyObjectOp(
      objects,
      { action: 'create', name: 'my-todo', visibility: 'private' },
      FULL,
    );
    const id = res.record!.id;
    // Others: not even "exists".
    expect(applyObjectOp(objects, { action: 'get', id }, FULL_B).error).toBe(
      'no such object',
    );
    expect(
      applyObjectOp(objects, { action: 'update', id, status: 'x' }, FULL_B)
        .error,
    ).toBe('no such object');
    expect(applyObjectOp(objects, { action: 'list' }, FULL_B).records).toEqual(
      [],
    );
    // Owner: full access.
    expect(applyObjectOp(objects, { action: 'get', id }, FULL).ok).toBe(true);
    expect(
      applyObjectOp(objects, { action: 'list' }, FULL).records,
    ).toHaveLength(1);
  });

  it('structural changes (rename/visibility) are owner-only; delete too', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const rec = createGpu(objects);
    expect(
      applyObjectOp(
        objects,
        { action: 'update', id: rec.id, name: 'stolen' },
        FULL_B,
      ).error,
    ).toContain('only the owner');
    expect(
      applyObjectOp(objects, { action: 'delete', id: rec.id }, FULL_B).error,
    ).toContain('only the owner');
    expect(
      applyObjectOp(objects, { action: 'delete', id: rec.id }, FULL).ok,
    ).toBe(true);
    expect(objects[rec.id]).toBeUndefined();
  });

  it('list filters by type and mine, sorted by recency, without history payload', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    createGpu(objects);
    applyObjectOp(
      objects,
      { action: 'create', name: 'art-pipeline', type: 'checklist' },
      FULL_B,
    );
    const all = applyObjectOp(objects, { action: 'list' }, FULL).records!;
    expect(all).toHaveLength(2);
    expect(all[0].history).toEqual([]); // light payload
    const checklists = applyObjectOp(
      objects,
      { action: 'list', filter_type: 'checklist' },
      FULL,
    ).records!;
    expect(checklists).toHaveLength(1);
    const mine = applyObjectOp(
      objects,
      { action: 'list', mine: true },
      FULL_B,
    ).records!;
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe('art-pipeline');
  });

  it('enforces caps: attribute size and object count', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const big = { blob: 'x'.repeat(9_000) };
    expect(
      applyObjectOp(
        objects,
        { action: 'create', name: 'big', attributes: big },
        FULL,
      ).error,
    ).toContain('too large');
    for (let i = 0; i < MAX_OBJECTS; i++) {
      expect(
        applyObjectOp(objects, { action: 'create', name: `o${i}` }, FULL).ok,
      ).toBe(true);
    }
    expect(
      applyObjectOp(objects, { action: 'create', name: 'overflow' }, FULL)
        .error,
    ).toContain('cap');
  });

  it('rejects empty updates and unknown objects', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const rec = createGpu(objects);
    expect(
      applyObjectOp(objects, { action: 'update', id: rec.id }, FULL).error,
    ).toContain('nothing to update');
    expect(
      applyObjectOp(objects, { action: 'get', id: 'obj_nope' }, FULL).error,
    ).toBe('no such object');
  });

  it('sanitizes peer-authored fields (newlines/brackets stripped, caps applied)', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const res = applyObjectOp(
      objects,
      {
        action: 'create',
        name: 'evil\nname <script>',
        status: 's'.repeat(100),
        note: 'n'.repeat(1_000),
      },
      FULL,
    );
    const rec = res.record!;
    expect(rec.name).not.toContain('\n');
    expect(rec.name).not.toContain('<');
    // sanitizeInline appends an ellipsis when truncating → cap + 1.
    expect(rec.status!.length).toBeLessThanOrEqual(41);
    expect(rec.history[0].note!.length).toBeLessThanOrEqual(501);
  });
});

describe('formatObjectOpResult', () => {
  const nickOf = (id: string) => (id === 'n_alice' ? 'alice' : id);

  it('renders list, full record and history readably', () => {
    const objects: Record<string, HiveObjectRecord> = {};
    const rec = createGpu(objects);
    applyObjectOp(
      objects,
      { action: 'update', id: rec.id, status: 'available', note: 'freed' },
      FULL,
    );
    const list = formatObjectOpResult(
      { action: 'list' },
      { records: [rec] },
      nickOf,
      'n_alice',
    );
    expect(list).toContain('[resource] "RTX4090-Tlaptop"');
    expect(list).toContain('owner alice (you)');
    const hist = formatObjectOpResult(
      { action: 'history', id: rec.id },
      { record: rec },
      nickOf,
    );
    expect(hist).toContain('v1');
    expect(hist).toContain('v2');
    expect(hist).toContain('note: "freed"');
    const empty = formatObjectOpResult(
      { action: 'list' },
      { records: [] },
      nickOf,
    );
    expect(empty).toContain('Create one');
  });
});
