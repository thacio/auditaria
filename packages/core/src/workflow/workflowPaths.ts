/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: On-disk layout of a project's workflow runs. Deliberately
// NOT session-scoped (research 11 §2.3): a run launched in one CLI session can
// be resumed from another, so every session resolves the same directories.
//
//   <projectTempDir>/workflows/
//     runs/<runId>/journal.jsonl        append-only resume journal
//     runs/<runId>/state.json           Claude's wf_<runId>.json shape
//     runs/<runId>/lease.json           liveness lease of the owning process
//     runs/<runId>/agents/<agentId>.jsonl (+ .meta.json)
//     runs/<runId>/children.jsonl       spawned external CLI processes
//     scripts/<slug>-<runId>.js         persisted script text
//     tasks/<taskId>.output             completion payload for the model

import * as path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

export interface WorkflowPaths {
  rootDir: string;
  runsDir: string;
  scriptsDir: string;
  tasksDir: string;
  runDir: (runId: string) => string;
  journalPath: (runId: string) => string;
  statePath: (runId: string) => string;
  leasePath: (runId: string) => string;
  agentsDir: (runId: string) => string;
  childrenPath: (runId: string) => string;
  scriptPath: (name: string, runId: string) => string;
  outputPath: (taskId: string) => string;
}

export function workflowPathsFor(rootDir: string): WorkflowPaths {
  const runsDir = path.join(rootDir, 'runs');
  const runDir = (runId: string) => path.join(runsDir, runId);
  return {
    rootDir,
    runsDir,
    scriptsDir: path.join(rootDir, 'scripts'),
    tasksDir: path.join(rootDir, 'tasks'),
    runDir,
    journalPath: (runId) => path.join(runDir(runId), 'journal.jsonl'),
    statePath: (runId) => path.join(runDir(runId), 'state.json'),
    leasePath: (runId) => path.join(runDir(runId), 'lease.json'),
    agentsDir: (runId) => path.join(runDir(runId), 'agents'),
    childrenPath: (runId) => path.join(runDir(runId), 'children.jsonl'),
    scriptPath: (name, runId) =>
      path.join(rootDir, 'scripts', `${slugify(name)}-${runId}.js`),
    outputPath: (taskId) => path.join(rootDir, 'tasks', `${taskId}.output`),
  };
}

/** Claude's run id shape: `wf_` + the first 12 characters of a uuid. */
export function newRunId(): string {
  return `wf_${randomUUID().slice(0, 12)}`;
}

export const RUN_ID_PATTERN = /^wf_[a-z0-9-]{6,}$/;

/** Task ids start with `w` (Claude uses `b` for background shells). */
export function newTaskId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(8);
  let out = 'w';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'workflow';
}
