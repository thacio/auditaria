/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// WEB_INTERFACE_FEATURE: This entire file is part of the web interface implementation
// AUDITARIA_ARTIFACTS: the per-artifact origin — page, versions, runtime script.

import express, { Router, type Request, type Response } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MARKDOWN_STYLE,
  artifactIdFromHostname,
  renderMarkdown,
  usesMermaid,
  wrapDocument,
  stripDocumentShell,
  isAssetId,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactService,
  type ArtifactVersion,
} from '@google/gemini-cli-core';
import type { VirtualHost, WebLogger } from '../core/types.js';
import { parseHostHeader } from '../core/httpServer.js';

/** Script hosts a page may load from, exactly Claude's list (verified live). */
export const SCRIPT_CDN_ALLOWLIST: readonly string[] = [
  'https://cdnjs.cloudflare.com',
  'https://cdn.jsdelivr.net/pyodide/',
  'https://cdn.jsdelivr.net/gh/python-visualization/',
  'https://cdn.jsdelivr.net/npm/',
  'https://cdn.tailwindcss.com',
  'https://code.jquery.com',
];

/** Environment switch: `AUDITARIA_ARTIFACT_CDN=0` serves fully offline. */
export function effectiveCdnAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  return env['AUDITARIA_ARTIFACT_CDN'] === '0' ? [] : SCRIPT_CDN_ALLOWLIST;
}

/**
 * The response headers every artifact document carries. The policy is
 * Claude's live header verbatim, with `frame-ancestors` pointing at our
 * console instead of claude.ai. `connect-src 'self'` is the load-bearing
 * rule: the injected runtime is the page's only network.
 */
export function buildArtifactCsp(
  consoleOrigins: readonly string[],
  cdn: readonly string[] = effectiveCdnAllowlist(),
): string {
  const scripts = [
    "'self'",
    "'unsafe-inline'",
    "'unsafe-eval'",
    'blob:',
    ...cdn,
  ];
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    "worker-src 'self' blob:",
    "form-action 'self'",
    "frame-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors 'self' ${consoleOrigins.join(' ')}`.trim(),
  ].join('; ');
}

function applyDocumentHeaders(res: Response, csp: string): void {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
}

/** Runtime files live beside the web client, under artifacts/runtime. */
export function runtimeDirFor(webClientRoot: string): string {
  return path.join(webClientRoot, 'artifacts', 'runtime');
}

export interface ArtifactHostOptions {
  readonly service: ArtifactService;
  readonly logger: WebLogger;
  /** Directory holding `claude.js` (and `mermaid.min.js` when vendored). */
  readonly runtimeDir: string;
  /** Console origins allowed to frame artifacts (set once listening). */
  readonly getConsoleOrigins: () => readonly string[];
  /** A one-time download a page offered (feature-owned), or null. */
  readonly takeDownload: (token: string) => {
    readonly artifactId: ArtifactId;
    readonly file: string;
    readonly filename: string;
    readonly type: string;
  } | null;
  /** Forgets a download once served (or when it cannot be served). */
  readonly discardDownload: (token: string) => Promise<void>;
}

/**
 * Builds the virtual host serving every `art-<id>.localhost` origin.
 *
 * Routes (all relative to the artifact origin):
 *   GET /               the served version (pinned or latest); `?v=<n>`
 *   GET /v/<n>/         one immutable version
 *   GET /__rt/claude.js the runtime bootstrap
 *   GET /__rt/mermaid.min.js  (when vendored)
 *   GET /__rt/favicon.svg     the emoji favicon
 *   GET /__runtime/ping       liveness for the console's origin probe
 * Everything else is 404. The runtime WebSocket (`/__runtime/live`) is a
 * hub endpoint, registered by the feature.
 */
