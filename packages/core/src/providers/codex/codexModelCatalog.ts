/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_CODEX_PROVIDER: Dynamic Codex model catalog.
//
// The Codex CLI keeps its own model list in `models_cache.json` under
// `$CODEX_HOME` (default `~/.codex`), which it refreshes from OpenAI on its
// own schedule. Reading that file means the `/model` menu — CLI and web —
// tracks whatever the user's Codex install actually offers (ids, display
// names, descriptions, per-model reasoning tiers) instead of drifting until
// somebody hand-edits the static tables in `../types.ts`. Same idea as the
// Copilot model cache, minus the ACP handshake: Codex already wrote the file.
//
// Everything here is best-effort. A missing, unreadable, or unrecognisable
// file returns `undefined` so callers keep their static fallback.
//
// NOTE: the effort union is imported TYPE-ONLY. `../types.ts` imports this
// module at runtime, so a value import would close an ESM cycle.

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CodexReasoningEffort } from '../types.js';

/** One user-selectable model, as Codex itself describes it. */
export interface CodexCatalogModel {
  /** Codex model slug, e.g. `gpt-5.6-sol` — the value passed to `--model`. */
  slug: string;
  /** Codex's own `display_name`, normalised to our spacing ("GPT-5.6 Sol"). */
  displayName: string;
  /** Codex's own one-line description. Empty when it publishes none. */
  description: string;
  /** Supported reasoning tiers, ascending (clamping relies on that order). */
  efforts: readonly CodexReasoningEffort[];
}

// Ascending effort scale. `satisfies` ties it to the union in ../types.ts, so
// this fails to compile if that scale ever changes without updating this one.
const EFFORT_ORDER = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly CodexReasoningEffort[];

/** Re-stat the cache file at most this often (menus call in render loops). */
const STAT_THROTTLE_MS = 5_000;

let cachedModels: CodexCatalogModel[] | undefined;
let cachedFileKey: string | null = null;
let lastStatAt = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `$CODEX_HOME/models_cache.json`, falling back to `~/.codex`. */
function modelsCachePath(): string {
  const codexHome = process.env['CODEX_HOME'];
  return join(
    codexHome && codexHome.trim() ? codexHome : join(homedir(), '.codex'),
    'models_cache.json',
  );
}

/**
 * Codex writes `display_name` as "GPT-5.6-Sol"; every other model name in our
 * UI (and in Copilot's own list) spaces the variant off: "GPT-5.6 Sol".
 */
function normaliseDisplayName(name: string): string {
  return name.replace(/(\d)-(?=[A-Za-z])/g, '$1 ');
}

/** Title-case a slug for models the catalog can't name, e.g. `gpt-5.7` → `GPT-5.7`. */
function prettifySlug(slug: string): string {
  return slug
    .split('-')
    .map((part) => {
      if (/^\d/.test(part)) return part;
      if (part.toLowerCase() === 'gpt') return 'GPT';
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ')
    .replace(/^GPT\s/, 'GPT-');
}

/** Ascending, de-duplicated efforts from one `supported_reasoning_levels`. */
function parseEfforts(raw: unknown): readonly CodexReasoningEffort[] {
  if (!Array.isArray(raw)) return EFFORT_ORDER;
  const found = new Set<string>();
  for (const level of raw) {
    if (!isRecord(level)) continue;
    const effort = level['effort'];
    if (typeof effort === 'string') found.add(effort);
  }
  const efforts = EFFORT_ORDER.filter((effort) => found.has(effort));
  // A model whose levels we recognise none of is more likely a schema change
  // than a model with no reasoning control — fall back to the full scale.
  return efforts.length > 0 ? efforts : EFFORT_ORDER;
}

/** Parse the `models` array, keeping only what Codex shows in its own picker. */
function parseModels(raw: unknown): CodexCatalogModel[] | undefined {
  if (!isRecord(raw)) return undefined;
  const models = raw['models'];
  if (!Array.isArray(models)) return undefined;

  const parsed: Array<{ model: CodexCatalogModel; priority: number }> = [];
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    // `visibility: "hide"` covers Codex's internal models (auto-review etc).
    if (entry['visibility'] !== 'list') continue;
    const slug = entry['slug'];
    if (typeof slug !== 'string' || !slug) continue;
    // `auto` is our own synthetic entry ("don't pass --model"); skip it if
    // Codex ever ships one of its own, so the menu can't show it twice.
    if (slug === 'auto') continue;

    const displayName = entry['display_name'];
    const description = entry['description'];
    const priority = entry['priority'];
    parsed.push({
      model: {
        slug,
        displayName:
          typeof displayName === 'string' && displayName
            ? normaliseDisplayName(displayName)
            : prettifySlug(slug),
        description: typeof description === 'string' ? description : '',
        efforts: parseEfforts(entry['supported_reasoning_levels']),
      },
      priority:
        typeof priority === 'number' ? priority : Number.MAX_SAFE_INTEGER,
    });
  }

  if (parsed.length === 0) return undefined;
  // Codex orders its own picker by `priority` ascending; file order already
  // matches, so this only guards against a reshuffled cache.
  parsed.sort((a, b) => a.priority - b.priority);
  return parsed.map((entry) => entry.model);
}

/**
 * The user's current Codex models, or `undefined` when the cache file is
 * missing/unusable. Result is memoised until the file's mtime or size changes.
 */
export function getCodexCatalogModels(): CodexCatalogModel[] | undefined {
  const now = Date.now();
  if (cachedFileKey !== null && now - lastStatAt < STAT_THROTTLE_MS) {
    return cachedModels;
  }
  lastStatAt = now;

  const path = modelsCachePath();
  let fileKey: string;
  try {
    const stat = statSync(path);
    fileKey = `${path}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    cachedFileKey = 'missing';
    cachedModels = undefined;
    return undefined;
  }

  if (fileKey === cachedFileKey) return cachedModels;

  cachedFileKey = fileKey;
  try {
    cachedModels = parseModels(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    cachedModels = undefined; // corrupt or mid-write — callers fall back
  }
  return cachedModels;
}

/** Model ids Codex currently offers, or `undefined` to use the static list. */
export function getCodexCatalogModelIds(): string[] | undefined {
  return getCodexCatalogModels()?.map((model) => model.slug);
}

/** Reasoning tiers for one model, or `undefined` when the catalog has no say. */
export function getCodexCatalogEfforts(
  model: string,
): readonly CodexReasoningEffort[] | undefined {
  return getCodexCatalogModels()?.find((entry) => entry.slug === model)
    ?.efforts;
}

/** Display name for a model id — Codex's own when known, prettified otherwise. */
export function getCodexModelDisplayName(model: string): string {
  const known = getCodexCatalogModels()?.find((entry) => entry.slug === model);
  return known?.displayName ?? prettifySlug(model);
}

/** Test seam: drop the memoised catalog (e.g. after changing `CODEX_HOME`). */
export function resetCodexCatalogCache(): void {
  cachedModels = undefined;
  cachedFileKey = null;
  lastStatAt = 0;
}
