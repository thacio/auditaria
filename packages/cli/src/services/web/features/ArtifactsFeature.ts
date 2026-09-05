/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_ARTIFACTS: hosts artifacts on their own origins and feeds the gallery.

import type { WebSocket } from 'ws';
import {
  ArtifactStoreError,
  DbError,
  MAX_SUBSCRIPTIONS_PER_VIEW,
  collectionOf,
  idOf,
  mayAccess,
  normalizeQuerySpec,
  validateRules,
  type AccessRule,
  type ArtifactDb,
  type ArtifactRecord,
  type QuerySpec,
  type StoredDoc,
  type Viewer,
  artifactHostname,
  artifactUrl,
  extractTitle,
  parseArtifactReference,
  unwrapDocument,
  type ArtifactHost,
  type ArtifactId,
  type ArtifactService,
  type ArtifactStore,
  type ArtifactSummary,
  type PublishOutcome,
} from '@google/gemini-cli-core';
import { openBrowser } from '../../../utils/browserUtils.js';
import { WebFeature } from '../core/webFeature.js';
import type { ListenInfo, WebFeatureContext } from '../core/types.js';
import {
  isRecord,
  readNumber,
  readString,
  type ClientMessage,
} from '../protocol.js';
import {
  createArtifactHost,
  runtimeDirFor,
} from '../artifacts/artifactHost.js';
import { ShareManager, type TunnelFactory } from '../artifacts/shareSession.js';
import { startQuickTunnel } from '../../hive/HiveTunnel.js';
import { registerCleanup } from '../../../utils/cleanup.js';

/** What the gallery receives per artifact. */
export interface ArtifactListRow extends ArtifactSummary {
  readonly url: string;
  readonly hostname: string;
  /** Public address while shared in this session, else null. */
  readonly shareUrl: string | null;
}

export interface ArtifactsFeatureOptions {
  readonly service: ArtifactService;
  /** Root of the served web client (the runtime script lives beside it). */
  readonly webClientRoot: string;
  /** Pushes a notice to the CLI display (turn-boundary delivery is theirs). */
  readonly notify?: (text: string) => void;
  /** Opens the public tunnel (tests inject a fake); default: cloudflared. */
  readonly tunnelFactory?: TunnelFactory;
}

/**
 * Serves every artifact on `http://art-<id>.localhost:<port>/`, keeps the
 * gallery in sync through the chat socket, pushes `version` to the runtime
 * sockets of an artifact when it changes (pages reload), and registers the
 * core→CLI host seam so the tool can print URLs and open the browser.
 */
export class ArtifactsFeature extends WebFeature {
  readonly name = 'artifacts';

  private port: number | null = null;
  private consoleOrigins: readonly string[] = [];
  private store: ArtifactStore | null = null;
  private unsubscribers: Array<() => void> = [];
  /** Live runtime sockets per artifact (pages currently open). */
  private readonly runtimeSockets = new Map<ArtifactId, Set<WebSocket>>();
  /** Live db subscriptions per runtime socket (capped per view). */
  private readonly subscriptions = new Map<
    WebSocket,
    Map<number, LiveSubscription>
  >();
  private nextSubscriptionId = 1;
  /** Databases whose change events already fan out to subscribers. */
  private readonly wiredDbs = new WeakSet<ArtifactDb>();
  private shares: ShareManager | null = null;
  private static cleanupRegistered = false;
  private static readonly liveManagers = new Set<ShareManager>();

  constructor(private readonly options: ArtifactsFeatureOptions) {
    super();
  }

