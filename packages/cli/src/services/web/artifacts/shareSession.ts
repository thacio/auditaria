/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_ARTIFACTS: ephemeral public shares behind one isolated listener and tunnel.

import { randomBytes } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import * as fsp from 'node:fs/promises';
import {
  wrapDocument,
  stripDocumentShell,
  renderMarkdown,
  usesMermaid,
  MARKDOWN_STYLE,
  isAssetId,
  type ArtifactId,
  type ArtifactService,
} from '@google/gemini-cli-core';
import type { WebLogger } from '../core/types.js';
import { buildArtifactCsp } from './artifactHost.js';
import { scopeShareCss, scopeShareHtml } from './sharePaths.js';

/**
 * A running public share. Nothing here is ever written to disk: the
 * listener, the tunnel process and the access token die with the Auditaria
 * process, so a share is valid for the current session only — which is the
 * whole point. Publishing after revocation mints a new address.
 */
export interface ShareState {
  readonly id: ArtifactId;
  /** The public address to hand out: `https://<random>.trycloudflare.com/s/<token>/`. */
  readonly url: string;
  readonly startedAt: string;
}

export interface TunnelLike {
  readonly url: string;
  stop(): void;
}

export type TunnelFactory = (localPort: number) => Promise<TunnelLike>;

export interface ShareSessionOptions {
  readonly service: ArtifactService;
  readonly logger: WebLogger;
  readonly runtimeDir: string;
  /** Opens the public tunnel to a loopback port (cloudflared in production). */
  readonly tunnelFactory: TunnelFactory;
}

/** Shared across all artifacts to bound work on the public listener. */
const MAX_IN_FLIGHT = 32;

/** A read-only router; transport lifetime belongs exclusively to ShareManager. */
class ShareSession {
  private readonly responses = new Set<express.Response>();
  readonly token = randomBytes(24).toString('base64url');
  readonly basePath = `/s/${this.token}/`;
  readonly router: express.Express;
  readonly state: ShareState;

  constructor(
    readonly id: ArtifactId,
    private readonly options: ShareSessionOptions,
    origin: string,
  ) {
    this.state = {
      id,
      url: `${origin}${this.basePath}`,
      startedAt: new Date().toISOString(),
    };
    this.router = this.buildApp();
  }

  track(res: express.Response): void {
    this.responses.add(res);
    const release = () => this.responses.delete(res);
    res.once('finish', release);
    res.once('close', release);
  }

  revoke(): void {
    // A download already in flight must not survive unpublishing this share.
    for (const res of this.responses) res.destroy();
    this.responses.clear();
  }

  /**
   * Paths are not browser origins. Give every document an opaque origin,
   * including SVG/HTML attachments, so shares cannot share DOM, storage or
   * service workers. Restrict network loads to this capability's directory.
   */
  get csp(): string {
    return (
      buildArtifactCsp(["'none'"])
        .replace("frame-ancestors 'self' 'none'", "frame-ancestors 'none'")
        .replace(/'self'/g, this.state.url)
        .replace(/worker-src [^;]+/, "worker-src 'none'")
        .replace(/frame-src [^;]+/, "frame-src 'none'")
        .replace(/form-action [^;]+/, "form-action 'none'") +
      '; sandbox allow-scripts allow-downloads'
    );
  }

  private buildApp(): express.Express {
    const { service, logger, runtimeDir } = this.options;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);

