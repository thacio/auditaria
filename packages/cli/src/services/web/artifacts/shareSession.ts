/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_ARTIFACTS: ephemeral public sharing of ONE artifact.

import { randomBytes } from 'node:crypto';
import express from 'express';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import {
  wrapDocument,
  renderMarkdown,
  usesMermaid,
  MARKDOWN_STYLE,
  isAssetId,
  type ArtifactId,
  type ArtifactService,
} from '@google/gemini-cli-core';
import type { WebLogger } from '../core/types.js';
import { buildArtifactCsp } from './artifactHost.js';

/**
 * A running public share. Nothing here is ever written to disk: the
 * listener, the tunnel process and the access token die with the Auditaria
 * process, so a share is valid for the current session only — which is the
 * whole point. Publishing again mints a new address.
 */
export interface ShareState {
  readonly id: ArtifactId;
  /** The public address to hand out: `https://<random>.trycloudflare.com/s/<token>`. */
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

const COOKIE_NAME = 'auditaria_share';
/** Cookie lifetime; the share itself ends with the process anyway. */
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 3600;
/** Cap on concurrent requests; a quick tunnel allows ~200 in flight. */
const MAX_IN_FLIGHT = 32;

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Serves exactly one artifact behind a capability link. The listener knows
 * nothing about the console: it is a separate Express app bound to a random
 * loopback port and imports none of the console routes, so nothing but this
 * artifact can ever be reached through the tunnel.
 *
 * Reduced runtime: the page and its runtime script are served, but no
 * capability is granted (every `use()` resolves `null`), so visitors can
 * read and interact locally and never write back to the store.
 */
export class ShareSession {
  private server: Server | null = null;
  private tunnel: TunnelLike | null = null;
  private token = '';
  private inFlight = 0;
  private state: ShareState | null = null;

  constructor(
    readonly id: ArtifactId,
    private readonly options: ShareSessionOptions,
  ) {}

  get current(): ShareState | null {
    return this.state;
  }

  /** The loopback port of the private listener (for tests). */
  get localPort(): number | null {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address.port : null;
  }

  async start(): Promise<ShareState> {
    if (this.state) return this.state;
    this.token = newToken();
    const app = this.buildApp();
    this.server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = this.localPort;
    if (port === null) throw new Error('share listener did not bind');
    try {
      this.tunnel = await this.options.tunnelFactory(port);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.state = {
      id: this.id,
      url: `${this.tunnel.url.replace(/\/$/, '')}/s/${this.token}`,
      startedAt: new Date().toISOString(),
    };
    return this.state;
  }

  async stop(): Promise<void> {
    this.state = null;
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
    this.token = '';
  }

  private hasCookie(cookieHeader: string | undefined): boolean {
    if (!cookieHeader || !this.token) return false;
    for (const part of cookieHeader.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE_NAME && timingSafeEqual(rest.join('='), this.token)) {
        return true;
      }
    }
    return false;
  }

  private buildApp(): express.Express {
    const { service, logger, runtimeDir } = this.options;
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', false);

    app.use((req, res, next) => {
      if (this.inFlight >= MAX_IN_FLIGHT) {
        res.status(503).type('text/plain').send('Busy');
        return;
      }
      this.inFlight++;
      res.on('finish', () => {
        this.inFlight--;
      });
      res.on('close', () => {
        if (!res.writableFinished) this.inFlight--;
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      next();
    });

    app.get('/robots.txt', (_req, res) => {
      res.type('text/plain').send('User-agent: *\nDisallow: /\n');
    });

    // The capability link: exchange the token for an HttpOnly cookie.
    app.get('/s/:token', (req, res) => {
      const token = req.params['token'];
      if (!this.token || !timingSafeEqual(token, this.token)) {
        res.status(404).type('text/plain').send('This link is not active.');
        return;
      }
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${this.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
      );
      res.redirect(302, '/');
    });

    // Everything below needs the cookie.
    app.use((req, res, next) => {
      if (this.hasCookie(req.headers.cookie)) {
        next();
        return;
      }
      res.status(404).type('text/plain').send('This link is not active.');
    });

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
        let fragment = body;
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
        res.setHeader(
          'Content-Security-Policy',
          buildArtifactCsp(["'none'"]).replace(
            "frame-ancestors 'self' 'none'",
            "frame-ancestors 'none'",
          ),
        );
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(wrapDocument({ body: fragment, runtimeHead, extraHead }));
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
        res.sendFile(assets.fileOf(asset));
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
        maxAge: '5m',
      }),
    );

    app.use((_req, res) => {
      res.status(404).type('text/plain').send('Not Found');
    });
    return app;
  }
}

/** Owns every live share of the process; tears them all down at exit. */
export class ShareManager {
  private readonly sessions = new Map<ArtifactId, ShareSession>();

  constructor(private readonly options: ShareSessionOptions) {}

  get(id: ArtifactId): ShareState | null {
    return this.sessions.get(id)?.current ?? null;
  }

  states(): ShareState[] {
    return Array.from(this.sessions.values())
      .map((s) => s.current)
      .filter((s): s is ShareState => s !== null);
  }

  async start(id: ArtifactId): Promise<ShareState> {
    let session = this.sessions.get(id);
    if (!session) {
      session = new ShareSession(id, this.options);
      this.sessions.set(id, session);
    }
    try {
      const state = await session.start();
      // History records WHERE it was shared, never the capability token.
      const origin = new URL(state.url).origin;
      await (await this.options.service.getStore())
        .noteShare(id, origin)
        .catch(() => undefined);
      return state;
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }
  }

  async stop(id: ArtifactId): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.stop();
    await (await this.options.service.getStore())
      .noteShare(id, null)
      .catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys());
    await Promise.all(ids.map((id) => this.stop(id)));
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
