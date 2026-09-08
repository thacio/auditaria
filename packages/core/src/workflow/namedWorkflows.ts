/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Saved / named workflows. Precedence (highest wins):
//   project  <closest .auditaria/workflows/ ancestor of cwd>/*.js
//   user     ~/.auditaria/workflows/*.js
//   built-in registered in-process (deep-research)
// Only `.js` files are considered; discovery parses the meta header only and
// an override wins only if its own script parses.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
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

/** Walk from cwd to the filesystem root collecting `.auditaria/workflows` dirs (closest first). */
function projectWorkflowDirs(config: Config): string[] {
  const dirs: string[] = [];
  const geminiDirName = path.basename(config.storage.getGeminiDir());
  let current = path.resolve(config.getTargetDir());
  const root = path.resolve(config.getProjectRoot());
  for (;;) {
    dirs.push(path.join(current, geminiDirName, WORKFLOWS_DIR_NAME));
    if (current === root) break;
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
