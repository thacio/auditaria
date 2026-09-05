/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Artifact page runtime — served at /__rt/claude.js on every artifact
 * origin and injected head-first before the page's own code.
 *
 * Mirrors the shape of Claude Code's artifact runtime (verified live):
 *   - `window.claude` is a non-writable, non-configurable property holding
 *     a plain object with ONE member, `use(name)`;
 *   - `use()` resolves a frozen, null-prototype namespace, or `null` when the
 *     capability is unknown, not declared by the page, or not served here;
 *     the promise for a served name is memoized (same object every time);
 *   - namespace methods never throw synchronously: a thrown error becomes
 *     a rejection carrying `{code, message}`;
 *   - handler-taking methods validate their handler and throw a TypeError.
 *
 * Transport: one WebSocket to the page's own origin (`/__runtime/live`).
 * The server decides what the page may do; this script only asks.
 */
(function () {
  'use strict';

  const cfg = window.__AUDITARIA_FRAME || {};
  const grants = new Set(Array.isArray(cfg.grants) ? cfg.grants : []);
  const KNOWN = new Set([
    'artifact',
    'self',
    'db',
    'user',
    'assets',
    'downloads',
    'sample',
    'room',
    'mcp',
  ]);

  // ------------------------------------------------------------------
  // Theme: the console stamps data-theme through the URL on first paint
  // and through postMessage when it changes; standalone tabs stamp nothing.
  // ------------------------------------------------------------------
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'dark' || theme === 'light') {
      root.setAttribute('data-theme', theme);
    } else {
      root.removeAttribute('data-theme');
    }
  }
  if (cfg.theme) applyTheme(cfg.theme);
  const consoleOrigins = new Set(
    Array.isArray(cfg.consoleOrigins) ? cfg.consoleOrigins : [],
  );
  window.addEventListener('message', (event) => {
    if (!consoleOrigins.has(event.origin)) return;
    const data = event.data;
    if (data && data.type === 'auditaria-theme') applyTheme(data.theme);
  });

  // ------------------------------------------------------------------
  // Live socket (lazy: opened by the first capability that needs it).
  // ------------------------------------------------------------------
  let socketReady = null;
  let nextCall = 1;
  const pending = new Map();
  const pushHandlers = new Map();

  function connect() {
    if (socketReady) return socketReady;
    socketReady = new Promise((resolve, reject) => {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/__runtime/live`);
      ws.addEventListener('open', () => {
        resolve(ws);
      });
      ws.addEventListener('error', () => {
        reject(errorOf('unavailable', 'runtime socket failed'));
      });
      ws.addEventListener('close', () => {
        socketReady = null;
        for (const entry of pending.values()) {
          entry.reject(errorOf('unavailable', 'runtime socket closed'));
        }
        pending.clear();
      });
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (message.id && pending.has(message.id)) {
          const entry = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) entry.reject(message.error);
          else entry.resolve(message.result);
          return;
        }
        if (message.push) {
          const handlers = pushHandlers.get(message.push) || [];
          for (const handler of handlers) {
            try {
              handler(message.data);
            } catch {
              /* a page handler must not break the runtime */
            }
          }
        }
      });
    });
    return socketReady;
  }

  function call(method, params) {
    return connect().then(
      (ws) =>
        new Promise((resolve, reject) => {
          const id = nextCall++;
          pending.set(id, { resolve, reject });
          ws.send(JSON.stringify({ id, method, params }));
        }),
    );
  }

  function onPush(kind, handler) {
    const list = pushHandlers.get(kind) || [];
    list.push(handler);
    pushHandlers.set(kind, list);
    return () => {
      const current = pushHandlers.get(kind) || [];
      const index = current.indexOf(handler);
      if (index >= 0) current.splice(index, 1);
    };
  }

  // The host reloads every view of this artifact when a new version lands.
  onPush('version', () => {
    location.reload();
  });

  // ------------------------------------------------------------------
  // Namespaces
  // ------------------------------------------------------------------
  function errorOf(code, message) {
    return { code, message };
  }

  /** Wraps a method so synchronous throws become rejections. */
  function guard(fn) {
    return (...args) => {
      try {
        return Promise.resolve(fn(...args));
      } catch (error) {
        return Promise.reject(error);
      }
    };
  }

  function freezeNamespace(members) {
    const ns = Object.create(null);
    for (const key of Object.keys(members)) ns[key] = members[key];
    return Object.freeze(ns);
  }

  function requireHandler(where, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`${where} requires a handler function`);
    }
  }

  const builders = {
    artifact: () =>
      freezeNamespace({
        publish: guard((html) => {
          if (typeof html !== 'string') {
            throw errorOf('invalid_content', 'publish(html) needs a string');
          }
          return call('artifact.publish', { html, base: cfg.version });
        }),
        edit: guard(() =>
          Promise.reject(
            errorOf('capability_removed', 'live docs are not served here'),
          ),
        ),
        sync: guard(() =>
          Promise.reject(
            errorOf('capability_removed', 'live docs are not served here'),
          ),
        ),
      }),
    user: () =>
      freezeNamespace({
        id: guard(() => call('user.id', {})),
        canEdit: guard(() => call('user.canEdit', {})),
        isOwner: guard(() => call('user.isOwner', {})),
        profiles: guard((ids) => call('user.profiles', { ids })),
      }),
    db: () => {
      // The path grammar, checked here so a bad path throws a TypeError
      // synchronously at ref creation (the server re-checks every call).
      const SEGMENT = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
      const checkPath = (path, wantDoc) => {
        const text = String(path);
        const segments = text === '' ? [] : text.split('/');
        if (segments.length > 16) {
          throw new TypeError(
            `path has ${segments.length} segments; at most 16 are allowed`,
          );
        }
        for (const segment of segments) {
          if (segment === '.' || segment === '..' || !SEGMENT.test(segment)) {
            throw new TypeError(
              `path segment "${segment}" breaks the grammar (letters, digits, _ - . ~ : @ +; 1-200 characters)`,
            );
          }
        }
        const even = segments.length % 2 === 0;
        if (wantDoc && (segments.length === 0 || !even)) {
          throw new TypeError(
            `"${text}" is not a document path: it has ${segments.length} segments (a document path has an even number, like "tasks/t1")`,
          );
        }
        if (!wantDoc && even) {
          throw new TypeError(
            `"${text}" is not a collection path: it has ${segments.length} segments (a collection path has an odd number, like "tasks")`,
          );
        }
        return text;
      };
      const deepFreeze = (value) => {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
          Object.freeze(value);
          for (const key of Object.keys(value)) deepFreeze(value[key]);
        }
        return value;
      };
      const metadata = (pending) =>
        Object.freeze({ fromCache: false, hasPendingWrites: pending === true });
      // Snapshots as the contract delivers them: frozen, `data()` accessor.
      const hydrateDoc = (raw, cache) => {
        const cached = cache && cache.get(raw.id);
        if (
          cached &&
          cached.version === raw.version &&
          cached.exists === raw.exists
        ) {
          return cached.snap;
        }
        const data = raw.exists ? deepFreeze(raw.data || {}) : undefined;
        const snap = Object.freeze({
          id: raw.id,
          exists: raw.exists === true,
          data: () => data,
          metadata: metadata(false),
        });
        if (cache)
          cache.set(raw.id, { version: raw.version, exists: raw.exists, snap });
        return snap;
      };
      const hydrateQuery = (raw, state) => {
        const cache = state ? state.cache : null;
        const docs = (raw.docs || []).map((d) => hydrateDoc(d, cache));
        const previous = state ? state.previous : [];
        const prevIndex = new Map(previous.map((d, i) => [d.id, i]));
        const nextIndex = new Map(docs.map((d, i) => [d.id, i]));
        const changes = [];
        for (const [id, oldIndex] of prevIndex) {
          if (!nextIndex.has(id)) {
            changes.push({
              type: 'removed',
              doc: previous[oldIndex],
              oldIndex,
              newIndex: -1,
            });
          }
        }
        docs.forEach((doc, newIndex) => {
          const oldIndex = prevIndex.has(doc.id) ? prevIndex.get(doc.id) : -1;
          if (oldIndex === -1) {
            changes.push({ type: 'added', doc, oldIndex: -1, newIndex });
          } else if (previous[oldIndex] !== doc) {
            changes.push({ type: 'modified', doc, oldIndex, newIndex });
          }
        });
        if (state) state.previous = docs;
        const frozenDocs = Object.freeze(docs);
        const frozenChanges = Object.freeze(
          changes.map((c) => Object.freeze(c)),
        );
        return Object.freeze({
          docs: frozenDocs,
          size: frozenDocs.length,
          empty: frozenDocs.length === 0,
          docChanges: () => frozenChanges,
          metadata: metadata(false),
        });
      };
      const docRef = (docPath) => ({
        id: docPath.split('/').pop(),
        path: docPath,
        get: () =>
          call('db.get', { path: docPath }).then((raw) =>
            hydrateDoc(raw, null),
          ),
        set: (data) => call('db.set', { path: docPath, data }),
        update: (data) => call('db.update', { path: docPath, data }),
        delete: () => call('db.delete', { path: docPath }),
        acquire: (options) => call('db.acquire', { path: docPath, options }),
        onSnapshot: (handler, onError) =>
          subscribe({ path: docPath }, handler, onError),
        collection: (name) =>
          collectionRef(checkPath(`${docPath}/${String(name)}`, false)),
      });
      const collectionRef = (colPath, spec) => {
        const query = spec || {
          path: colPath,
          where: [],
          orderBy: null,
          limit: null,
        };
        const withSpec = (patch) =>
          collectionRef(colPath, { ...query, ...patch });
        return {
          path: colPath,
          where: (field, op, value) =>
            withSpec({
              where: [
                ...query.where,
                { f: String(field), op: String(op), v: value },
              ],
            }),
          orderBy: (field, dir) =>
            withSpec({
              orderBy: {
                f: String(field),
                dir: dir === undefined ? 'asc' : String(dir),
              },
            }),
          limit: (n) => withSpec({ limit: Number(n) }),
          get: () =>
            call('db.query', { spec: query }).then((raw) =>
              hydrateQuery(raw, null),
            ),
          onSnapshot: (handler, onError) =>
            subscribe({ spec: query }, handler, onError),
          doc: (id) =>
            docRef(
              checkPath(
                `${colPath}/${id === undefined ? autoId() : String(id)}`,
                true,
              ),
            ),
          add: (data) => {
            const ref = docRef(`${colPath}/${autoId()}`);
            return Promise.resolve(ref.set(data)).then(() => ref);
          },
        };
      };
      const subscribe = (target, handler, onError) => {
        requireHandler('db.onSnapshot', handler);
        let stopped = false;
        let subscriptionId = null;
        const state = { cache: new Map(), previous: [] };
        const offPush = onPush('db.snapshot', (data) => {
          if (!stopped && data && data.subscriptionId === subscriptionId) {
            const raw = data.snapshot || {};
            try {
              handler(
                raw.kind === 'query'
                  ? hydrateQuery(raw, state)
                  : hydrateDoc(raw, state.cache),
              );
            } catch {
              /* a page handler must not break the runtime */
            }
          }
        });
        call('db.subscribe', target).then(
          (result) => {
            subscriptionId = result.subscriptionId;
            if (stopped) call('db.unsubscribe', { subscriptionId });
          },
          (error) => {
            if (typeof onError === 'function') onError(error);
          },
        );
        return () => {
          stopped = true;
          offPush();
          if (subscriptionId !== null)
            call('db.unsubscribe', { subscriptionId });
        };
      };
      const autoId = () => {
        const bytes = new Uint8Array(10);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
          '',
        );
      };
      return freezeNamespace({
        get: guard((p) =>
          call('db.get', { path: String(p) }).then((raw) =>
            hydrateDoc(raw, null),
          ),
        ),
        query: guard((spec) =>
          call('db.query', { spec }).then((raw) => hydrateQuery(raw, null)),
        ),
        set: guard((p, data) => call('db.set', { path: String(p), data })),
        update: guard((p, data) =>
          call('db.update', { path: String(p), data }),
        ),
        delete: guard((p) => call('db.delete', { path: String(p) })),
        acquire: guard((p, options) =>
          call('db.acquire', { path: String(p), options }),
        ),
        subscribe: (target, handler, onError) =>
          subscribe(target, handler, onError),
        unsubscribe: guard((id) =>
          call('db.unsubscribe', { subscriptionId: id }),
        ),
        doc: (p) => docRef(checkPath(p, true)),
        collection: (p) => collectionRef(checkPath(p, false)),
      });
    },
    assets: () =>
      freezeNamespace({
        list: guard((options) => call('assets.list', options || {})),
        url: (id) => `/__assets/${encodeURIComponent(String(id))}`,
      }),
    downloads: () =>
      freezeNamespace({
        save: guard((request) => {
          if (!request || typeof request.filename !== 'string') {
            throw errorOf(
              'invalid_argument',
              'save({filename, data}) needs a filename',
            );
          }
          return encodeData(request.data)
            .then((data) =>
              call('downloads.save', { filename: request.filename, data }),
            )
            .then((result) => {
              // No console to hand the file over: a standalone tab saves
              // it itself (the browser shows its own prompt).
              if (result && result.url) {
                const frame = document.createElement('iframe');
                frame.hidden = true;
                frame.src = result.url;
                document.body.appendChild(frame);
                setTimeout(() => frame.remove(), 60000);
              }
              return { status: 'saved' };
            });
        }),
      }),
    sample: () => {
      const sample = guard((input, options) => {
        const opts = options || {};
        const requestId = nextCall++;
        let offText = null;
        if (typeof opts.onText === 'function') {
          offText = onPush('sample.text', (data) => {
            if (data && data.requestId === requestId)
              opts.onText({ text: data.text, delta: data.delta });
          });
        }
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            call('sample.cancel', { requestId }).catch(() => {});
          });
        }
        return call('sample', {
          requestId,
          input,
          modelTier: opts.modelTier,
          cache: opts.cache,
        }).finally(() => {
          if (offText) offText();
        });
      });
      sample.json = guard((input, options) =>
        sample(input, options).then((result) => {
          try {
            return JSON.parse(result.text);
          } catch {
            throw {
              code: 'invalid_json',
              message: 'answer was not JSON',
              text: result.text,
            };
          }
        }),
      );
      sample.limits = guard(() => call('sample.limits', {}));
      return Object.freeze(sample);
    },
  };
  builders.self = builders.artifact;

  function encodeData(data) {
    if (typeof data === 'string') return Promise.resolve({ text: data });
    const toBase64 = (buffer) => {
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(
          null,
          bytes.subarray(i, i + 0x8000),
        );
      }
      return btoa(binary);
    };
    if (data instanceof Blob)
      return data.arrayBuffer().then((b) => ({ base64: toBase64(b) }));
    if (data instanceof ArrayBuffer)
      return Promise.resolve({ base64: toBase64(data) });
    if (ArrayBuffer.isView(data)) {
      return Promise.resolve({
        base64: toBase64(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        ),
      });
    }
    return Promise.reject(
      errorOf(
        'invalid_argument',
        'data must be a string, Blob, ArrayBuffer or view',
      ),
    );
  }

  // ------------------------------------------------------------------
  // window.claude
  // ------------------------------------------------------------------
  const memo = new Map();
  const namespaces = new Map();
  function use(name) {
    if (typeof name !== 'string' || !KNOWN.has(name)) {
      return Promise.resolve(null);
    }
    const canonical = name === 'self' ? 'artifact' : name;
    if (!grants.has(canonical) || !builders[canonical]) {
      return Promise.resolve(null);
    }
    if (!memo.has(canonical)) {
      // Never synchronous: resolve on a later tick, like the platform.
      memo.set(
        canonical,
        new Promise((resolve) => {
          setTimeout(() => {
            if (!namespaces.has(canonical)) {
              namespaces.set(canonical, builders[canonical]());
            }
            resolve(namespaces.get(canonical));
          }, 0);
        }),
      );
    }
    return memo.get(canonical);
  }

  const claude = { use };
  Object.defineProperty(window, 'claude', {
    value: claude,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  Object.defineProperty(window, 'auditaria', {
    value: claude,
    writable: false,
    configurable: false,
    enumerable: true,
  });
})();
