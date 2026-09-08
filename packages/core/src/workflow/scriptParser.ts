/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: Pre-flight parsing of a workflow script.
//
// Mirrors Claude Code's contract (research 01 §6-§8, 10 §1):
//   1. the script must parse as plain JavaScript (acorn, module goal,
//      top-level await/return allowed);
//   2. `export const meta = {...}` must be the FIRST statement and a pure
//      literal (no identifiers, calls, spreads, computed keys, methods);
//   3. meta.name / meta.description are non-empty strings, phases optional;
//   4. Date.now() / Math.random() / argless new Date() are rejected statically
//      (an AST check — string literals and comments never trigger it);
//   5. dynamic import(), `with`, `await using`, extra import/export
//      statements and `__wRg$`-prefixed identifiers are forbidden;
//   6. the body is rewritten to a strict async IIFE for the vm host.

import * as acorn from 'acorn';
import type { WorkflowMeta, WorkflowPhaseMeta } from './types.js';
import { isRecord, numberField, stringField } from './guards.js';

/** Claude Code's shared cap for inline scripts and script files (512 KiB). */
export const SCRIPT_MAX_BYTES = 524_288;

export type WorkflowScriptErrorKind =
  | 'size'
  | 'parse'
  | 'meta'
  | 'determinism'
  | 'forbidden';

export class WorkflowScriptError extends Error {
  constructor(
    message: string,
    readonly kind: WorkflowScriptErrorKind,
  ) {
    super(message);
    this.name = 'WorkflowScriptError';
  }
}

export interface ParsedWorkflowScript {
  meta: WorkflowMeta;
  /** The script with the `export` keyword stripped from the meta statement. */
  body: string;
  /** `body` wrapped as `(async () => { 'use strict'; ... })()`. */
  wrapped: string;
}

export const DETERMINISM_ERROR =
  'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.';

export const META_FIRST_ERROR =
  'Invalid workflow script: `export const meta = { name, description, phases }` must be the FIRST statement in the script';

const PARSE_HINT =
  'Workflow scripts must be plain JavaScript — common causes are TypeScript syntax (type annotations, interfaces, generics) and broken string quoting or escaping.';

const RESERVED_IDENTIFIER_PREFIX = '__wRg$';

interface AcornNode {
  type: string;
  start: number;
  end: number;
  loc?: acorn.SourceLocation | null;
  [key: string]: unknown;
}

function isNode(value: unknown): value is AcornNode {
  return isRecord(value) && stringField(value, 'type') !== undefined;
}

/** Depth-first visit of every node in an ESTree AST (acorn-walk is not a dependency). */
function walk(node: unknown, visit: (n: AcornNode) => void): void {
  if (!isNode(node)) return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visit);
    } else if (isNode(child)) {
      walk(child, visit);
    }
  }
}

function parseProgram(source: string): acorn.Program {
  try {
    return acorn.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    });
  } catch (e) {
    const record = isRecord(e) ? e : {};
    const rawMessage = (stringField(record, 'message') ?? String(e)).replace(
      / \(\d+:\d+\)$/,
      '',
    );
    const locRecord = record['loc'];
    const loc = isRecord(locRecord)
      ? {
          line: numberField(locRecord, 'line') ?? 0,
          column: numberField(locRecord, 'column') ?? 0,
        }
      : undefined;
    const where = loc ? ` (${loc.line}:${loc.column})` : '';
    let excerpt = '';
    if (loc) {
      const line = source.split('\n')[loc.line - 1] ?? '';
      excerpt = `\n\n${line}\n${' '.repeat(loc.column)}^`;
    }
    throw new WorkflowScriptError(
      `Invalid workflow script: Script parse error: ${rawMessage}${where}${excerpt}\n\n${PARSE_HINT}`,
      'parse',
    );
  }
}

