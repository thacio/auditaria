/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import path from 'node:path';
import { ArtifactStore } from './artifactStore.js';
import { artifactUrl, viewerUrl } from './artifactPaths.js';
import { AssetStore } from './assets.js';
import type { Sampler } from './sampleExecutor.js';
import { CommentStore } from './comments.js';
import { ArtifactDb } from './dbStore.js';
import { loadOwnerIdentity, type OwnerIdentity } from './identity.js';
import type { ArtifactId } from './types.js';

/**
 * What the CLI side plugs in when the web server runs. Core never imports
 * the CLI; the web feature registers itself here (the `providerPtyMirror`
 * precedent), so the tool works headless and lights up when hosting exists.
 */
export interface ArtifactHost {
  /** The port the console listens on, when the web interface is running. */
  getPort(): number | null;
  /** Opens a URL in the user's browser; resolves false when it could not. */
  openInBrowser(url: string): Promise<boolean>;
  /**
   * Surfaces a notice to the user outside the model's turn (republish by
   * the page, comments waiting, …). Delivery is the host's business.
   */
  notify(text: string): void;
  /**
   * Opens a public, session-only share of an artifact (the viewer's
   * Publish button) and resolves its address; absent when sharing is not
   * available on this host.
   */
  share?(id: ArtifactId): Promise<{ url: string }>;
  unshare?(id: ArtifactId): Promise<void>;
  /** The public address while shared in this session, else null. */
  shareUrlOf?(id: ArtifactId): string | null;
}

/** A base-version handle tracked per artifact in one session. */
interface TrackedArtifact {
  baseVersion: number;
  /** Set once this session published it at least once. */
  publishedHere: boolean;
}

/**
 * Session-level state for the artifact tool plus access to the store and
 * the CLI host seam. One instance per Auditaria process (one per `Config`),
 * shared by every provider and sub-agent that runs in-process — which is
 * why the same file path from any of them redeploys the same artifact.
 */
export class ArtifactService {
  private store: ArtifactStore | null = null;
  private storePromise: Promise<ArtifactStore> | null = null;
  private identity: OwnerIdentity | null = null;
  private host: ArtifactHost | null = null;
  private readonly filePathToId = new Map<string, ArtifactId>();
  private readonly tracked = new Map<ArtifactId, TrackedArtifact>();
  private readonly dbs = new Map<ArtifactId, ArtifactDb>();
  private readonly comments = new Map<ArtifactId, CommentStore>();
  private readonly assets = new Map<ArtifactId, AssetStore>();
  private sampler: Sampler | null = null;
  /** Notices to prepend to the next tool result, oldest first. */
  private readonly pendingNotices: string[] = [];
  /** Most recently published or attached artifact of this session. */
  private recentId: ArtifactId | null = null;

  constructor(
    /** `<project>/.auditaria` (or `.gemini`). */
    readonly projectConfigDir: string,
    /** `~/.auditaria` (or `~/.gemini`). */
    readonly globalConfigDir: string,
  ) {}

  get storeRoot(): string {
    return ArtifactStore.rootFor(this.projectConfigDir);
  }

  /** Lazily opens the store (creating nothing on disk until a publish). */
  async getStore(): Promise<ArtifactStore> {
    if (this.store) return this.store;
    this.storePromise ??= (async () => {
      const store = new ArtifactStore(this.storeRoot);
      await store.load();
      this.store = store;
      return store;
    })();
    return this.storePromise;
  }

  /** The store when already opened (for synchronous event wiring). */
  peekStore(): ArtifactStore | null {
    return this.store;
  }

  /** The model-call engine for pages that declare `sample` (set by Config). */
  setSampler(sampler: Sampler | null): void {
    this.sampler = sampler;
  }

  getSampler(): Sampler | null {
    return this.sampler;
  }

  /** The files attached to one artifact, opened on first use. */
  async getAssets(id: ArtifactId): Promise<AssetStore> {
    const store = await this.getStore();
    await store.require(id);
    let assets = this.assets.get(id);
    if (!assets) {
      assets = new AssetStore(store.paths(id).assetsDir);
      this.assets.set(id, assets);
    }
    await assets.load();
    return assets;
  }