    app.get('/', async (_req, res) => {
      try {
        const store = await service.getStore();
        const record = await store.get(this.id);
        const version =
          record && !record.deletedAt
            ? await store.servedVersion(this.id)
            : null;
        if (!record || !version) {
          res
            .status(404)
            .type('text/plain')
            .send('This artifact is no longer available.');
          return;
        }
        const body = await store.readBody(this.id, version.n);
        let fragment = version.site ? stripDocumentShell(body) : body;
        let extraHead = '';
        if (version.format === 'markdown') {
          fragment = `<title>${escapeHtml(version.title)}</title>${renderMarkdown(body)}`;
          extraHead = MARKDOWN_STYLE;
        }
        if (usesMermaid(fragment)) {
          extraHead +=
            '<script src="/__rt/mermaid.min.js"></script>' +
            '<script>if(window.mermaid){mermaid.initialize({startOnLoad:true,securityLevel:"strict"})}</script>';
        }
        // No grants on a public share: use() resolves null for everything.
        const frameConfig = {
          id: this.id,
          version: version.n,
          grants: [],
          consoleOrigins: [],
          shared: true,
        };
        const runtimeHead =
          `<script>window.__AUDITARIA_FRAME=${JSON.stringify(frameConfig).replace(/</g, '\\u003c')}</script>` +
          `<script src="/__rt/claude.js"></script>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(
          scopeShareHtml(
            wrapDocument({ body: fragment, runtimeHead, extraHead }),
            this.basePath,
          ),
        );
      } catch (error) {
        logger.error('Share listener error:', error);
        if (!res.headersSent) res.status(500).type('text/plain').send('Error');
      }
    });

    // Attached files are part of the page; served read-only, immutable.
    app.get('/__assets/:assetId', async (req, res) => {
      const assetId = req.params['assetId'];
      try {
        const assets = await service.getAssets(this.id);
        const asset = isAssetId(assetId)
          ? assets.get(assetId)
          : assets.byName(decodeURIComponent(assetId));
        if (!asset) {
          res.status(404).type('text/plain').send('Not Found');
          return;
        }
        res.setHeader('Content-Type', asset.type);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.sendFile(assets.fileOf(asset), { cacheControl: false });
      } catch (error) {
        logger.error('Share asset error:', error);
        if (!res.headersSent) res.status(500).type('text/plain').send('Error');
      }
    });

    app.use(
      '/__rt',
      express.static(runtimeDir, {
        index: false,
        dotfiles: 'deny',
        cacheControl: false,
      }),
    );

    // Multi-file sites: the version's files at their own paths (behind the
    // capability path, like everything above). Pages get the same read-only wrap as
    // the entry; other files are served as-is.
    app.get('/*', async (req, res) => {
      try {
        const store = await service.getStore();
        const record = await store.get(this.id);
        const version =
          record && !record.deletedAt
            ? await store.servedVersion(this.id)
            : null;
        const hit = version?.site
          ? await store.siteFile(this.id, version.n, req.path)
          : null;
        if (!version || !hit) {
          res.status(404).type('text/plain').send('Not Found');
          return;
        }
        if (path.extname(hit.file).toLowerCase() === '.css') {
          res
            .type('css')
            .send(
              scopeShareCss(
                await fsp.readFile(hit.file, 'utf-8'),
                this.basePath,
              ),
            );
          return;
        }
        if (!hit.html) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.sendFile(path.basename(hit.file), {
            root: path.dirname(hit.file),
            dotfiles: 'deny',
            cacheControl: false,
          });
          return;
        }
        const fragment = stripDocumentShell(
          await fsp.readFile(hit.file, 'utf-8'),
        );
        const extraHead = usesMermaid(fragment)
          ? '<script src="/__rt/mermaid.min.js"></script>' +
            '<script>if(window.mermaid){mermaid.initialize({startOnLoad:true,securityLevel:"strict"})}</script>'
          : '';
        const frameConfig = {
          id: this.id,
          version: version.n,
          grants: [],
          consoleOrigins: [],
          shared: true,
        };
        const runtimeHead =
          `<script>window.__AUDITARIA_FRAME=${JSON.stringify(frameConfig).replace(/</g, '\\u003c')}</script>` +
          `<script src="/__rt/claude.js"></script>`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(
          scopeShareHtml(
            wrapDocument({ body: fragment, runtimeHead, extraHead }),
            this.basePath,
          ),
        );
      } catch (error) {
        logger.error('Share listener error:', error);
        if (!res.headersSent) res.status(500).type('text/plain').send('Error');
      }
    });

    app.use((_req, res) => {
      res.status(404).type('text/plain').send('Not Found');
    });
    return app;
  }
}

/** Owns one public transport and independent, revocable shares. */
export class ShareManager {
  private readonly sessions = new Map<ArtifactId, ShareSession>();
  private readonly tokens = new Map<string, ShareSession>();
  private server: Server | null = null;
  private tunnel: TunnelLike | null = null;
  private inFlight = 0;
  // Serialize transport changes, including simultaneous publish/unpublish and
  // shutdown during tunnel startup. A failed operation must not poison the queue.
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ShareSessionOptions) {}

  get localPort(): number | null {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address.port : null;
  }

  get(id: ArtifactId): ShareState | null {
    return this.sessions.get(id)?.state ?? null;
  }

  states(): ShareState[] {
    return Array.from(this.sessions.values(), (session) => session.state);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  start(id: ArtifactId): Promise<ShareState> {
    return this.enqueue(async () => {
      const existing = this.get(id);
      if (existing) return existing;
      const store = await this.options.service.getStore();
      await store.require(id);
      await this.openTransport();
      const session = new ShareSession(
        id,
        this.options,
        new URL(this.tunnel!.url).origin,
      );
      this.sessions.set(id, session);
      this.tokens.set(session.token, session);
      // History records WHERE it was shared, never the capability token.
      await store
        .noteShare(id, new URL(session.state.url).origin)
        .catch(() => undefined);
      return session.state;
    });
  }

  stop(id: ArtifactId): Promise<void> {
    return this.enqueue(async () => {
      await this.revoke(id);
      if (this.sessions.size === 0) await this.closeTransport();
    });
  }

  stopAll(): Promise<void> {
    return this.enqueue(async () => {
      const ids = Array.from(this.sessions.keys());
      // Revoke all access before waiting for transport or history I/O.
      for (const session of this.sessions.values()) session.revoke();
      this.sessions.clear();
      this.tokens.clear();
      await this.closeTransport();
      await Promise.all(ids.map((id) => this.noteUnshared(id)));
    });
  }

  private async noteUnshared(id: ArtifactId): Promise<void> {
    try {
      await (await this.options.service.getStore()).noteShare(id, null);
    } catch {
      // History must not prevent transport cleanup.
    }
  }

  private async revoke(id: ArtifactId): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.tokens.delete(session.token);
    session.revoke();
    await this.noteUnshared(id);
  }

  private async openTransport(): Promise<void> {
    if (this.tunnel) return;
    const server = createServer(this.buildApp());
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      const port = this.localPort;
      if (port === null) throw new Error('share listener did not bind');
      const tunnel = await this.options.tunnelFactory(port);
      this.tunnel = tunnel;
      // Only a bare HTTP(S) origin is usable for capability URLs and CSP.
      const url = new URL(tunnel.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      ) {
        throw new Error('Invalid public tunnel origin');
      }
    } catch (error) {
      await this.closeTransport();
      throw error;
    }
  }

  private async closeTransport(): Promise<void> {
    const tunnel = this.tunnel;
    this.tunnel = null;
    try {
      tunnel?.stop();
    } catch {
      /* already gone */
    }
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }

  private buildApp(): express.Express {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    app.use((_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; sandbox",
      );
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
      );
      if (this.inFlight >= MAX_IN_FLIGHT) {
        res.status(503).type('text/plain').send('Busy');
        return;
      }
      this.inFlight++;
      let released = false;
      const release = () => {
        if (!released) this.inFlight--;
        released = true;
      };
      res.once('finish', release);
      res.once('close', release);
      next();
    });
    app.get('/robots.txt', (_req, res) => {
      res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    });
    app.use('/s/:token', async (req, res, next) => {
      const session = this.tokens.get(req.params['token']);
      if (!session || !['GET', 'HEAD'].includes(req.method)) {
        res.status(404).type('text/plain').send('This link is not active.');
        return;
      }
      session.track(res);
      try {
        const record = await (
          await this.options.service.getStore()
        ).get(session.id);
        // Recheck after I/O in case the share was revoked while reading.
        if (
          !record ||
          record.deletedAt ||
          this.tokens.get(session.token) !== session
        ) {
          res.status(404).type('text/plain').send('This link is not active.');
          return;
        }
        res.setHeader('Content-Security-Policy', session.csp);
        // Sandboxed scripts have opaque origins. Access requires the token in
        // the URL, never ambient cookies; no credentialed CORS is enabled.
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.originalUrl.split('?')[0] === session.basePath.slice(0, -1)) {
          res.redirect(302, session.basePath);
          return;
        }
        session.router(req, res, next);
      } catch (error) {
        this.options.logger.error('Share listener error:', error);
        if (!res.headersSent) res.status(500).type('text/plain').send('Error');
      }
    });
    app.use((_req, res) => {
      res.status(404).type('text/plain').send('Not Found');
    });
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        // Malformed URL escapes and static-file errors must not disclose paths
        // or Express stack traces on this public listener.
        if (!res.headersSent)
          res.status(404).type('text/plain').send('Not Found');
      },
    );
    return app;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Where the runtime script lives beside the web client. */
export function shareRuntimeDir(webClientRoot: string): string {
  return path.join(webClientRoot, 'artifacts', 'runtime');
}
