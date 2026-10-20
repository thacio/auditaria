/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_WORKFLOW: The VM receives JSON and realm-owned functions only.
// Callback IDs let parallel/pipeline call back without passing host objects,
// promises or promise resolver functions to script-defined code.
import * as vm from 'node:vm';
import { isFunction, isRecord, stringField } from './guards.js';

function boundaryReplacer(_key: string, value: unknown): unknown {
  if (Array.isArray(value) && value.length > 4096) {
    throw new Error(
      `array length ${value.length} exceeds the maximum of 4096 supported across the workflow VM boundary`,
    );
  }
  return value;
}

export function encodeBoundaryValue(value: unknown): string {
  return JSON.stringify(
    { ok: true, value, infinity: value === Infinity },
    boundaryReplacer,
  );
}

export function encodeBoundaryError(error: unknown): string {
  const object = isRecord(error) || error instanceof Error ? error : undefined;
  return JSON.stringify({
    ok: false,
    name: typeof object?.name === 'string' ? object.name : 'Error',
    message:
      typeof object?.message === 'string' ? object.message : String(error),
    stack: typeof object?.stack === 'string' ? object.stack : undefined,
  });
}

export function decodeBoundaryValue(encoded: string): unknown {
  const value: unknown = JSON.parse(encoded);
  if (!isRecord(value)) throw new Error('Invalid workflow boundary response');
  if (!value['ok']) {
    const error = new Error(String(value['message']));
    error.name = String(value['name'] ?? 'Error');
    const stack = stringField(value, 'stack');
    if (stack !== undefined) error.stack = stack;
    throw error;
  }
  return value['infinity'] ? Infinity : value['value'];
}

/** Remove host constructors even from the callbacks kept in private closures. */
export function privateHostFunction<T extends (...args: never[]) => unknown>(
  fn: T,
): T {
  Object.setPrototypeOf(fn, null);
  return fn;
}

export function installRealmBridge(
  context: vm.Context,
  sync: (name: string, payload: string) => string,
  async: (
    name: string,
    payload: string,
    reply: (encoded: string) => void,
  ) => void,
) {
  const factory: unknown = vm.runInContext(
    `((sync, send) => {
    'use strict';
    const parse = JSON.parse, rawStringify = JSON.stringify;
    const stringify = value => rawStringify(value, (key, item) => {
      if (Array.isArray(item) && item.length > 4096)
        throw new Error('array length ' + item.length + ' exceeds the maximum of 4096 supported across the workflow VM boundary');
      return item;
    });
    const resolve = Promise.resolve.bind(Promise);
    const then = Function.prototype.call.bind(Promise.prototype.then);
    const errors = {Error, TypeError, RangeError};
    const callbacks = new Map();
    let nextCallback = 0;
    const decode = encoded => {
      const response = parse(encoded);
      if (!response.ok) {
        const error = new (errors[response.name] || errors.Error)(response.message);
        error.name = response.name || 'Error';
        throw error;
      }
      return response.infinity ? Infinity : response.value;
    };
    const fail = (error, done) => {
      let name = 'Error', message = 'Workflow callback failed', stack;
      try {
        if (typeof error?.name === 'string') name = error.name;
        if (typeof error?.message === 'string') message = error.message;
        else message = String(error);
        if (typeof error?.stack === 'string') stack = error.stack;
      } catch {}
      done(stringify({ok:false, name, message, stack}));
    };
    const settle = (value, done) => {
      try {
        then(resolve(value), value => {
          try {
            if (typeof value === 'function') throw new errors.Error('workflow result cannot be a function');
            done(stringify({ok:true, value, infinity:value === Infinity}));
          } catch (error) { fail(error, done); }
        }, error => fail(error, done));
      } catch (error) { fail(error, done); }
    };
    const invoke = (name, values) => {
      const promise = new Promise((accept, reject) => {
        send(name, stringify(values), encoded => {
          try { accept(decode(encoded)); } catch (error) { reject(error); }
        });
      });
      // A fire-and-forget hook must not terminate the host on rejection.
      then(promise, undefined, () => {});
      return promise;
    };
    const register = fn => {
      if (typeof fn !== 'function') return null;
      const id = ++nextCallback;
      callbacks.set(id, fn);
      return id;
    };
    const list = values => {
      if (!Array.isArray(values)) return values;
      if (values.length > 4096) throw new errors.Error('array length ' + values.length + ' exceeds the maximum of 4096 supported across the workflow VM boundary');
      return values.map(register);
    };
    globalThis.agent = (prompt, opts) => invoke('agent', [prompt, opts]);
    globalThis.workflow = (ref, args) => invoke('workflow', [ref, args]);
    globalThis.parallel = thunks => invoke('parallel', [list(thunks)]);
    globalThis.pipeline = (items, ...stages) => {
      if (!Array.isArray(items)) return invoke('pipeline', [items, list(stages)]);
      if (items.length > 4096) throw new errors.Error('array length ' + items.length + ' exceeds the maximum of 4096 supported across the workflow VM boundary');
      const inputs = Array.from(items, item => register(() => item));
      const steps = stages.map(stage => typeof stage === 'function'
        ? register((value, unused, index) => stage(value, items[index], index))
        : null);
      return invoke('pipeline', [inputs, steps]);
    };
    globalThis.phase = title => decode(sync('phase', stringify([title])));
    globalThis.log = message => decode(sync('log', stringify([message])));
    globalThis.args = decode(sync('args', '[]'));
    globalThis.budget = Object.freeze({
      total: decode(sync('total', '[]')),
      spent: () => decode(sync('spent', '[]')),
      remaining: () => decode(sync('remaining', '[]')),
    });
    globalThis.console = Object.freeze(Object.fromEntries(
      ['log','info','warn','error','debug'].map(name =>
        [name, (...parts) => decode(sync('console', stringify(parts)))])));
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (typeof fn !== 'function') throw new errors.TypeError('setTimeout callback must be a function');
      return decode(sync('setTimeout', stringify([register(fn), ms, args])));
    };
    globalThis.clearTimeout = id => decode(sync('clearTimeout', stringify([id])));
    return {
      call(id, encoded, done) {
        try { settle(callbacks.get(id)(...parse(encoded).map(decode)), done); }
        catch (error) { fail(error, done); }
      },
      settle,
    };
  })`,
    context,
    { filename: 'workflow-bridge.js' },
  );
  if (!isFunction(factory))
    throw new Error('Invalid workflow bridge initializer');
  const bridge: unknown = factory(
    privateHostFunction(sync),
    privateHostFunction(async),
  );
  if (
    !isRecord(bridge) ||
    !isFunction(bridge['call']) ||
    !isFunction(bridge['settle'])
  ) {
    throw new Error('Invalid workflow bridge');
  }
  const call = bridge['call'];
  const settle = bridge['settle'];
  const receive = (invoke: (done: (encoded: string) => void) => void) =>
    new Promise<unknown>((resolve, reject) => {
      invoke(
        privateHostFunction((encoded: string) => {
          try {
            resolve(decodeBoundaryValue(encoded));
          } catch (error) {
            reject(error);
          }
        }),
      );
    });
  return {
    call: (id: number, args: unknown[]) =>
      receive((done) => {
        call(id, JSON.stringify(args.map(encodeBoundaryValue)), done);
      }),
    settle: (value: unknown) =>
      receive((done) => {
        settle(value, done);
      }),
  };
}
