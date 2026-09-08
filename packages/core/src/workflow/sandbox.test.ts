/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DATE_NOW_ERROR,
  IMPORT_ERROR,
  MATH_RANDOM_ERROR,
  assertBoundaryArray,
  boundaryArrayError,
  createWorkflowSandbox,
  marshalResult,
  type WorkflowSandboxHooks,
} from './sandbox.js';
import { parseWorkflowScript } from './scriptParser.js';

const META = `export const meta = { name: 'x', description: 'y' }`;

function makeHooks(overrides: Partial<WorkflowSandboxHooks> = {}): {
  hooks: WorkflowSandboxHooks;
  logs: string[];
} {
  const logs: string[] = [];
  const hooks: WorkflowSandboxHooks = {
    agent: async (prompt) => `echo:${String(prompt)}`,
    parallel: async (thunks) =>
      Promise.all((thunks as Array<() => unknown>).map((t) => t())),
    pipeline: async (items) => items as unknown[],
    phase: () => {},
    log: (m) => {
      logs.push(String(m));
    },
    workflow: async () => null,
    args: undefined,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    ...overrides,
  };
  return { hooks, logs };
}

async function runScript(body: string, hooks?: WorkflowSandboxHooks) {
  const { wrapped } = parseWorkflowScript(`${META}\n${body}`);
  const sandbox = createWorkflowSandbox(hooks ?? makeHooks().hooks);
  try {
    return await sandbox.run(wrapped);
  } finally {
    sandbox.dispose();
  }
}

describe('createWorkflowSandbox — globals', () => {
  it('exposes exactly the hook globals plus pruned ECMAScript intrinsics', async () => {
    const names = (await runScript(
      'return Object.getOwnPropertyNames(globalThis).sort()',
    )) as string[];
    for (const g of [
      'agent',
      'args',
      'budget',
      'clearTimeout',
      'console',
      'log',
      'parallel',
      'phase',
      'pipeline',
      'setTimeout',
      'workflow',
      'Date',
      'Math',
      'JSON',
      'Promise',
      'Error',
    ]) {
      expect(names).toContain(g);
    }
    for (const g of [
      'process',
      'require',
      'fetch',
      'Buffer',
      'URL',
      'TextEncoder',
      'crypto',
      'structuredClone',
      'queueMicrotask',
      'performance',
      'setInterval',
      'WebAssembly',
      'SharedArrayBuffer',
      'Atomics',
      'FinalizationRegistry',
      'WeakRef',
    ]) {
      expect(names).not.toContain(g);
    }
  });

  it('passes args through and lets the script see meta as a local const', async () => {
    const { hooks } = makeHooks({ args: ['a', { k: 1 }] });
    expect(
      await runScript('return { args, metaName: meta.name }', hooks),
    ).toEqual({
      args: ['a', { k: 1 }],
      metaName: 'x',
    });
  });
});

describe('createWorkflowSandbox — code generation and imports', () => {
  it('blocks eval, new Function and the prototype-constructor escape', async () => {
    const out = (await runScript(`
      const notes = {}
      try { eval('1') } catch (e) { notes.eval = e.message }
      try { new Function('return 1')() } catch (e) { notes.fn = e.message }
      try { Object.getPrototypeOf(function(){}).constructor('return typeof process')() } catch (e) { notes.proto = e.message }
      return notes`)) as Record<string, string>;
    for (const k of ['eval', 'fn', 'proto']) {
      expect(out[k]).toContain(
        'Code generation from strings disallowed for this context',
      );
    }
  });

  it('rejects dynamic import at runtime (Node refuses it before or via our callback)', async () => {
    // import() is rejected statically by the parser; this exercises the vm
    // layer directly. Node without --experimental-vm-modules throws its own
    // error before invoking importModuleDynamically; either way the script
    // cannot load a module.
    const sandbox = createWorkflowSandbox(makeHooks().hooks);
    await expect(
      sandbox.run(`(async () => { await import('fs') })()`),
    ).rejects.toThrow(new RegExp(`${IMPORT_ERROR}|experimental-vm-module`));
    sandbox.dispose();
  });
});