  protected async onAttach(ctx: WebFeatureContext): Promise<void> {
    const { service } = this.options;
    ctx.http.mountHost(
      createArtifactHost({
        service,
        logger: ctx.logger,
        runtimeDir: runtimeDirFor(this.options.webClientRoot),
        getConsoleOrigins: () => this.consoleOrigins,
      }),
    );

    ctx.ws.addEndpoint({
      path: '/__runtime/live',
      host: (hostname) =>
        parseArtifactReference(`http://${hostname}/`) !== null,
      onConnection: (ws, _params, request) =>
        this.handleRuntimeSocket(ws, request.headers.host ?? ''),
    });

    const store = await service.getStore();
    this.store = store;
    const onVersion = (outcome: PublishOutcome) => this.handleVersion(outcome);
    const onMeta = () => this.broadcastList();
    const onDeleted = () => this.broadcastList();
    const onRestored = () => this.broadcastList();
    store.on('version', onVersion);
    store.on('meta', onMeta);
    store.on('deleted', onDeleted);
    store.on('restored', onRestored);
    this.unsubscribers.push(
      () => store.off('version', onVersion),
      () => store.off('meta', onMeta),
      () => store.off('deleted', onDeleted),
      () => store.off('restored', onRestored),
    );

    this.shares = new ShareManager({
      service,
      logger: ctx.logger,
      runtimeDir: runtimeDirFor(this.options.webClientRoot),
      tunnelFactory:
        this.options.tunnelFactory ??
        (async (port) => {
          const tunnel = await startQuickTunnel(port);
          return { url: tunnel.url, stop: () => tunnel.stop() };
        }),
    });
    ArtifactsFeature.liveManagers.add(this.shares);
    if (!ArtifactsFeature.cleanupRegistered) {
      ArtifactsFeature.cleanupRegistered = true;
      // Shares must not outlive the process: no tunnel, no token survives.
      registerCleanup(async () => {
        await Promise.all(
          Array.from(ArtifactsFeature.liveManagers).map((m) => m.stopAll()),
        );
      });
    }

    const { inbound } = ctx;
    inbound.on('artifact_list_request', (_message, ws) => this.sendList(ws));
    inbound.on('artifact_share_request', (message) => this.share(message));
    inbound.on('artifact_versions_request', (message, ws) =>
      this.sendVersions(message, ws),
    );
    inbound.on('artifact_update_request', (message) => this.update(message));
    inbound.on('artifact_delete_request', (message) => this.remove(message));
    inbound.on('artifact_restore_request', (message) => this.restore(message));

    void store.purgeExpired().then((purged) => {
      if (purged.length)
        ctx.logger.debug(`Purged ${purged.length} expired artifact(s)`);
    });
  }

  override onListening(info: ListenInfo): void {
    this.port = info.port;
    this.consoleOrigins = info.consoleOrigins;
    const host: ArtifactHost = {
      getPort: () => this.port,
      openInBrowser: async (url) => {
        try {
          await openBrowser(url);
          return true;
        } catch {
          return false;
        }
      },
      notify: (text) => this.options.notify?.(text),
    };
    this.options.service.setHost(host);
  }

  protected async onDetach(): Promise<void> {
    const shares = this.shares;
    this.shares = null;
    if (shares) {
      ArtifactsFeature.liveManagers.delete(shares);
      await shares.stopAll();
    }
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    for (const sockets of this.runtimeSockets.values()) {
      for (const ws of sockets) ws.close(1001, 'Server shutting down');
    }
    this.runtimeSockets.clear();
    this.options.service.setHost(null);
    this.port = null;
    this.store = null;
  }

  override sendInitialState(ws: WebSocket): void {
    void this.sendList(ws);
  }

  // ---------------------------------------------------------------------
  // Gallery
  // ---------------------------------------------------------------------

  private async listRows(): Promise<ArtifactListRow[]> {
    const store = this.store;
    const port = this.port;
    if (!store || port === null) return [];
    return (await store.list()).map((row) => ({
      ...row,
      url: artifactUrl(row.id, port),
      hostname: artifactHostname(row.id),
      shareUrl: this.shares?.get(row.id)?.url ?? null,
    }));
  }

  private async sendList(ws: WebSocket): Promise<void> {
    this.send(ws, 'artifact_list', { artifacts: await this.listRows() });
  }

  private async broadcastList(): Promise<void> {
    this.broadcast('artifact_list', { artifacts: await this.listRows() });
  }

