/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The script host — a `node:vm` context shaped like
// Claude Code's (research 10 §3, §13):
//   - `codeGeneration: { strings: false, wasm: false }` (eval/Function throw
//     "Code generation from strings disallowed for this context");
//   - only the hook globals + ECMAScript intrinsics (engine extras pruned);
//   - Date.now() / argless new Date() / Math.random() throw at runtime even
//     through aliases (`const D = Date; D.now()`), while new Date(ms),
//     Date.parse and Math.floor keep working;
//   - dynamic import() throws; setTimeout/clearTimeout are real timers bound
//     to the run's abort signal;
//   - every error thrown INTO the script is built with the sandbox realm's
//     own constructors so `e instanceof Error` holds inside the script.

import * as vm from 'node:vm';
import { isFunction } from './guards.js';

export const DATE_NOW_ERROR =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.';
export const MATH_RANDOM_ERROR =
  'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.';
export const IMPORT_ERROR = 'import() is not available in workflow scripts';

/** Claude Code's marshalling cap for arrays crossing the VM boundary. */
export const VM_BOUNDARY_MAX_ARRAY = 4096;

export function boundaryArrayError(length: number): string {
  return `array length ${length} exceeds the maximum of ${VM_BOUNDARY_MAX_ARRAY} supported across the workflow VM boundary`;
}

/** Engine globals a bare vm context exposes that Claude's sandbox does not. */
const PRUNED_GLOBALS = [
  'WebAssembly',
  'SharedArrayBuffer',
  'Atomics',
  'FinalizationRegistry',
  'WeakRef',
];

/** Milliseconds the synchronous part of the script may run before the host aborts it. */
export const SYNC_TIMEOUT_MS = 30_000;

// The determinism shims run INSIDE the context so they replace the realm's
// own Date/Math (aliases taken before or after keep pointing at the shim).
const SHIM_PRELUDE = `(() => {
  const RealDate = Date;
  const NOW_ERR = ${JSON.stringify(DATE_NOW_ERROR)};
  const RANDOM_ERR = ${JSON.stringify(MATH_RANDOM_ERROR)};
  function ShimDate(...args) {
    if (!new.target || args.length === 0) throw new Error(NOW_ERR);
    return Reflect.construct(RealDate, args, new.target === ShimDate ? RealDate : new.target);
  }
  ShimDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, 'constructor', { value: ShimDate, writable: true, configurable: true });
  ShimDate.now = () => { throw new Error(NOW_ERR); };
  ShimDate.parse = RealDate.parse;
  ShimDate.UTC = RealDate.UTC;
  Object.defineProperty(ShimDate, 'name', { value: 'Date' });
  Object.freeze(RealDate);
  globalThis.Date = ShimDate;
  Math.random = () => { throw new Error(RANDOM_ERR); };
})();`;

export type SandboxErrorCtor = 'Error' | 'TypeError' | 'RangeError';

export interface WorkflowSandboxHooks {
  agent: (prompt: unknown, opts?: unknown) => Promise<unknown>;
  parallel: (thunks: unknown) => Promise<unknown[]>;
  pipeline: (items: unknown, ...stages: unknown[]) => Promise<unknown[]>;
  phase: (title: unknown) => void;
  log: (message: unknown) => void;
  workflow: (nameOrRef: unknown, args?: unknown) => Promise<unknown>;
  args: unknown;
  budget: {
    total: number | null;
    spent: () => number;
    remaining: () => number;
  };
}

export interface WorkflowSandbox {
  readonly context: vm.Context;
  /** Construct an error object in the sandbox realm (so `instanceof Error` holds there). */
  makeError(ctor: SandboxErrorCtor, message: string): Error;
  /** Compile + run the wrapped script; resolves with the script's return value. */
  run(wrappedSource: string): Promise<unknown>;
  /** Clear pending timers. Safe to call more than once. */
  dispose(): void;
}

export interface CreateSandboxOptions {
  signal?: AbortSignal;
  /** Override for tests. */
  syncTimeoutMs?: number;
}

/**
 * Build the vm context with Claude Code's sandbox shape and install the hooks.
 */