describe('createWorkflowSandbox — determinism shims', () => {
  it('throws through aliases for Date.now, new Date() and Math.random', async () => {
    const out = (await runScript(`
      const D = Date, M = Math, D2 = D
      const notes = {}
      try { D.now() } catch (e) { notes.now = e.message }
      try { new D2() } catch (e) { notes.newDate = e.message }
      try { D() } catch (e) { notes.callDate = e.message }
      try { M.random() } catch (e) { notes.random = e.message }
      notes.date0 = new D(0).toISOString()
      notes.parse = D.parse('2020-01-01')
      notes.utc = D.UTC(2020, 0, 1)
      notes.floor = M.floor(2.5)
      notes.isDate = new D(5) instanceof Date
      notes.ctorName = Date.name
      return notes`)) as Record<string, unknown>;
    expect(out['now']).toBe(DATE_NOW_ERROR);
    expect(out['newDate']).toBe(DATE_NOW_ERROR);
    expect(out['callDate']).toBe(DATE_NOW_ERROR);
    expect(out['random']).toBe(MATH_RANDOM_ERROR);
    expect(out['date0']).toBe('1970-01-01T00:00:00.000Z');
    expect(out['parse']).toBe(1577836800000);
    expect(out['utc']).toBe(1577836800000);
    expect(out['floor']).toBe(2);
    expect(out['isDate']).toBe(true);
    expect(out['ctorName']).toBe('Date');
  });
});

describe('createWorkflowSandbox — timers, errors, results', () => {
  it('supports setTimeout/clearTimeout and disposes pending timers', async () => {
    const sandbox = createWorkflowSandbox(makeHooks().hooks);
    const { wrapped } = parseWorkflowScript(
      `${META}\nconst h = setTimeout(() => {}, 100000)\nclearTimeout(h)\nreturn await new Promise((r) => setTimeout(() => r('fired'), 5))`,
    );
    expect(await sandbox.run(wrapped)).toBe('fired');
    sandbox.dispose();
  });

  it('builds realm-correct errors so instanceof Error holds inside the script', async () => {
    const { hooks } = makeHooks();
    const holder: { sandbox?: ReturnType<typeof createWorkflowSandbox> } = {};
    hooks.agent = async () => {
      throw holder.sandbox!.makeError('TypeError', 'boom');
    };
    const sandboxRef = createWorkflowSandbox(hooks);
    holder.sandbox = sandboxRef;
    const { wrapped } = parseWorkflowScript(
      `${META}\ntry { await agent('x') } catch (e) { return { isError: e instanceof Error, isType: e instanceof TypeError, msg: e.message } }`,
    );
    expect(await sandboxRef.run(wrapped)).toEqual({
      isError: true,
      isType: true,
      msg: 'boom',
    });
    sandboxRef.dispose();
  });

  it('awaits host-realm promises returned by hooks', async () => {
    expect(await runScript("return await agent('ping')")).toBe('echo:ping');
  });

  it('propagates uncaught script errors as rejections with workflow.js in the stack', async () => {
    const sandbox = createWorkflowSandbox(makeHooks().hooks);
    const { wrapped } = parseWorkflowScript(
      `${META}\nthrow new Error('blew up')`,
    );
    await expect(sandbox.run(wrapped)).rejects.toMatchObject({
      message: 'blew up',
    });
    try {
      await sandbox.run(wrapped);
    } catch (e) {
      expect(String((e as Error).stack)).toContain('workflow.js');
    }
    sandbox.dispose();
  });

  it('routes console.* to log()', async () => {
    const { hooks, logs } = makeHooks();
    await runScript("console.log('a', 1, null, {b:1})", hooks);
    expect(logs).toEqual(['a 1 null [object]']);
  });

  it('aborts pathological synchronous code via the sync timeout', async () => {
    const sandbox = createWorkflowSandbox(makeHooks().hooks, {
      syncTimeoutMs: 50,
    });
    const { wrapped } = parseWorkflowScript(`${META}\nwhile (true) {}`);
    await expect(sandbox.run(wrapped)).rejects.toThrow(/timed out/i);
    sandbox.dispose();
  });
});

describe('marshalResult / assertBoundaryArray', () => {
  it('rejects a function result, drops nested functions and undefined, keeps null/false', () => {
    expect(() => marshalResult(() => 1)).toThrow(
      'workflow result cannot be a function',
    );
    expect(
      marshalResult({
        f: () => 1,
        u: undefined,
        n: null,
        b: false,
        arr: [1, undefined],
      }),
    ).toEqual({
      n: null,
      b: false,
      arr: [1, null],
    });
    expect(marshalResult(undefined)).toBeUndefined();
    expect(() => marshalResult({ big: 10n })).toThrow();
  });

  it('enforces the 4096 boundary', () => {
    const mk = (_c: string, m: string) => new Error(m);
    expect(() =>
      assertBoundaryArray(new Array(4096).fill(1), mk),
    ).not.toThrow();
    expect(() => assertBoundaryArray(new Array(4097).fill(1), mk)).toThrow(
      boundaryArrayError(4097),
    );
    expect(() => assertBoundaryArray('nope', mk)).toThrow('expected an array');
  });
});