  private async sendVersions(
    message: ClientMessage,
    ws: WebSocket,
  ): Promise<void> {
    const id = this.idOf(message);
    if (!id || !this.store) return;
    const versions = await this.store.versions(id);
    this.send(ws, 'artifact_versions_response', { id, versions });
  }

  /** Rename, pin, pin a version, restore a version, or record consent. */
  private async update(message: ClientMessage): Promise<void> {
    const id = this.idOf(message);
    const store = this.store;
    if (!id || !store) return;
    const op = readString(message, 'op');
    try {
      switch (op) {
        case 'rename': {
          const title = readString(message, 'title');
          if (title) await store.rename(id, title);
          break;
        }
        case 'pin':
          await store.setPinned(id, message['pinned'] === true);
          break;
        case 'pin_version':
          await store.setPinnedVersion(
            id,
            readNumber(message, 'version') ?? null,
          );
          break;
        case 'restore_version': {
          const n = readNumber(message, 'version');
          if (n === undefined) break;
          const version = await store.version(id, n);
          if (!version) break;
          const body = await store.readBody(id, n);
          await store.publish(id, {
            body,
            format: version.format,
            source: 'web',
            title: version.title,
            label: `Restored from v${n}`,
          });
          break;
        }
        case 'sample_consent':
          await store.setSampleConsent(id, message['consent'] === true);
          break;
        default:
          this.ctx?.logger.warn(`Unknown artifact update op: ${String(op)}`);
      }
    } catch (error) {
      this.ctx?.logger.error('Artifact update failed:', error);
    }
  }

  private async remove(message: ClientMessage): Promise<void> {
    const id = this.idOf(message);
    if (!id || !this.store) return;
    try {
      await this.store.delete(id);
      this.options.service.untrack(id);
    } catch (error) {
      this.ctx?.logger.error('Artifact delete failed:', error);
    }
  }

  private async restore(message: ClientMessage): Promise<void> {
    const id = this.idOf(message);
    if (!id || !this.store) return;
    try {
      await this.store.restore(id);
    } catch (error) {
      this.ctx?.logger.error('Artifact restore failed:', error);
    }
  }

