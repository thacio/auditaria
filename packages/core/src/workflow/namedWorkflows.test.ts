/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GeminiCLIExtension } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { listNamedWorkflows, resolveNamedWorkflow } from './namedWorkflows.js';

const tempPrefix = path.join(os.tmpdir(), 'wf-discovery-test-');
let directory: string;
let userConfigDir: string;

beforeEach(() => {
  directory = fs.mkdtempSync(tempPrefix);
  userConfigDir = path.join(directory, 'user', '.auditaria');
  vi.spyOn(Storage, 'getGlobalGeminiDir').mockReturnValue(userConfigDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(directory).startsWith(path.resolve(tempPrefix))) {
    throw new Error('Unexpected discovery test directory');
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeWorkflow(
  base: string,
  name: string,
  description: string,
): string {
  fs.mkdirSync(base, { recursive: true });
  const file = path.join(base, `${name}.js`);
  fs.writeFileSync(
    file,
    `export const meta = ${JSON.stringify({ name, description })};\nreturn 1;`,
  );
  return file;
}

function configAt(cwd: string, extensions: GeminiCLIExtension[] = []) {
  fs.mkdirSync(cwd, { recursive: true });
  const config = makeFakeConfig({ targetDir: cwd, cwd });
  vi.spyOn(config, 'getExtensions').mockReturnValue(extensions);
  return config;
}

function extension(name: string, isActive = true): GeminiCLIExtension {
  return {
    name,
    version: '1.0.0',
    isActive,
    path: path.join(directory, 'extensions', name),
    contextFiles: [],
    id: name,
  };
}

describe('named workflow discovery', () => {
  it('finds ancestors up to the Git root, with the closest workflow winning', () => {
    const checkout = path.join(directory, 'checkout');
    const cwd = path.join(checkout, 'packages', 'nested');
    fs.mkdirSync(path.join(checkout, '.git'), { recursive: true });
    writeWorkflow(
      path.join(directory, '.auditaria', 'workflows'),
      'outside',
      'must not cross checkout boundary',
    );
    writeWorkflow(
      path.join(checkout, '.auditaria', 'workflows'),
      'shared',
      'root copy',
    );
    writeWorkflow(
      path.join(checkout, '.auditaria', 'workflows'),
      'root-only',
      'ancestor workflow',
    );
    const closest = writeWorkflow(
      path.join(cwd, '.gemini', 'workflows'),
      'shared',
      'closest legacy copy',
    );
    const config = configAt(cwd);
    const workflows = listNamedWorkflows(config);

    expect(workflows.find((item) => item.name === 'shared')?.filePath).toBe(
      closest,
    );
    expect(workflows.find((item) => item.name === 'root-only')?.source).toBe(
      'project',
    );
    expect(workflows.some((item) => item.name === 'outside')).toBe(false);
  });

  it('uses the primary config directory first and still loads legacy-only files', () => {
    const cwd = path.join(directory, 'project');
    writeWorkflow(path.join(cwd, '.gemini', 'workflows'), 'both', 'legacy');
    writeWorkflow(
      path.join(cwd, '.gemini', 'workflows'),
      'legacy-only',
      'legacy',
    );
    const primary = writeWorkflow(
      path.join(cwd, '.auditaria', 'workflows'),
      'both',
      'primary',
    );
    const config = configAt(cwd);

    expect(resolveNamedWorkflow(config, 'both')?.filePath).toBe(primary);
    expect(resolveNamedWorkflow(config, 'legacy-only')?.meta.description).toBe(
      'legacy',
    );
  });

  it('treats a worktree .git file as the nearest project boundary', () => {
    const outer = path.join(directory, 'outer');
    const worktree = path.join(outer, 'worktree');
    const cwd = path.join(worktree, 'nested');
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(
      path.join(worktree, '.git'),
      'gitdir: ../.git/worktrees/test',
    );
    writeWorkflow(
      path.join(outer, '.auditaria', 'workflows'),
      'outer-only',
      'outside worktree',
    );
    writeWorkflow(
      path.join(worktree, '.auditaria', 'workflows'),
      'worktree-only',
      'inside worktree',
    );
    const config = configAt(cwd);

    expect(resolveNamedWorkflow(config, 'worktree-only')).toBeDefined();
    expect(resolveNamedWorkflow(config, 'outer-only')).toBeUndefined();
  });

  it('does not inherit arbitrary parent workflows outside Git', () => {
    const cwd = path.join(directory, 'parent', 'nested');
    writeWorkflow(
      path.join(directory, 'parent', '.auditaria', 'workflows'),
      'parent-only',
      'not a project ancestor',
    );
    writeWorkflow(
      path.join(cwd, '.auditaria', 'workflows'),
      'local-only',
      'current directory',
    );
    const config = configAt(cwd);

    expect(resolveNamedWorkflow(config, 'local-only')).toBeDefined();
    expect(resolveNamedWorkflow(config, 'parent-only')).toBeUndefined();
  });

  it('loads only active extensions and applies project, user, extension, builtin precedence', () => {
    const cwd = path.join(directory, 'project');
    const active = extension('research-tools');
    const inactive = extension('disabled-tools', false);
    const activeDir = path.join(active.path, 'workflows');
    const userDir = path.join(userConfigDir, 'workflows');
    const projectDir = path.join(cwd, '.auditaria', 'workflows');
    writeWorkflow(
      path.join(inactive.path, 'workflows'),
      'disabled-only',
      'disabled',
    );
    writeWorkflow(activeDir, 'extension-only', 'extension contribution');
    writeWorkflow(activeDir, 'user-wins', 'extension');
    writeWorkflow(userDir, 'user-wins', 'user');
    writeWorkflow(activeDir, 'project-wins', 'extension');
    writeWorkflow(userDir, 'project-wins', 'user');
    writeWorkflow(projectDir, 'project-wins', 'project');
    writeWorkflow(activeDir, 'deep-research', 'extension replaces builtin');
    const config = configAt(cwd, [inactive, active]);

    expect(resolveNamedWorkflow(config, 'disabled-only')).toBeUndefined();
    expect(resolveNamedWorkflow(config, 'extension-only')?.source).toBe(
      active.name,
    );
    expect(resolveNamedWorkflow(config, 'user-wins')?.source).toBe('user');
    expect(resolveNamedWorkflow(config, 'project-wins')?.source).toBe(
      'project',
    );
    expect(resolveNamedWorkflow(config, 'deep-research')).toMatchObject({
      source: active.name,
      meta: { description: 'extension replaces builtin' },
    });
  });

  it('keeps a working lower-precedence copy when a local override cannot parse', () => {
    const cwd = path.join(directory, 'project');
    const projectDir = path.join(cwd, '.auditaria', 'workflows');
    const file = writeWorkflow(projectDir, 'deep-research', 'invalid override');
    fs.appendFileSync(file, '\nconst broken = ;');

    expect(resolveNamedWorkflow(configAt(cwd), 'deep-research')?.source).toBe(
      'builtin',
    );
  });
});
