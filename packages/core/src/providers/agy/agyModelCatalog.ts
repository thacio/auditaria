/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_AGY_PROVIDER: live Antigravity model list.
 *
 * `agy models` prints the catalog the CLI serves today, one per line:
 *   `<id>\t<display name>` (e.g. `gemini-3.8-flash-low\tGemini 3.8 Flash (Low)`).
 * The list changes with agy releases (3.5 Flash disappeared, 3.8 appeared),
 * so the `/model` menu and `external_agent_session` read it from a cache at
 * `~/.auditaria/agy-models.json`, refreshed in the background (throttled,
 * shell-free spawn). The static `AGY_MODEL_IDS` table is the offline fallback.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAgyExecutable } from './agyCLIDriver.js';

export interface AgyModelEntry {
  id: string;
  displayName: string;
}

export const AGY_MODELS_REFRESH_MIN_INTERVAL_MS = 6 * 60 * 60_000;
const CACHE_PATH = join(homedir(), '.auditaria', 'agy-models.json');
const LIST_TIMEOUT_MS = 30_000;

let memo: { mtime: number; models: AgyModelEntry[] } | undefined;
let lastAttemptAt = 0;
let inFlight: Promise<AgyModelEntry[] | null> | null = null;

function isAgyModelEntry(v: unknown): v is AgyModelEntry {
  if (typeof v !== 'object' || v === null) return false;
  const r: Record<string, unknown> = { ...v };
  const id = r['id'];
  const displayName = r['displayName'];
  return typeof id === 'string' && typeof displayName === 'string';
}

/** Parse `agy models` output. Exported for tests. */
export function parseAgyModelsOutput(text: string): AgyModelEntry[] {
  const out: AgyModelEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9][a-z0-9.-]*)\t(.+)$/i.exec(line.trim());
    if (m) out.push({ id: m[1], displayName: m[2].trim() });
  }
  return out;
}

/** The cached live list, or undefined when nothing was fetched yet. */
export function getCachedAgyModels(): AgyModelEntry[] | undefined {
  try {
    const mtime = statSync(CACHE_PATH).mtimeMs;
    if (memo && memo.mtime === mtime) return memo.models;
    const parsed: unknown = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    const models = Array.isArray(parsed) ? parsed.filter(isAgyModelEntry) : [];
    memo = { mtime, models };
    return models.length ? models : undefined;
  } catch {
    return undefined;
  }
}

/** Refresh the cache from `agy models` (throttled unless forced). */
export function refreshAgyModelsCache(
  force = false,
): Promise<AgyModelEntry[] | null> {
  if (inFlight) return inFlight;
  if (
    !force &&
    Date.now() - lastAttemptAt < AGY_MODELS_REFRESH_MIN_INTERVAL_MS
  ) {
    return Promise.resolve(null);
  }
  lastAttemptAt = Date.now();
  inFlight = runList().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function runList(): Promise<AgyModelEntry[] | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveAgyExecutable(), ['models'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    let settled = false;
    const finish = (models: AgyModelEntry[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (models?.length) {
        try {
          mkdirSync(join(homedir(), '.auditaria'), { recursive: true });
          writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2), 'utf8');
        } catch {
          /* cache is best-effort */
        }
      }
      resolve(models?.length ? models : null);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(null);
    }, LIST_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('exit', () => finish(parseAgyModelsOutput(out)));
  });
}