export function createArtifactHost(options: ArtifactHostOptions): VirtualHost {
  const { service, logger } = options;
  const runtimeDir = options.runtimeDir;
  const router = Router();

  const resolveArtifact = async (
    req: Request,
    res: Response,
  ): Promise<{ id: ArtifactId; record: ArtifactRecord } | null> => {
    const { hostname } = parseHostHeader(req.headers.host);
    const id = artifactIdFromHostname(hostname);
    if (!id) {
      res.status(404).type('text/plain').send('Not Found');
      return null;
    }
    const store = await service.getStore();
    const record = await store.get(id);
    if (!record || record.deletedAt) {
      res.status(404).type('text/plain').send('This artifact does not exist.');
      return null;
    }
    return { id, record };
  };

  const sendVersion = async (
    req: Request,
    res: Response,
    id: ArtifactId,
    record: ArtifactRecord,
    version: ArtifactVersion,
    immutable: boolean,
    /** A site page's own source, instead of the version's entry body. */
    pageBody?: string,
  ): Promise<void> => {
    const store = await service.getStore();
    const body = pageBody ?? (await store.readBody(id, version.n));
    const rawTheme = req.query['theme'];
    const theme: 'light' | 'dark' | undefined =
      rawTheme === 'dark' ? 'dark' : rawTheme === 'light' ? 'light' : undefined;
    const grants = Object.keys(record.capabilities).map((name) =>
      name === 'self' ? 'artifact' : name,
    );
    const frameConfig = {
      id,
      version: version.n,
      grants: Array.from(new Set(grants)),
      consoleOrigins: options.getConsoleOrigins(),
      theme,
    };
    const runtimeHead =
      `<script>window.__AUDITARIA_FRAME=${JSON.stringify(frameConfig).replace(/</g, '\\u003c')}</script>` +
      `<script src="/__rt/claude.js"></script>` +
      `<link rel="icon" href="/__rt/favicon.svg" type="image/svg+xml">`;

    // Site pages are usually complete documents; the shell wraps fragments.
    let fragment = version.site ? stripDocumentShell(body) : body;
    let extraHead = '';
    if (version.format === 'markdown') {
      fragment = `<title>${escapeHtml(version.title)}</title>${renderMarkdown(body)}`;
      extraHead = MARKDOWN_STYLE;
    }
    if (usesMermaid(fragment)) {
      extraHead +=
        '<script src="/__rt/mermaid.min.js"></script>' +
        '<script>if(window.mermaid){mermaid.initialize({startOnLoad:true,securityLevel:"strict",theme:matchMedia("(prefers-color-scheme: dark)").matches||document.documentElement.getAttribute("data-theme")==="dark"?"dark":"default"})}</script>';
    }
    const html = wrapDocument({
      body: fragment,
      runtimeHead,
      extraHead,
      theme: frameConfig.theme,
    });

    applyDocumentHeaders(res, buildArtifactCsp(options.getConsoleOrigins()));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('ETag', `"${version.sha256.slice(0, 32)}-${version.n}"`);
    res.setHeader(
      'Cache-Control',
      immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
    );
    res.send(html);
  };

  router.get('/', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const store = await service.getStore();
    const requested = Number(req.query['v']);
    const version = Number.isInteger(requested)
      ? await store.version(target.id, requested)
      : await store.servedVersion(target.id);
    if (!version) {
      res.status(404).type('text/plain').send('No such version.');
      return;
    }
    await sendVersion(req, res, target.id, target.record, version, false);
  });

  router.get('/v/:n/', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const n = Number(req.params['n']);
    const version = Number.isInteger(n)
      ? await (await service.getStore()).version(target.id, n)
      : null;
    if (!version) {
      res.status(404).type('text/plain').send('No such version.');
      return;
    }
    await sendVersion(req, res, target.id, target.record, version, true);
  });

  // Multi-file sites: any other path resolves inside the version's folder
  // snapshot. HTML pages are wrapped like the entry (runtime, theme, CSP);
  // everything else is served as-is with its own content type.
  const sendSiteFile = async (
    req: Request,
    res: Response,
    id: ArtifactId,
    record: ArtifactRecord,
    version: ArtifactVersion,
    requestPath: string,
    immutable: boolean,
  ): Promise<void> => {
    const store = await service.getStore();
    const hit = version.site
      ? await store.siteFile(id, version.n, requestPath)
      : null;
    if (!hit) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    if (hit.html) {
      const page = await readFile(hit.file, 'utf-8');
      await sendVersion(req, res, id, record, version, immutable, page);
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Cache-Control',
      immutable ? 'private, max-age=31536000, immutable' : 'no-cache',
    );
    // Relative to its own directory: the dotfile guard must judge the site
    // path (already validated), not the store's `.auditaria` folder.
    res.sendFile(path.basename(hit.file), {
      root: path.dirname(hit.file),
      dotfiles: 'deny',
    });
  };

  router.get('/v/:n/*', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const n = Number(req.params['n']);
    const version = Number.isInteger(n)
      ? await (await service.getStore()).version(target.id, n)
      : null;
    if (!version) {
      res.status(404).type('text/plain').send('No such version.');
      return;
    }
    await sendSiteFile(
      req,
      res,
      target.id,
      target.record,
      version,
      req.path.replace(/^\/v\/\d+\//, ''),
      true,
    );
  });

  router.get('/__rt/favicon.svg', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<text x="32" y="46" font-size="44" text-anchor="middle">${escapeHtml(target.record.favicon)}</text></svg>`;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(svg);
  });

  // Files attached to the artifact (images, fonts, PDFs, …), immutable.
  router.get('/__assets/:assetId', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const assetId = req.params['assetId'];
    const assets = await service.getAssets(target.id);
    // By id (immutable), or by file name so a page can reference an asset
    // uploaded together with it before any id was known.
    const asset = isAssetId(assetId)
      ? assets.get(assetId)
      : assets.byName(decodeURIComponent(assetId));
    if (!asset) {
      res.status(404).type('text/plain').send('Not Found');
      return;
    }
    res.setHeader('Content-Type', asset.type);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(assets.fileOf(asset));
  });

  // A file the page offered and the viewer accepted: served once, as an
  // attachment, then forgotten.
  router.get('/__downloads/:token', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const token = req.params['token'];
    const offer = options.takeDownload(token);
    if (!offer || offer.artifactId !== target.id) {
      res
        .status(404)
        .type('text/plain')
        .send('This download is no longer available.');
      return;
    }
    res.setHeader('Content-Type', offer.type);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${offer.filename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(offer.filename)}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(offer.file, (error?: Error) => {
      if (error) {
        logger.error('Artifact download failed:', error);
        if (!res.headersSent) res.status(500).type('text/plain').send('Error');
        return;
      }
      void options.discardDownload(token);
    });
  });

  router.get('/__runtime/ping', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  });

  // Runtime scripts: plain static files, cached briefly.
  router.use(
    '/__rt',
    express.static(runtimeDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '5m',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
      },
    }),
  );

  // Last: a site's files at their own paths on the served version. Pages
  // (no site) fall through to a plain 404 here.
  router.get('/*', async (req, res) => {
    const target = await resolveArtifact(req, res);
    if (!target) return;
    const store = await service.getStore();
    const version = await store.servedVersion(target.id);
    if (!version) {
      res.status(404).type('text/plain').send('No such version.');
      return;
    }
    await sendSiteFile(
      req,
      res,
      target.id,
      target.record,
      version,
      req.path.replace(/^\/v\/\d+\//, ''),
      false,
    );
  });

  const handler = router;
  return {
    name: 'artifacts',
    matches: (hostname) => artifactIdFromHostname(hostname) !== null,
    handler: (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch((error: unknown) => {
        logger.error('Artifact host error:', error);
        if (!res.headersSent) res.status(500).type('text/plain').send('Error');
      });
    },
  };
}

/** Whether a runtime file is present (diagnostics). */
export async function runtimeScriptExists(
  name: string,
  runtimeDir: string,
): Promise<boolean> {
  try {
    await readFile(path.join(runtimeDir, name));
    return true;
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
