/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_CODEX_PROVIDER: tests for the dynamic Codex model catalog.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getCodexCatalogModels,
  getCodexCatalogEfforts,
  getCodexCatalogModelIds,
  getCodexModelDisplayName,
  resetCodexCatalogCache,
} from './codexModelCatalog.js';

let codexHome: string;
const originalCodexHome = process.env['CODEX_HOME'];

/** Minimal `models_cache.json` entry in Codex's own shape. */
function model(
  slug: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    slug,
    display_name: slug.toUpperCase(),
    description: `${slug} description`,
    visibility: 'list',
    priority: 10,
    supported_reasoning_levels: [
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
    ],
    ...overrides,
  };
}

function writeCache(payload: unknown): void {
  writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify(payload));
  resetCodexCatalogCache();
}

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), 'codex-catalog-'));
  process.env['CODEX_HOME'] = codexHome;
  resetCodexCatalogCache();
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = originalCodexHome;
  resetCodexCatalogCache();
  rmSync(codexHome, { recursive: true, force: true });
});

describe('getCodexCatalogModels', () => {
  it('returns undefined when the cache file is missing', () => {
    expect(getCodexCatalogModels()).toBeUndefined();
    expect(getCodexCatalogModelIds()).toBeUndefined();
  });

  it('returns undefined for a corrupt cache file (callers keep the fallback)', () => {
    writeFileSync(join(codexHome, 'models_cache.json'), '{ not json');
    resetCodexCatalogCache();
    expect(getCodexCatalogModels()).toBeUndefined();
  });

  it('keeps only the models Codex lists in its own picker', () => {
    writeCache({
      models: [
        model('gpt-reserve', { visibility: 'hide' }),
        model('gpt-5.6-sol'),
        model('codex-auto-review', { visibility: 'hide' }),
      ],
    });
    expect(getCodexCatalogModelIds()).toEqual(['gpt-5.6-sol']);
  });

  it('skips a Codex-supplied `auto` so our synthetic entry stays unique', () => {
    writeCache({ models: [model('auto'), model('gpt-5.5')] });
    expect(getCodexCatalogModelIds()).toEqual(['gpt-5.5']);
  });

  it('orders models by Codex priority, not file order', () => {
    writeCache({
      models: [
        model('gpt-5.4', { priority: 16 }),
        model('gpt-5.6-sol', { priority: 6 }),
        model('gpt-5.5', { priority: 12 }),
      ],
    });
    expect(getCodexCatalogModelIds()).toEqual([
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  it('normalises display names to our spacing', () => {
    writeCache({
      models: [
        model('gpt-5.6-sol', { display_name: 'GPT-5.6-Sol' }),
        model('gpt-5.5', { display_name: 'GPT-5.5' }),
      ],
    });
    const models = getCodexCatalogModels();
    expect(models?.map((m) => m.displayName)).toEqual([
      'GPT-5.6 Sol',
      'GPT-5.5',
    ]);
  });

  it('skips entries without a usable slug', () => {
    writeCache({
      models: [model('gpt-5.5'), { display_name: 'nameless' }, 42],
    });
    expect(getCodexCatalogModelIds()).toEqual(['gpt-5.5']);
  });

  it('re-reads after the cache file changes', () => {
    writeCache({ models: [model('gpt-5.5')] });
    expect(getCodexCatalogModelIds()).toEqual(['gpt-5.5']);

    writeCache({ models: [model('gpt-5.5'), model('gpt-5.7')] });
    expect(getCodexCatalogModelIds()).toEqual(['gpt-5.5', 'gpt-5.7']);
  });
});

describe('getCodexCatalogEfforts', () => {
  it('reports each model’s own tiers, ascending', () => {
    writeCache({
      models: [
        model('gpt-5.6-sol', {
          // Deliberately out of order — clamping relies on ascending output.
          supported_reasoning_levels: [
            { effort: 'ultra' },
            { effort: 'low' },
            { effort: 'max' },
            { effort: 'xhigh' },
          ],
        }),
        model('gpt-5.5', {
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'medium' },
            { effort: 'high' },
            { effort: 'xhigh' },
          ],
        }),
      ],
    });
    expect(getCodexCatalogEfforts('gpt-5.6-sol')).toEqual([
      'low',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(getCodexCatalogEfforts('gpt-5.5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('ignores effort names outside our scale', () => {
    writeCache({
      models: [
        model('gpt-5.5', {
          supported_reasoning_levels: [
            { effort: 'low' },
            { effort: 'turbo' },
            { effort: 'high' },
          ],
        }),
      ],
    });
    expect(getCodexCatalogEfforts('gpt-5.5')).toEqual(['low', 'high']);
  });

  it('falls back to the full scale when no level is recognisable', () => {
    writeCache({
      models: [
        model('gpt-5.5', { supported_reasoning_levels: [{ effort: 'turbo' }] }),
      ],
    });
    expect(getCodexCatalogEfforts('gpt-5.5')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
  });

  it('returns undefined for a model the catalog does not list', () => {
    writeCache({ models: [model('gpt-5.5')] });
    expect(getCodexCatalogEfforts('gpt-9.9')).toBeUndefined();
  });
});

describe('getCodexModelDisplayName', () => {
  it('uses Codex’s own name when the model is in the catalog', () => {
    writeCache({
      models: [model('gpt-5.6-terra', { display_name: 'GPT-5.6-Terra' })],
    });
    expect(getCodexModelDisplayName('gpt-5.6-terra')).toBe('GPT-5.6 Terra');
  });

  it('prettifies unknown slugs instead of showing them raw', () => {
    expect(getCodexModelDisplayName('gpt-5.7-nova')).toBe('GPT-5.7 Nova');
    expect(getCodexModelDisplayName('gpt-5.5')).toBe('GPT-5.5');
  });
});