/** Evaluate a pure-literal expression node; throws on anything dynamic. */
function evalPureLiteral(node: unknown, path: string): unknown {
  const bad = () =>
    new WorkflowScriptError(
      `Invalid workflow script: ${path} must be a pure literal — no variables, function calls, spreads, computed keys or methods`,
      'meta',
    );
  if (!isNode(node)) throw bad();
  switch (node.type) {
    case 'Literal':
      return node['value'];
    case 'TemplateLiteral': {
      const expressions = node['expressions'];
      if (Array.isArray(expressions) && expressions.length > 0) throw bad();
      const quasis = node['quasis'];
      if (!Array.isArray(quasis)) throw bad();
      return quasis
        .map((q) => {
          const value = isRecord(q) ? q['value'] : undefined;
          return isRecord(value) ? (stringField(value, 'cooked') ?? '') : '';
        })
        .join('');
    }
    case 'UnaryExpression': {
      const argument = node['argument'];
      const literal =
        isNode(argument) && argument.type === 'Literal'
          ? argument['value']
          : undefined;
      if (node['operator'] === '-' && typeof literal === 'number')
        return -literal;
      throw bad();
    }
    case 'ArrayExpression': {
      const elements = node['elements'];
      if (!Array.isArray(elements)) throw bad();
      return elements.map((el, i) => evalPureLiteral(el, `${path}[${i}]`));
    }
    case 'ObjectExpression': {
      const properties = node['properties'];
      if (!Array.isArray(properties)) throw bad();
      const out: Record<string, unknown> = {};
      for (const prop of properties) {
        if (
          !isNode(prop) ||
          prop.type !== 'Property' ||
          prop['computed'] === true ||
          prop['kind'] !== 'init' ||
          prop['method'] === true
        ) {
          throw bad();
        }
        const keyNode = prop['key'];
        let key: string | null = null;
        if (isNode(keyNode)) {
          if (keyNode.type === 'Identifier') key = String(keyNode['name']);
          else if (keyNode.type === 'Literal') key = String(keyNode['value']);
        }
        if (
          key === null ||
          key === '__proto__' ||
          key === 'constructor' ||
          key === 'prototype'
        ) {
          throw bad();
        }
        out[key] = evalPureLiteral(prop['value'], `${path}.${key}`);
      }
      return out;
    }
    default:
      throw bad();
  }
}

function isMetaStatement(node: unknown): node is AcornNode & {
  declaration: AcornNode & { declarations: AcornNode[] };
} {
  if (!isNode(node) || node.type !== 'ExportNamedDeclaration') return false;
  const declaration = node['declaration'];
  if (!isNode(declaration) || declaration.type !== 'VariableDeclaration')
    return false;
  if (declaration['kind'] !== 'const') return false;
  const declarations = declaration['declarations'];
  if (!Array.isArray(declarations) || declarations.length !== 1) return false;
  const first: unknown = declarations[0];
  const id = isRecord(first) ? first['id'] : undefined;
  return isNode(id) && id.type === 'Identifier' && id['name'] === 'meta';
}

function validateMeta(raw: unknown): WorkflowMeta {
  const fail = (msg: string) =>
    new WorkflowScriptError(`Invalid workflow script: ${msg}`, 'meta');
  if (!isRecord(raw)) {
    throw fail('meta must be an object literal');
  }
  const obj = raw;
  const name = obj['name'];
  if (typeof name !== 'string' || name.trim() === '') {
    throw fail('meta.name must be a non-empty string');
  }
  const description = obj['description'];
  if (typeof description !== 'string' || description.trim() === '') {
    throw fail('meta.description must be a non-empty string');
  }
  const meta: WorkflowMeta = {
    name: name.trim(),
    description: description.trim(),
  };
  const title = obj['title'];
  if (title !== undefined) {
    if (typeof title !== 'string') throw fail('meta.title must be a string');
    meta.title = title;
  }
  const whenToUse = obj['whenToUse'];
  if (whenToUse !== undefined) {
    if (typeof whenToUse !== 'string')
      throw fail('meta.whenToUse must be a string');
    meta.whenToUse = whenToUse;
  }
  const phases = obj['phases'];
  if (phases !== undefined) {
    if (!Array.isArray(phases)) {
      throw fail(
        'meta.phases must be an array of { title, detail?, model? } objects',
      );
    }
    meta.phases = phases.map((p: unknown, i): WorkflowPhaseMeta => {
      if (!isRecord(p)) {
        throw fail(`meta.phases[${i}] must be an object with a string title`);
      }
      const phaseTitle = p['title'];
      if (typeof phaseTitle !== 'string' || phaseTitle.trim() === '') {
        throw fail(`meta.phases[${i}].title must be a non-empty string`);
      }
      const out: WorkflowPhaseMeta = { title: phaseTitle };
      const detail = p['detail'];
      if (detail !== undefined) {
        if (typeof detail !== 'string')
          throw fail(`meta.phases[${i}].detail must be a string`);
        out.detail = detail;
      }
      const model = p['model'];
      if (model !== undefined) {
        if (typeof model !== 'string')
          throw fail(`meta.phases[${i}].model must be a string`);
        out.model = model;
      }
      return out;
    });
  }
  return meta;
}

