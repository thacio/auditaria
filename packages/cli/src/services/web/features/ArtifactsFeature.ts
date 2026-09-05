/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_ARTIFACTS: hosts artifacts on their own origins and feeds the gallery.

import type { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ArtifactStoreError,
  DbError,
  SampleError,
  SAMPLE_MAX_PROMPT_BYTES,
  MAX_SUBSCRIPTIONS_PER_VIEW,
  type ModelTier,
  collectionOf,
  idOf,
  mayAccess,
  normalizeQuerySpec,
  validateRules,
  type AccessRule,
  type ArtifactDb,
  type ArtifactRecord,
  type CommentStore,
  type CommentThread,
  type QuerySpec,
  type StoredDoc,
  type Viewer,
  artifactHostname,
  artifactUrl,
  viewerUrl,
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
import {
  ShareManager,
  type ShareState,
  type TunnelFactory,
} from '../artifacts/shareSession.js';
import { startQuickTunnel } from '../../hive/HiveTunnel.js';
import { registerCleanup } from '../../../utils/cleanup.js';

/** What the gallery receives per artifact. */
export interface ArtifactListRow extends ArtifactSummary {
  readonly url: string;
  readonly hostname: string;
  /** Public address while shared in this session, else null. */
  readonly shareUrl: string | null;
  /** The console viewer (page + chrome): the address people get. */
  readonly viewerUrl: string;
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
  /** Comment stores whose events already reach the gallery and the agent. */
  private readonly wiredComments = new WeakSet<CommentStore>();
  /** Files a page offered, keyed by their one-time token. */
  private readonly downloads = new Map<string, PendingDownload>();
  /** Pages waiting for the owner to allow model calls, per artifact. */
  private readonly consentWaiters = new Map<
    ArtifactId,
    Set<(allowed: boolean) => void>
  >();
  /** Model calls in flight per artifact (a page cannot flood the model). */
  private readonly samplesInFlight = new Map<ArtifactId, number>();
  /** Recent answers, replayed for identical prompts (the contract's cache). */
  private readonly sampleCache = new Map<string, CachedSample>();
  /** Abort controllers of running model calls, per socket and request. */
  private readonly sampleAborts = new Map<
    WebSocket,
    Map<number, AbortController>
  >();
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
        takeDownload: (token) => this.takeDownload(token),
        discardDownload: (token) => this.discardDownload(token),
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
    inbound.on('artifact_comments_request', (message, ws) =>
      this.sendComments(message, ws),
    );
    inbound.on('artifact_comment_request', (message, ws) =>
      this.comment(message, ws),
    );
    inbound.on('artifact_download_decision', (message) =>
      this.decideDownload(message),
    );

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
      share: async (id) => {
        const state = await this.startShare(id);
        return { url: state.url };
      },
      unshare: (id) => this.stopShare(id),
      shareUrlOf: (id) => this.shares?.get(id)?.url ?? null,
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
      viewerUrl: viewerUrl(row.id, port),
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
        case 'sample_consent': {
          const consent = message['consent'] === true;
          await store.setSampleConsent(id, consent);
          this.settleSampleConsent(id, consent);
          break;
        }
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

  /** Opens a session-only public share; every console hears about it. */
  async startShare(id: ArtifactId): Promise<ShareState> {
    const shares = this.shares;
    if (!shares) throw new Error('the web interface is not running');
    await (await this.options.service.getStore()).require(id);
    try {
      const state = await shares.start(id);
      this.broadcast('artifact_share_state', {
        id,
        url: state.url,
        startedAt: state.startedAt,
      });
      return state;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.ctx?.logger.error('Artifact share failed:', error);
      this.broadcast('artifact_share_state', { id, url: null, error: text });
      throw error;
    } finally {
      void this.broadcastList();
    }
  }

  async stopShare(id: ArtifactId): Promise<void> {
    const shares = this.shares;
    if (!shares) return;
    await shares.stop(id);
    this.broadcast('artifact_share_state', { id, url: null });
    void this.broadcastList();
  }

  /** The viewer's Publish / Unpublish button. */
  private async share(message: ClientMessage): Promise<void> {
    const id = this.idOf(message);
    if (!id) return;
    const op = readString(message, 'op');
    try {
      if (op === 'start') await this.startShare(id);
      else if (op === 'stop') await this.stopShare(id);
    } catch {
      /* already broadcast as artifact_share_state with an error */
    }
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
  // sample: a page asks the model. The call spends the OWNER's provider
  // quota, so the owner allows it once per artifact; the first call while
  // unallowed asks through the console and waits for the answer. Calls are
  // tool-less and memory-less, capped per artifact, and cached briefly.
  // ---------------------------------------------------------------------

  private async dispatchSample(
    id: ArtifactId,
    record: ArtifactRecord,
    method: string,
    params: Record<string, unknown>,
    ws: WebSocket,
  ): Promise<unknown> {
    const envelope: ClientMessage = { type: 'rpc', ...params };
    if (method === 'sample.limits') {
      return { maxPromptBytes: SAMPLE_MAX_PROMPT_BYTES };
    }
    if (method === 'sample.cancel') {
      const requestId = readNumber(envelope, 'requestId');
      if (requestId !== undefined) {
        this.sampleAborts.get(ws)?.get(requestId)?.abort();
      }
      return null;
    }
    const sampler = this.options.service.getSampler();
    if (!sampler) throw rpc('capability_disabled', 'no model is available');
    if (!(await this.ensureSampleConsent(id, record))) {
      throw rpc(
        'not_granted',
        "the owner has not allowed this page to ask the model (allow it from the artifact's viewer)",
      );
    }
    const inFlight = this.samplesInFlight.get(id) ?? 0;
    if (inFlight >= SAMPLE_MAX_IN_FLIGHT) {
      throw rpc('rate_limited', 'too many model calls in flight for this page');
    }
    const requestId = readNumber(envelope, 'requestId') ?? 0;
    const tierRaw = readString(envelope, 'modelTier');
    const tier: ModelTier =
      tierRaw === 'quick' || tierRaw === 'complex' ? tierRaw : 'default';
    const useCache = params['cache'] !== false;
    const cacheKey = `${id}:${tier}:${JSON.stringify(params['input'])}`;
    const cached = useCache ? this.sampleCache.get(cacheKey) : undefined;
    if (cached && cached.at + SAMPLE_CACHE_TTL_MS > Date.now()) {
      ws.send(
        JSON.stringify({
          push: 'sample.text',
          data: { requestId, text: cached.text, delta: cached.text },
        }),
      );
      return {
        text: cached.text,
        truncated: cached.truncated,
        modelTierApplied: cached.modelTierApplied,
      };
    }
    const controller = new AbortController();
    const perSocket =
      this.sampleAborts.get(ws) ?? new Map<number, AbortController>();
    perSocket.set(requestId, controller);
    this.sampleAborts.set(ws, perSocket);
    this.samplesInFlight.set(id, inFlight + 1);
    try {
      const result = await sampler({
        input: params['input'],
        modelTier: tier,
        signal: controller.signal,
        onText: (text, delta) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(
              JSON.stringify({
                push: 'sample.text',
                data: { requestId, text, delta },
              }),
            );
          }
        },
      });
      if (useCache) {
        this.sampleCache.set(cacheKey, { ...result, at: Date.now() });
        if (this.sampleCache.size > SAMPLE_CACHE_MAX) {
          const oldest = this.sampleCache.keys().next().value;
          if (oldest !== undefined) this.sampleCache.delete(oldest);
        }
      }
      return result;
    } catch (error) {
      if (error instanceof SampleError) {
        throw rpc(
          error.code,
          error.message,
          error.text ? { text: error.text } : {},
        );
      }
      throw error;
    } finally {
      perSocket.delete(requestId);
      const remaining = (this.samplesInFlight.get(id) ?? 1) - 1;
      if (remaining <= 0) this.samplesInFlight.delete(id);
      else this.samplesInFlight.set(id, remaining);
    }
  }

  /** True once the owner allowed model calls; asks through the console. */
  private async ensureSampleConsent(
    id: ArtifactId,
    record: ArtifactRecord,
  ): Promise<boolean> {
    if (record.sampleConsent) return true;
    if (!this.ctx || this.ctx.clients.size === 0) return false;
    const waiters = this.consentWaiters.get(id) ?? new Set();
    const decision = new Promise<boolean>((resolve) => {
      waiters.add(resolve);
      setTimeout(() => {
        if (waiters.delete(resolve)) resolve(false);
      }, SAMPLE_CONSENT_TIMEOUT_MS).unref();
    });
    if (waiters.size === 1) {
      this.consentWaiters.set(id, waiters);
      this.broadcast('artifact_sample_consent_request', {
        id,
        title: record.title,
      });
    }
    return decision;
  }

  private settleSampleConsent(id: ArtifactId, allowed: boolean): void {
    const waiters = this.consentWaiters.get(id);
    if (!waiters) return;
    this.consentWaiters.delete(id);
    for (const resolve of waiters) resolve(allowed);
  }

  // ---------------------------------------------------------------------
  // downloads: a page never saves a file by itself (the viewer's sandbox
  // forbids it). It hands the bytes to the server, the console shows the
  // viewer a confirmation, and on accept the CONSOLE navigates its own
  // hidden frame to a one-time attachment URL on the artifact origin. With
  // no console connected (a standalone tab) the page navigates itself.
  // ---------------------------------------------------------------------

  private async offerDownload(
    id: ArtifactId,
    record: ArtifactRecord,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const envelope: ClientMessage = { type: 'rpc', ...params };
    const filename = (readString(envelope, 'filename') ?? '').trim();
    if (!filename || filename.length > MAX_DOWNLOAD_FILENAME) {
      throw rpc(
        'invalid_argument',
        'filename is required (at most 512 characters)',
      );
    }
    const safeName = path
      .basename(filename)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ');
    const ext = path.extname(safeName).slice(1).toLowerCase();
    if (!DOWNLOAD_EXTENSIONS.has(ext)) {
      throw rpc(
        'rejected_extension',
        `".${ext || ''}" files cannot be offered; allowed: ${Array.from(DOWNLOAD_EXTENSIONS).join(', ')}`,
      );
    }
    const data = params['data'];
    const dataEnvelope: ClientMessage = isRecord(data)
      ? { type: 'rpc', ...data }
      : { type: 'rpc' };
    const text = readString(dataEnvelope, 'text');
    const base64 = readString(dataEnvelope, 'base64');
    let bytes: Buffer;
    if (text !== undefined) {
      bytes = Buffer.from(text, 'utf-8');
    } else if (base64 !== undefined) {
      bytes = Buffer.from(base64, 'base64');
    } else {
      throw rpc(
        'invalid_argument',
        'data must be a string, Blob, ArrayBuffer or view',
      );
    }
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw rpc(
        'too_large',
        `a download may be at most ${MAX_DOWNLOAD_BYTES} bytes on this host`,
      );
    }
    const store = this.store;
    if (!store) throw rpc('unavailable', 'store is not open');
    const token = randomBytes(18).toString('base64url');
    const dir = path.join(store.paths(id).root, 'downloads');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${token}.${ext}`);
    await writeFile(file, bytes, { flag: 'wx' });
    const offer: PendingDownload = {
      token,
      artifactId: id,
      file,
      filename: safeName,
      size: bytes.byteLength,
      type: DOWNLOAD_TYPES[ext] ?? 'application/octet-stream',
      expiresAt: Date.now() + DOWNLOAD_TTL_MS,
    };
    this.downloads.set(token, offer);
    setTimeout(() => {
      void this.discardDownload(token);
    }, DOWNLOAD_TTL_MS).unref();

    const url = `${artifactUrl(id, this.port ?? 0)}__downloads/${token}`;
    if (!this.ctx || this.ctx.clients.size === 0) {
      // Nobody to ask: the page is in a standalone tab and saves itself.
      return { status: 'saved', url };
    }
    const decision = new Promise<boolean>((resolve) => {
      offer.decide = resolve;
    });
    this.broadcast('artifact_download_offer', {
      id,
      title: record.title,
      token,
      filename: safeName,
      size: bytes.byteLength,
      url,
    });
    const accepted = await decision;
    if (!accepted) {
      await this.discardDownload(token);
      throw rpc('declined', 'the viewer declined the download');
    }
    return { status: 'saved' };
  }

  /** The console's answer to an offer. */
  private decideDownload(message: ClientMessage): void {
    const token = readString(message, 'token');
    const offer = token ? this.downloads.get(token) : undefined;
    if (!offer) return;
    const accept = message['accept'] === true;
    offer.decide?.(accept);
    offer.decide = undefined;
  }

  /** Looks up a one-time download for the artifact host route. */
  private takeDownload(token: string): PendingDownload | null {
    const offer = this.downloads.get(token);
    if (!offer || offer.expiresAt < Date.now()) return null;
    return offer;
  }

  private async discardDownload(token: string): Promise<void> {
    const offer = this.downloads.get(token);
    if (!offer) return;
    this.downloads.delete(token);
    offer.decide?.(false);
    await rm(offer.file, { force: true }).catch(() => undefined);
  }

  // ---------------------------------------------------------------------
  // Comments: threads live in the gallery's sidebar; a thread reaches the
  // agent (a notice now, the tool's `comments` action later) only once a
  // person sends it. Every change is broadcast so open sidebars follow.
  // ---------------------------------------------------------------------

  private async commentsFor(id: ArtifactId): Promise<CommentStore> {
    const comments = await this.options.service.getComments(id);
    if (!this.wiredComments.has(comments)) {
      this.wiredComments.add(comments);
      comments.on('change', (thread) => {
        this.broadcast('artifact_comment_event', { id, thread });
      });
      comments.on('activated', (thread) => {
        void this.noticeComments(id, thread);
      });
    }
    return comments;
  }

  private async noticeComments(
    id: ArtifactId,
    thread: CommentThread,
  ): Promise<void> {
    const record = await this.store?.get(id);
    const title = record?.title ?? id;
    this.options.service.pushNotice(
      `Comments are waiting on Artifact: "${title}" (${id}) — thread ${thread.id} was sent to you. Run the artifact tool with action "comments" and url ${id} to read it, then reply or resolve.`,
    );
  }

  private async sendComments(
    message: ClientMessage,
    ws: WebSocket,
  ): Promise<void> {
    const id = this.idOf(message);
    if (!id) return;
    try {
      const comments = await this.commentsFor(id);
      this.send(ws, 'artifact_comments_response', {
        id,
        threads: comments.list(),
      });
    } catch (error) {
      this.ctx?.logger.error('Artifact comments failed:', error);
    }
  }

  /** A viewer's comment action from the sidebar. */
  private async comment(message: ClientMessage, ws: WebSocket): Promise<void> {
    const id = this.idOf(message);
    const store = this.store;
    if (!id || !store) return;
    const op = readString(message, 'op');
    const threadId = readString(message, 'thread_id') ?? '';
    const text = readString(message, 'text') ?? '';
    const anchorText = readString(message, 'anchor');
    const sendToAgent = message['send_to_agent'] === true;
    try {
      const record = await store.require(id);
      const comments = await this.commentsFor(id);
      switch (op) {
        case 'create':
          await comments.create({
            version: record.latestVersion,
            author: 'user',
            text,
            anchor: anchorText ? { text: anchorText } : null,
            sendToAgent,
          });
          break;
        case 'reply':
          await comments.reply(threadId, { author: 'user', text, sendToAgent });
          break;
        case 'activate':
          await comments.activate(threadId);
          break;
        case 'resolve':
          await comments.resolve(threadId, 'user');
          break;
        case 'reopen':
          await comments.reopen(threadId);
          break;
        default:
          this.ctx?.logger.warn(`Unknown comment op: ${String(op)}`);
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.send(ws, 'artifact_comment_event', { id, error: text });
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
      case 'downloads.save':
        return this.offerDownload(id, record, params);
      case 'sample':
      case 'sample.limits':
      case 'sample.cancel':
        return this.dispatchSample(id, record, method, params, ws);
      case 'assets.list': {
        const assets = await this.options.service.getAssets(id);
        const page = assets.list({
          after: readString({ type: 'rpc', ...params }, 'after'),
        });
        return {
          assets: page.assets.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            size: a.size,
            url: `/__assets/${a.id}`,
          })),
          next: page.next,
        };
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

/** A file a page offered the viewer, waiting for the decision or the fetch. */
interface PendingDownload {
  readonly token: string;
  readonly artifactId: ArtifactId;
  readonly file: string;
  readonly filename: string;
  readonly size: number;
  readonly type: string;
  readonly expiresAt: number;
  decide?: (accept: boolean) => void;
}

const MAX_DOWNLOAD_FILENAME = 512;
/** Claude's ordinary saves are unlimited; this host caps the socket payload. */
const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_TTL_MS = 5 * 60 * 1000;
/** The contract's allowlist (both lists enabled here). */
const DOWNLOAD_EXTENSIONS: ReadonlySet<string> = new Set([
  'gif',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'mp4',
  'webm',
  'txt',
  'json',
  'md',
  'docx',
  'pptx',
  'epub',
  'csv',
  'ttf',
  'html',
  'svg',
  'pdf',
  'xlsx',
]);
const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
  csv: 'text/csv; charset=utf-8',
  ttf: 'font/ttf',
  html: 'text/html; charset=utf-8',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** A recent model answer, replayed for the same prompt within the TTL. */
interface CachedSample {
  readonly text: string;
  readonly truncated: boolean;
  readonly modelTierApplied: ModelTier;
  readonly at: number;
}

const SAMPLE_MAX_IN_FLIGHT = 2;
const SAMPLE_CACHE_TTL_MS = 5 * 60 * 1000;
const SAMPLE_CACHE_MAX = 200;
const SAMPLE_CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