  /** The comment threads of one artifact, opened on first use. */
  async getComments(id: ArtifactId): Promise<CommentStore> {
    const store = await this.getStore();
    await store.require(id);
    let comments = this.comments.get(id);
    if (!comments) {
      comments = new CommentStore(store.paths(id).comments);
      this.comments.set(id, comments);
    }
    await comments.load();
    return comments;
  }

  /** The document database of one artifact, opened on first use. */
  async getDb(id: ArtifactId): Promise<ArtifactDb> {
    const store = await this.getStore();
    await store.require(id);
    let db = this.dbs.get(id);
    if (!db) {
      db = new ArtifactDb(store.paths(id).db);
      this.dbs.set(id, db);
    }
    await db.load();
    return db;
  }

  async getOwnerId(): Promise<string> {
    this.identity ??= await loadOwnerIdentity(this.globalConfigDir);
    return this.identity.ownerId;
  }

  // ---------------------------------------------------------------------
  // Host seam
  // ---------------------------------------------------------------------

  setHost(host: ArtifactHost | null): void {
    this.host = host;
  }

  getHost(): ArtifactHost | null {
    return this.host;
  }

  /** The bare page's URL on its own origin, or null when not hosted. */
  urlFor(id: ArtifactId): string | null {
    const port = this.host?.getPort() ?? null;
    return port === null ? null : artifactUrl(id, port);
  }

  /** The console viewer's URL (page + chrome), or null when not hosted. */
  viewerUrlFor(id: ArtifactId): string | null {
    const port = this.host?.getPort() ?? null;
    return port === null ? null : viewerUrl(id, port);
  }

  // ---------------------------------------------------------------------
  // Session change listeners (the terminal's artifact strip follows them)
  // ---------------------------------------------------------------------

  private readonly sessionListeners = new Set<() => void>();

  onSessionChange(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  private notifySessionChange(): void {
    for (const listener of this.sessionListeners) {
      try {
        listener();
      } catch {
        /* a listener must not break the service */
      }
    }
  }

  /** Ids this session published or attached, most recent last. */
  sessionArtifactIds(): ArtifactId[] {
    return Array.from(this.tracked.keys());
  }

  // ---------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------

  /** Normalizes a file path so the same file always maps to the same key. */
  static pathKey(filePath: string): string {
    return path.resolve(filePath).toLowerCase();
  }

  idForPath(filePath: string): ArtifactId | undefined {
    return this.filePathToId.get(ArtifactService.pathKey(filePath));
  }

  rememberPath(filePath: string, id: ArtifactId): void {
    this.filePathToId.set(ArtifactService.pathKey(filePath), id);
  }

  /** The base version this session last read or published, if any. */
  baseVersionOf(id: ArtifactId): number | undefined {
    return this.tracked.get(id)?.baseVersion;
  }

  hasPublishedHere(id: ArtifactId): boolean {
    return this.tracked.get(id)?.publishedHere === true;
  }

  track(id: ArtifactId, baseVersion: number, published: boolean): void {
    const existing = this.tracked.get(id);
    // Re-inserting keeps "most recent last" ordering for the strip.
    this.tracked.delete(id);
    this.tracked.set(id, {
      baseVersion,
      publishedHere: published || existing?.publishedHere === true,
    });
    this.recentId = id;
    this.notifySessionChange();
  }

  untrack(id: ArtifactId): void {
    this.tracked.delete(id);
    for (const [key, value] of this.filePathToId) {
      if (value === id) this.filePathToId.delete(key);
    }
    if (this.recentId === id) this.recentId = null;
    this.notifySessionChange();
  }

  trackedIds(): ArtifactId[] {
    return Array.from(this.tracked.keys());
  }

  getRecentId(): ArtifactId | null {
    return this.recentId;
  }

  // ---------------------------------------------------------------------
  // Notices (republish by the page, comments) — delivered at the next
  // tool call AND through the host, so both the model and the user hear.
  // ---------------------------------------------------------------------

  pushNotice(text: string): void {
    this.pendingNotices.push(text);
    this.host?.notify(text);
  }

  /** Queues a notice for the model only (the user already saw it). */
  queueNotice(text: string): void {
    this.pendingNotices.push(text);
  }

  drainNotices(): string[] {
    return this.pendingNotices.splice(0);
  }
}
