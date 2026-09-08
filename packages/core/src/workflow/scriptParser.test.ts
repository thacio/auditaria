/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DETERMINISM_ERROR,
  META_FIRST_ERROR,
  SCRIPT_MAX_BYTES,
  WorkflowScriptError,
  parseWorkflowMeta,
  parseWorkflowScript,
} from './scriptParser.js';

const META = `export const meta = { name: 'x', description: 'y', phases: [{ title: 'A', detail: 'd', model: 'haiku' }] }`;

function expectReject(source: string, kind: string, fragment: string) {
  try {
    parseWorkflowScript(source);
  } catch (e) {
    expect(e).toBeInstanceOf(WorkflowScriptError);
    const err = e as WorkflowScriptError;
    expect(err.kind).toBe(kind);
    expect(err.message).toContain(fragment);
    return;
  }
  throw new Error(`expected rejection (${kind}) for: ${source}`);
}

describe('parseWorkflowScript — meta', () => {
  it('extracts a pure-literal meta and strips the export', () => {
    const parsed = parseWorkflowScript(`${META}\nreturn 1`);
    expect(parsed.meta).toEqual({
      name: 'x',
      description: 'y',
      phases: [{ title: 'A', detail: 'd', model: 'haiku' }],
    });
    expect(parsed.body.startsWith('const meta = {')).toBe(true);
    expect(parsed.wrapped.startsWith("(async () => { 'use strict';\n")).toBe(
      true,
    );
    expect(parsed.wrapped.endsWith('\n})()')).toBe(true);
  });

  it('allows comments before meta', () => {
    const parsed = parseWorkflowScript(`// leading comment\n${META}\nreturn 1`);
    expect(parsed.meta.name).toBe('x');
    expect(parsed.body).toContain('// leading comment');
  });

  it('accepts template literals without interpolation and negative numbers', () => {
    const parsed = parseWorkflowScript(
      "export const meta = { name: `n`, description: `d`, title: 't', whenToUse: 'w', phases: [] }\nreturn -1",
    );
    expect(parsed.meta).toEqual({
      name: 'n',
      description: 'd',
      title: 't',
      whenToUse: 'w',
      phases: [],
    });
  });

  it('rejects a script whose first statement is not the meta export', () => {
    expectReject(
      `const N = 'x'\nexport const meta = { name: N, description: 'y' }`,
      'meta',
      META_FIRST_ERROR,
    );
    expectReject('return 1', 'meta', META_FIRST_ERROR);
    expectReject(
      `export let meta = { name: 'x', description: 'y' }`,
      'meta',
      META_FIRST_ERROR,
    );
  });

  it('rejects non-literal meta values', () => {
    expectReject(
      `export const meta = { name: NAME, description: 'y' }`,
      'meta',
      'meta.name must be a pure literal',
    );
    expectReject(
      "export const meta = { name: 'x', description: 'y', phases: [...P] }",
      'meta',
      'pure literal',
    );
    expectReject(
      "export const meta = { name: 'x', description: `${1}` }",
      'meta',
      'pure literal',
    );
    expectReject(
      "export const meta = { name: 'x', description: 'y', ['k']: 1 }",
      'meta',
      'pure literal',
    );
    expectReject(
      "export const meta = { name: 'x', description: 'y', __proto__: {} }",
      'meta',
      'pure literal',
    );
  });

  it('requires non-empty name and description', () => {
    expectReject(
      `export const meta = { name: 'x' }`,
      'meta',
      'meta.description must be a non-empty string',
    );
    expectReject(
      `export const meta = { name: '', description: 'y' }`,
      'meta',
      'meta.name must be a non-empty string',
    );
    expectReject(
      `export const meta = { name: 'x', description: 3 }`,
      'meta',
      'meta.description must be a non-empty string',
    );
  });

  it('validates phases', () => {
    expectReject(
      `export const meta = { name: 'x', description: 'y', phases: 'A' }`,
      'meta',
      'meta.phases must be an array',
    );
    expectReject(
      `export const meta = { name: 'x', description: 'y', phases: [{ detail: 'd' }] }`,
      'meta',
      'meta.phases[0].title',
    );
  });
});

describe('parseWorkflowScript — parse errors', () => {
  it('reports the location, an excerpt with a caret and the plain-JS hint', () => {
    expectReject(
      `${META}\nconst = ;`,
      'parse',
      'Script parse error: Unexpected token (2:6)',
    );
    try {
      parseWorkflowScript(`${META}\nconst = ;`);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('const = ;\n      ^');
      expect(msg).toContain('Workflow scripts must be plain JavaScript');
    }
  });

  it('rejects TypeScript syntax as a parse error', () => {
    expectReject(`${META}\nconst n: number = 1`, 'parse', 'Script parse error');
  });

  it('enforces the 512 KiB cap', () => {
    const big = `${META}\nconst s = '${'x'.repeat(SCRIPT_MAX_BYTES)}'`;
    expectReject(big, 'size', 'byte limit');
  });
});

describe('parseWorkflowScript — determinism (AST, not text)', () => {
  it('rejects Date.now(), Math.random() and argless new Date()', () => {
    expectReject(
      `${META}\nconst t = Date.now()`,
      'determinism',
      DETERMINISM_ERROR,
    );
    expectReject(
      `${META}\nconst r = Math.random()`,
      'determinism',
      DETERMINISM_ERROR,
    );
    expectReject(
      `${META}\nconst d = new Date()`,
      'determinism',
      DETERMINISM_ERROR,
    );
    expectReject(`${META}\nlog(Math.random)`, 'determinism', DETERMINISM_ERROR);
  });

  it('does not flag the same text inside strings or comments, nor deterministic Date uses', () => {
    const parsed = parseWorkflowScript(
      `${META}\n// Date.now() in a comment\nconst s = "Math.random()"\nconst d = new Date(0)\nconst p = Date.parse('2020-01-01')\nreturn { s, d, p }`,
    );
    expect(parsed.meta.name).toBe('x');
  });

  it('does not flag computed member access (runtime shim covers it)', () => {
    const parsed = parseWorkflowScript(
      `${META}\nconst D = Date\nreturn D['now']`,
    );
    expect(parsed.meta.name).toBe('x');
  });
});

describe('parseWorkflowScript — forbidden syntax', () => {
  it('rejects dynamic import, with, using, extra imports/exports and reserved identifiers', () => {
    expectReject(
      `${META}\nawait import('fs')`,
      'forbidden',
      'dynamic import()',
    );
    // Module scripts are strict, so acorn itself rejects `with` at parse time.
    expectReject(
      `${META}\nwith (args) { log(x) }`,
      'parse',
      "'with' in strict mode",
    );
    expectReject(
      `${META}\nimport fs from 'fs'`,
      'forbidden',
      'import statements',
    );
    expectReject(
      `${META}\nexport const z = 1`,
      'forbidden',
      'only the first statement',
    );
    expectReject(`${META}\nconst __wRg$x = 1`, 'forbidden', 'reserved');
  });
});

describe('parseWorkflowMeta (discovery fast path)', () => {
  it('returns the meta without checking the body', () => {
    const meta = parseWorkflowMeta(`${META}\nconst t = Date.now()`);
    expect(meta.name).toBe('x');
  });

  it('still requires the meta export first', () => {
    expect(() => parseWorkflowMeta('return 1')).toThrow(META_FIRST_ERROR);
  });
});
