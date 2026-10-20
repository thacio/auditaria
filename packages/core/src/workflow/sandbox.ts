/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The script host uses a restricted `node:vm` context:
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
import { isUnknownArray } from './guards.js';
import {
  encodeBoundaryError,
  encodeBoundaryValue,
  installRealmBridge,
} from './realmBridge.js';

export const DATE_NOW_ERROR =
  'Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.';
export const MATH_RANDOM_ERROR =
  'Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.';
export const IMPORT_ERROR = 'import() is not available in workflow scripts';

/** Maximum array length crossing the VM boundary. */
export const VM_BOUNDARY_MAX_ARRAY = 4096;

export function boundaryArrayError(length: number): string {
  return `array length ${length} exceeds the maximum of ${VM_BOUNDARY_MAX_ARRAY} supported across the workflow VM boundary`;
}

/** Engine globals excluded from workflow scripts. */
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
 * Build the restricted vm context and install the workflow hooks.
 */
export function createWorkflowSandbox(
  hooks: WorkflowSandboxHooks,
  options: CreateSandboxOptions = {},
): WorkflowSandbox {
  const timers = new Map<number, NodeJS.Timeout>();
  let nextTimer = 0;
  const logFromConsole = (...parts: unknown[]) =>
    hooks.log(
      parts.map((p) => (typeof p === 'string' ? p : safeString(p))).join(' '),
    );

  // A host Object.prototype on the global object would expose its constructor.
  // eslint-disable-next-line no-restricted-syntax
  const context = vm.createContext(Object.create(null), {
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

  const callback = (id: unknown) =>
    typeof id === 'number' ? (...args: unknown[]) => bridge.call(id, args) : id;
  const bridge = installRealmBridge(
    context,
    (name, encoded) => {
      try {
        const args: unknown = JSON.parse(encoded);
        if (!isUnknownArray(args))
          throw new Error('Invalid workflow arguments');
        let value: unknown;
        switch (name) {
          case 'args':
            value = hooks.args;
            break;
          case 'total':
            value = hooks.budget.total;
            break;
          case 'spent':
            value = hooks.budget.spent();
            break;
          case 'remaining':
            value = hooks.budget.remaining();
            break;
          case 'phase':
            hooks.phase(args[0]);
            break;
          case 'log':
            hooks.log(args[0]);
            break;
          case 'console':
            logFromConsole(...args);
            break;
          case 'setTimeout': {
            if (options.signal?.aborted) {
              value = 0;
              break;
            }
            const [id, ms, rest] = args;
            const timerId = ++nextTimer;
            const delay =
              typeof ms === 'number' && Number.isFinite(ms)
                ? Math.max(0, ms)
                : 0;
            const timer = setTimeout(() => {
              timers.delete(timerId);
              if (typeof id === 'number' && Array.isArray(rest))
                void bridge.call(id, rest).catch(() => undefined);
            }, delay);
            timers.set(timerId, timer);
            value = timerId;
            break;
          }
          case 'clearTimeout': {
            const id = args[0];
            if (typeof id === 'number') {
              clearTimeout(timers.get(id));
              timers.delete(id);
            }
            break;
          }
          default:
            throw new Error('Unknown workflow operation');
        }
        return encodeBoundaryValue(value);
      } catch (error) {
        return encodeBoundaryError(error);
      }
    },
    (name, encoded, reply) => {
      const dispatch = async () => {
        const args: unknown = JSON.parse(encoded);
        if (!isUnknownArray(args))
          throw new Error('Invalid workflow arguments');
        switch (name) {
          case 'agent':
            return hooks.agent(args[0], args[1]);
          case 'workflow':
            return hooks.workflow(args[0], args[1]);
          case 'parallel':
            return hooks.parallel(
              isUnknownArray(args[0]) ? args[0].map(callback) : args[0],
            );
          case 'pipeline':
            return hooks.pipeline(
              isUnknownArray(args[0])
                ? args[0].map((id) =>
                    typeof id === 'number' ? bridge.call(id, []) : id,
                  )
                : args[0],
              ...(isUnknownArray(args[1]) ? args[1].map(callback) : []),
            );
          default:
            throw new Error('Unknown workflow operation');
        }
      };
      void dispatch().then(
        (value) => {
          try {
            reply(encodeBoundaryValue(value));
          } catch (error) {
            reply(encodeBoundaryError(error));
          }
        },
        (error) => reply(encodeBoundaryError(error)),
      );
    },
  );

  const dispose = () => {
    options.signal?.removeEventListener('abort', dispose);
    for (const handle of timers.values()) clearTimeout(handle);
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
      return bridge.settle(pending);
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
 * Produce the JSON-safe form of a script's return value:
 * functions are rejected at the top level and silently dropped inside
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