  /** Publish (start a public share) or unpublish an artifact. */
  private async share(message: ClientMessage): Promise<void> {
    const id = this.idOf(message);
    const shares = this.shares;
    if (!id || !shares) return;
    const op = readString(message, 'op');
    try {
      if (op === 'start') {
        const state = await shares.start(id);
        this.broadcast('artifact_share_state', {
          id,
          url: state.url,
          startedAt: state.startedAt,
        });
      } else if (op === 'stop') {
        await shares.stop(id);
        this.broadcast('artifact_share_state', { id, url: null });
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.ctx?.logger.error('Artifact share failed:', error);
      this.broadcast('artifact_share_state', { id, url: null, error: text });
    }
    void this.broadcastList();
  }

  private idOf(message: ClientMessage): ArtifactId | null {
    const raw = readString(message, 'id');
    return raw ? parseArtifactReference(raw) : null;
  }

  // ---------------------------------------------------------------------
  // Versions → open pages and the gallery
  // ---------------------------------------------------------------------

  private handleVersion(outcome: PublishOutcome): void {
    const { record, version } = outcome;
    this.broadcast('artifact_event', {
      kind: 'version',
      id: record.id,
      version: version.n,
      title: record.title,
      source: version.source,
    });
    void this.broadcastList();
    const payload = JSON.stringify({
      push: 'version',
      data: { version: version.n, source: version.source },
    });
    for (const ws of this.runtimeSockets.get(record.id) ?? []) {
      try {
        ws.send(payload);
      } catch {
        /* the socket is going away */
      }
    }
    // A version this session's tool did not mint is news for the agent.
    if (version.source !== 'tool') {
      const by =
        version.source === 'page' ? 'the page itself' : 'the web interface';
      this.options.service.pushNotice(
        `Artifact changed: "${record.title}" (${record.id}) is now version ${version.n}, published by ${by}. Re-read it before editing or republishing.`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // db capability. The store is viewer-agnostic; this layer applies the
  // viewer's level and `{self}` privacy on every call, and fans out
  // change pushes to the pages subscribed to the affected documents.
  // ---------------------------------------------------------------------

  private async dbFor(id: ArtifactId): Promise<ArtifactDb> {
    const db = await this.options.service.getDb(id);
    if (!this.wiredDbs.has(db)) {
      this.wiredDbs.add(db);
      db.on('change', (paths) => {
        void this.fanOutDbChange(id, paths);
      });
    }
    return db;
  }

  /** On the local listener every runtime socket belongs to the owner. */
  private async viewerOf(): Promise<Viewer> {
    return { id: await this.options.service.getOwnerId(), level: 'owner' };
  }

  private rulesOf(record: ArtifactRecord): AccessRule[] {
    const declared = record.capabilities['db'];
    const raw = isRecord(declared) ? declared['rules'] : undefined;
    try {
      return validateRules(raw);
    } catch {
      return [];
    }
  }

  private docSnapshot(
    path: string,
    doc: StoredDoc | null,
  ): Record<string, unknown> {
    if (!doc) return { kind: 'doc', id: idOf(path), exists: false };
    return {
      kind: 'doc',
      id: idOf(doc.path),
      exists: true,
      data: doc.data,
      version: doc.version,
    };
  }

  private querySnapshot(
    db: ArtifactDb,
    spec: QuerySpec,
    rules: readonly AccessRule[],
    viewer: Viewer,
  ): Record<string, unknown> {
    const visible = db
      .query(spec)
      .filter((doc) => mayAccess(rules, viewer, doc.path, 'read'));
    const window = spec.limit === null ? visible : visible.slice(0, spec.limit);
    return {
      kind: 'query',
      docs: window.map((doc) => ({
        id: idOf(doc.path),
        exists: true,
        data: doc.data,
        version: doc.version,
      })),
    };
  }

  private async dispatchDb(
    id: ArtifactId,
    record: ArtifactRecord,
    method: string,
    params: Record<string, unknown>,
    ws: WebSocket,
  ): Promise<unknown> {
    const db = await this.dbFor(id);
    const viewer = await this.viewerOf();
    const rules = this.rulesOf(record);
    const envelope: ClientMessage = { type: 'rpc', ...params };
    const pathOf = (): string => {
      const path = readString(envelope, 'path');
      if (path === undefined) throw rpc('invalid_argument', 'path is required');
      return path;
    };
    const guardWrite = (path: string): void => {
      if (!mayAccess(rules, viewer, path, 'write')) {
        throw rpc('invalid_argument', `this viewer may not write ${path}`);
      }
    };
    try {
      switch (method) {
        case 'db.get': {
          const path = pathOf();
          const doc = db.get(path);
          const visible = mayAccess(rules, viewer, path, 'read');
          return this.docSnapshot(path, visible ? doc : null);
        }
        case 'db.query':
          return this.querySnapshot(
            db,
            normalizeQuerySpec(params['spec']),
            rules,
            viewer,
          );
        case 'db.set': {
          const path = pathOf();
          guardWrite(path);
          await db.set(path, params['data']);
          return null;
        }
        case 'db.update': {
          const path = pathOf();
          guardWrite(path);
          await db.update(path, params['data']);
          return null;
        }
        case 'db.delete': {
          const path = pathOf();
          guardWrite(path);
          await db.delete(path);
          return null;
        }
        case 'db.acquire': {
          const path = pathOf();
          guardWrite(path);
          const options = params['options'];
          if (!isRecord(options)) {
            throw rpc(
              'invalid_argument',
              'acquire needs {holder, ttlMs?, data?}',
            );
          }
          const optionEnvelope: ClientMessage = { type: 'rpc', ...options };
          const holder = readString(optionEnvelope, 'holder');
          if (holder === undefined) {
            throw rpc('invalid_argument', 'acquire needs a holder string');
          }
          return await db.acquire(path, {
            holder,
            ttlMs: readNumber(optionEnvelope, 'ttlMs'),
            data: options['data'],
          });
        }
        case 'db.subscribe': {
          const perSocket =
            this.subscriptions.get(ws) ?? new Map<number, LiveSubscription>();
          if (perSocket.size >= MAX_SUBSCRIPTIONS_PER_VIEW) {
            throw rpc(
              'resource_exhausted',
              `at most ${MAX_SUBSCRIPTIONS_PER_VIEW} subscriptions per view`,
            );
          }
          const target: LiveSubscription['target'] = isRecord(params['spec'])
            ? { spec: normalizeQuerySpec(params['spec']) }
            : { path: pathOf() };
          if ('path' in target) db.get(target.path); // validates the grammar
          const subscriptionId = this.nextSubscriptionId++;
          const subscription: LiveSubscription = {
            id: subscriptionId,
            artifactId: id,
            target,
          };
          perSocket.set(subscriptionId, subscription);
          this.subscriptions.set(ws, perSocket);
          // The first snapshot follows the reply, never precedes it.
          setImmediate(() => {
            void this.pushSnapshot(ws, subscription);
          });
          return { subscriptionId };
        }
        case 'db.unsubscribe': {
          const subscriptionId = readNumber(envelope, 'subscriptionId');
          if (subscriptionId !== undefined) {
            this.subscriptions.get(ws)?.delete(subscriptionId);
          }
          return null;
        }
        default:
          throw rpc('capability_removed', `${method} is not part of db`);
      }
    } catch (error) {
      if (error instanceof DbError) throw rpc(error.code, error.message);
      if (error instanceof TypeError)
        throw rpc('invalid_argument', error.message);
      throw error;
    }
  }

  private async pushSnapshot(
    ws: WebSocket,
    subscription: LiveSubscription,
  ): Promise<void> {
    const store = this.store;
    if (!store || ws.readyState !== ws.OPEN) return;
    const record = await store.get(subscription.artifactId);
    if (!record || record.deletedAt) return;
    try {
      const db = await this.dbFor(subscription.artifactId);
      const viewer = await this.viewerOf();
      const rules = this.rulesOf(record);
      const { target } = subscription;
      const snapshot =
        'path' in target
          ? this.docSnapshot(
              target.path,
              mayAccess(rules, viewer, target.path, 'read')
                ? db.get(target.path)
                : null,
            )
          : this.querySnapshot(db, target.spec, rules, viewer);
      ws.send(
        JSON.stringify({
          push: 'db.snapshot',
          data: { subscriptionId: subscription.id, snapshot },
        }),
      );
    } catch (error) {
      this.ctx?.logger.error('Artifact db snapshot failed:', error);
    }
  }

  private async fanOutDbChange(
    id: ArtifactId,
    paths: readonly string[],
  ): Promise<void> {
    const collections = new Set(paths.map((path) => collectionOf(path)));
    for (const [ws, perSocket] of this.subscriptions) {
      for (const subscription of perSocket.values()) {
        if (subscription.artifactId !== id) continue;
        const { target } = subscription;
        const affected =
          'path' in target
            ? paths.includes(target.path)
            : collections.has(target.spec.path);
        if (affected) await this.pushSnapshot(ws, subscription);
      }
    }
  }

  // ---------------------------------------------------------------------
  // Runtime socket (one per open page): capability RPC + pushes.
  // ---------------------------------------------------------------------

  private handleRuntimeSocket(ws: WebSocket, hostHeader: string): void {
    const id = parseArtifactReference(`http://${hostHeader}/`);
    if (!id) {
      ws.close(1008, 'Unknown artifact');
      return;
    }
    const sockets = this.runtimeSockets.get(id) ?? new Set<WebSocket>();
    sockets.add(ws);
    this.runtimeSockets.set(id, sockets);
    ws.on('close', () => {
      sockets.delete(ws);
      this.subscriptions.delete(ws);
      if (sockets.size === 0) this.runtimeSockets.delete(id);
    });
    ws.on('message', (raw) => {
      let call: unknown;
      try {
        call = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isRecord(call)) return;
      const envelope: ClientMessage = { type: 'rpc', ...call };
      const callId = readNumber(envelope, 'id');
      if (callId === undefined) return;
      const method = readString(envelope, 'method') ?? '';
      const rawParams = call['params'];
      const params = isRecord(rawParams) ? rawParams : {};
      this.dispatchRpc(id, method, params, ws).then(
        (result) => ws.send(JSON.stringify({ id: callId, result })),
        (error: unknown) =>
          ws.send(JSON.stringify({ id: callId, error: rpcError(error) })),
      );
    });
  }

  /**
   * Capability RPC from a page. Every call re-checks the artifact's stored
   * declaration (the page cannot grant itself anything) and runs with the
   * OWNER's authority because this socket only exists on the local
   * listener. Capabilities not served yet reject with capability_disabled.
   */
  private async dispatchRpc(
    id: ArtifactId,
    method: string,
    params: Record<string, unknown>,
    ws: WebSocket,
  ): Promise<unknown> {
    const store = this.store;
    if (!store) throw rpc('unavailable', 'store is not open');
    const record = await store.get(id);
    if (!record || record.deletedAt) {
      throw rpc('unavailable', 'artifact not found');
    }
    const declared = new Set(
      Object.keys(record.capabilities).map((n) =>
        n === 'self' ? 'artifact' : n,
      ),
    );
    const namespace = method.split('.')[0];
    if (!declared.has(namespace)) {
      throw rpc('not_declared', `the page does not declare ${namespace}`);
    }
    switch (method) {
      case 'user.id':
        return this.options.service.getOwnerId();
      case 'user.canEdit':
      case 'user.isOwner':
        return true;
      case 'user.profiles': {
        const owner = await this.options.service.getOwnerId();
        const ids = Array.isArray(params['ids']) ? params['ids'] : [];
        return ids
          .filter((v): v is string => typeof v === 'string' && v === owner)
          .map((uid) => ({ id: uid, name: 'You' }));
      }
      case 'artifact.publish': {
        const html = params['html'];
        if (typeof html !== 'string' || !/^\s*<!doctype html>/i.test(html)) {
          throw rpc(
            'invalid_content',
            'publish(html) needs a complete document starting with <!doctype html>',
          );
        }
        const body = unwrapDocument(html);
        const base = readNumber({ type: 'rpc', ...params }, 'base');
        try {
          const outcome = await store.publish(
            id,
            {
              body,
              format: 'html',
              source: 'page',
              title: extractTitle(body) ?? record.title,
            },
            base,
          );
          return { version: outcome.version.n };
        } catch (error) {
          if (error instanceof ArtifactStoreError) {
            const live = (await store.get(id))?.latestVersion;
            const code =
              error.code === 'conflict'
                ? 'conflict'
                : error.code === 'too_large'
                  ? 'too_large'
                  : 'invalid_content';
            throw rpc(code, error.message, { live });
          }
          throw error;
        }
      }
      case 'db.get':
      case 'db.query':
      case 'db.set':
      case 'db.update':
      case 'db.delete':
      case 'db.acquire':
      case 'db.subscribe':
      case 'db.unsubscribe':
        return this.dispatchDb(id, record, method, params, ws);
      default:
        throw rpc(
          'capability_disabled',
          `${method} is not served by this host yet`,
        );
    }
  }
}

interface RpcError {
  code: string;
  message: string;
  [extra: string]: unknown;
}

function rpc(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): RpcError {
  return { code, message, ...extra };
}

function isRpcError(value: unknown): value is RpcError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof value.code === 'string' &&
    typeof value.message === 'string'
  );
}

function rpcError(error: unknown): RpcError {
  if (isRpcError(error)) return error;
  return rpc(
    'upstream_error',
    error instanceof Error ? error.message : String(error),
  );
}

/** One live `onSnapshot` registration on a runtime socket. */
interface LiveSubscription {
  readonly id: number;
  readonly artifactId: ArtifactId;
  readonly target: { readonly path: string } | { readonly spec: QuerySpec };
}