function checkBodyRules(program: acorn.Program): void {
  const forbid = (msg: string) =>
    new WorkflowScriptError(`Invalid workflow script: ${msg}`, 'forbidden');
  program.body.forEach((stmt, i) => {
    if (i === 0) return;
    const t = stmt.type;
    if (t === 'ImportDeclaration') {
      throw forbid('import statements are not available in workflow scripts');
    }
    if (t.startsWith('Export')) {
      throw forbid(
        'only the first statement (`export const meta`) may be an export',
      );
    }
  });
  walk(program, (n) => {
    switch (n.type) {
      case 'MemberExpression': {
        if (n['computed'] === true) return;
        const object = n['object'];
        const property = n['property'];
        if (!isNode(object) || !isNode(property)) return;
        if (object.type !== 'Identifier' || property.type !== 'Identifier')
          return;
        const o = object['name'];
        const p = property['name'];
        if ((o === 'Date' && p === 'now') || (o === 'Math' && p === 'random')) {
          throw new WorkflowScriptError(DETERMINISM_ERROR, 'determinism');
        }
        return;
      }
      case 'NewExpression': {
        const callee = n['callee'];
        const args = n['arguments'];
        if (
          isNode(callee) &&
          callee.type === 'Identifier' &&
          callee['name'] === 'Date' &&
          Array.isArray(args) &&
          args.length === 0
        ) {
          throw new WorkflowScriptError(DETERMINISM_ERROR, 'determinism');
        }
        return;
      }
      case 'ImportExpression':
        throw forbid('dynamic import() is not available in workflow scripts');
      case 'WithStatement':
        throw forbid('`with` statements are not available in workflow scripts');
      case 'VariableDeclaration':
        if (n['kind'] === 'await using' || n['kind'] === 'using') {
          throw forbid(
            '`using` declarations are not available in workflow scripts',
          );
        }
        return;
      case 'Identifier': {
        const name = n['name'];
        if (
          typeof name === 'string' &&
          name.startsWith(RESERVED_IDENTIFIER_PREFIX)
        ) {
          throw forbid(
            `identifiers starting with ${RESERVED_IDENTIFIER_PREFIX} are reserved by the workflow host`,
          );
        }
        return;
      }
      default:
        return;
    }
  });
}

/**
 * Full pre-flight: parse, validate meta, check body rules, build the wrapped
 * source. Throws {@link WorkflowScriptError}.
 */
export function parseWorkflowScript(source: string): ParsedWorkflowScript {
  if (Buffer.byteLength(source, 'utf8') > SCRIPT_MAX_BYTES) {
    throw new WorkflowScriptError(
      `Invalid workflow script: script exceeds the ${SCRIPT_MAX_BYTES} byte limit`,
      'size',
    );
  }
  const program = parseProgram(source);
  const first = program.body[0];
  if (!isMetaStatement(first)) {
    throw new WorkflowScriptError(META_FIRST_ERROR, 'meta');
  }
  const init = first.declaration.declarations[0]['init'];
  const meta = validateMeta(evalPureLiteral(init, 'meta'));
  checkBodyRules(program);
  const body =
    source.slice(0, first.start) + source.slice(first.declaration.start);
  const wrapped = `(async () => { 'use strict';\n${body}\n})()`;
  return { meta, body, wrapped };
}

/**
 * Discovery-time fast path: only the meta literal is extracted and validated;
 * the body is not checked. Throws {@link WorkflowScriptError}.
 */
export function parseWorkflowMeta(source: string): WorkflowMeta {
  const program = parseProgram(source);
  const first = program.body[0];
  if (!isMetaStatement(first)) {
    throw new WorkflowScriptError(META_FIRST_ERROR, 'meta');
  }
  return validateMeta(
    evalPureLiteral(first.declaration.declarations[0]['init'], 'meta'),
  );
}