export function createWorkflowSandbox(
  hooks: WorkflowSandboxHooks,
  options: CreateSandboxOptions = {},
): WorkflowSandbox {
  const timers = new Set<NodeJS.Timeout>();
  const logFromConsole = (...parts: unknown[]) =>
    hooks.log(
      parts.map((p) => (typeof p === 'string' ? p : safeString(p))).join(' '),
    );

  const sandboxGlobals: Record<string, unknown> = {
    agent: hooks.agent,
    parallel: hooks.parallel,
    pipeline: hooks.pipeline,
    phase: hooks.phase,
    log: hooks.log,
    workflow: hooks.workflow,
    args: hooks.args,
    budget: hooks.budget,
    console: Object.freeze({
      log: logFromConsole,
      info: logFromConsole,
      warn: logFromConsole,
      error: logFromConsole,
      debug: logFromConsole,
    }),
    setTimeout: (fn: unknown, ms?: unknown, ...rest: unknown[]) => {
      if (!isFunction(fn)) {
        throw makeError('TypeError', 'setTimeout callback must be a function');
      }
      if (options.signal?.aborted) return 0;
      const delay =
        typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0;
      const handle = setTimeout(() => {
        timers.delete(handle);
        try {
          fn(...rest);
        } catch {
          // A throwing timer callback has no owner; swallow like browsers do.
        }
      }, delay);
      timers.add(handle);
      return handle;
    },
    clearTimeout: (handle: unknown) => {
      for (const t of timers) {
        if (t === handle) {
          clearTimeout(t);
          timers.delete(t);
        }
      }
    },
  };

  const context = vm.createContext(sandboxGlobals, {
    name: 'workflow',
    codeGeneration: { strings: false, wasm: false },
  });

  // Install the determinism shims and prune engine extras from inside.
  vm.runInContext(SHIM_PRELUDE, context, { filename: 'workflow-prelude.js' });
  vm.runInContext(
    `for (const name of ${JSON.stringify(PRUNED_GLOBALS)}) { try { delete globalThis[name]; } catch {} }`,
    context,
    { filename: 'workflow-prelude.js' },
  );

  const errorCtors: Record<SandboxErrorCtor, (message: string) => Error> = {
    Error: realmErrorFactory(context, 'Error'),
    TypeError: realmErrorFactory(context, 'TypeError'),
    RangeError: realmErrorFactory(context, 'RangeError'),
  };

  function makeError(ctor: SandboxErrorCtor, message: string): Error {
    return errorCtors[ctor](message);
  }

  const dispose = () => {
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
  };
  options.signal?.addEventListener('abort', dispose, { once: true });

  return {
    context,
    makeError,
    async run(wrappedSource: string): Promise<unknown> {
      const script = new vm.Script(wrappedSource, {
        filename: 'workflow.js',
        importModuleDynamically: () => {
          throw makeError('Error', IMPORT_ERROR);
        },
      });
      const pending: unknown = script.runInContext(context, {
        timeout: options.syncTimeoutMs ?? SYNC_TIMEOUT_MS,
      });
      return await pending;
    },
    dispose,
  };
}

function isErrorConstructor(value: unknown): value is ErrorConstructor {
  return typeof value === 'function';
}

/** A factory that builds errors with the sandbox realm's own constructor. */
function realmErrorFactory(
  context: vm.Context,
  name: SandboxErrorCtor,
): (message: string) => Error {
  const ctor: unknown = vm.runInContext(name, context);
  if (!isErrorConstructor(ctor))
    throw new Error(`sandbox realm has no ${name} constructor`);
  return (message) => new ctor(message);
}

function safeString(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return '[object]';
  return String(value);
}

/** Throws the VM-boundary error when an array is larger than the cap. */
export function assertBoundaryArray(
  value: unknown,
  makeError: (ctor: SandboxErrorCtor, message: string) => Error,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw makeError('TypeError', 'expected an array');
  }
  if (value.length > VM_BOUNDARY_MAX_ARRAY) {
    throw makeError('Error', boundaryArrayError(value.length));
  }
}

/**
 * Produce the JSON-safe form of a script's return value the way Claude Code
 * does: functions are rejected at the top level and silently dropped inside
 * structures; anything else must survive JSON.stringify (BigInt does not).
 */
export function marshalResult(value: unknown): unknown {
  if (typeof value === 'function') {
    throw new Error('workflow result cannot be a function');
  }
  if (value === undefined) return undefined;
  const json = JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'function' ? undefined : v,
  );
  return json === undefined ? undefined : (JSON.parse(json) as unknown);
}
