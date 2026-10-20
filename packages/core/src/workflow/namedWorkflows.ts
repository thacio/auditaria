/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Saved / named workflows. Precedence (highest wins):
//   project  <closest .auditaria/workflows/ ancestor of cwd>/*.js
//   user     ~/.auditaria/workflows/*.js
//   extension <active-extension>/workflows/*.js
//   built-in registered in-process (deep-research)
// Only `.js` files are considered. Discovery validates the complete script,
// so an invalid override never hides a valid lower-precedence definition.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { findGitRoot } from '../utils/gitUtils.js';
import { getConfigDirFallbacks, normalizePath } from '../utils/paths.js';
import { parseWorkflowMeta, SCRIPT_MAX_BYTES } from './scriptParser.js';
import type { WorkflowMeta } from './types.js';
import { BUILTIN_WORKFLOWS } from './builtin/index.js';

export interface NamedWorkflow {
  name: string;
  meta: WorkflowMeta;
  /** 'project' | 'user' | 'builtin' | an extension name */
  source: string;
  script: string;
  filePath?: string;
}

export const WORKFLOWS_DIR_NAME = 'workflows';

function readDir(dir: string, source: string): NamedWorkflow[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: NamedWorkflow[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.js')) continue;
    const filePath = path.join(dir, entry);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) continue;
      const script = fs.readFileSync(filePath, 'utf8');
      const meta = parseWorkflowMeta(script);
      out.push({ name: meta.name, meta, source, script, filePath });
    } catch {
      // An unparseable override never wins; it is simply skipped.
    }
  }
  return out;
}

/** Search closest first, bounded by this checkout (or cwd outside Git). */
function projectWorkflowDirs(config: Config): string[] {
  const dirs: string[] = [];
  let current = path.resolve(config.getTargetDir());
  const root = normalizePath(findGitRoot(current) ?? current);
  for (;;) {
    for (const configDir of getConfigDirFallbacks())
      dirs.push(path.join(current, configDir, WORKFLOWS_DIR_NAME));
    if (normalizePath(current) === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** Every named workflow visible to this config, higher precedence first per name. */
export function listNamedWorkflows(config: Config): NamedWorkflow[] {
  const byName = new Map<string, NamedWorkflow>();
  const add = (list: NamedWorkflow[]) => {
    for (const w of list) if (!byName.has(w.name)) byName.set(w.name, w);
  };
  for (const dir of projectWorkflowDirs(config)) add(readDir(dir, 'project'));
  add(
    readDir(
      path.join(Storage.getGlobalGeminiDir(), WORKFLOWS_DIR_NAME),
      'user',
    ),
  );
  for (const extension of config.getExtensions?.() ?? []) {
    if (extension.isActive)
      add(
        readDir(path.join(extension.path, WORKFLOWS_DIR_NAME), extension.name),
      );
  }
  add(
    BUILTIN_WORKFLOWS.map((b) => ({
      name: b.meta.name,
      meta: b.meta,
      source: 'builtin',
      script: b.script,
    })),
  );
  return [...byName.values()];
}

export function resolveNamedWorkflow(
  config: Config,
  name: string,
): NamedWorkflow | undefined {
  return listNamedWorkflows(config).find((w) => w.name === name);
}

/** Directory a run's script is saved to by `/workflows save`. */
export function savedWorkflowDir(
  config: Config,
  scope: 'project' | 'user',
): string {
  return scope === 'project'
    ? path.join(config.storage.getGeminiDir(), WORKFLOWS_DIR_NAME)
    : path.join(Storage.getGlobalGeminiDir(), WORKFLOWS_DIR_NAME);
}
