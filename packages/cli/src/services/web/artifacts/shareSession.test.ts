/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from '@google/gemini-cli-core';

// The core package index cannot load under the lean web config (a
// pre-existing core→browser-agent import cycle), so the modules under test
// get the real artifact helpers straight from their own built files.
vi.mock('@google/gemini-cli-core', async () => {
  const [service, shell, paths, store, assets, site] = await Promise.all([
    import('@google/gemini-cli-core/dist/src/artifacts/artifactService.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/htmlShell.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/artifactPaths.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/artifactStore.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/assets.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/site.js'),
  ]);
  return { ...service, ...shell, ...paths, ...store, ...assets, ...site };
});
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import {
  ShareManager,
  type TunnelLike,
  type TunnelFactory,
} from './shareSession.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(
  port: number,
  pathname: string,
  cookie?: string,
  method = 'GET',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: cookie ? { Cookie: cookie } : {},
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('ShareManager', () => {
  let dir: string;
  let service: ArtifactService;
  let runtimeDir: string;
  const managers: ShareManager[] = [];
  const tunnels: Array<TunnelLike & { stop: ReturnType<typeof vi.fn> }> = [];
  const tunnelFactory = vi.fn(async (port: number) => {
    const tunnel = {
      url: `https://fake-${port}.trycloudflare.com`,
      stop: vi.fn(),
    };
    tunnels.push(tunnel);
    return tunnel;
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'artifact-share-'));
    runtimeDir = path.join(dir, 'runtime');
    await writeFile(path.join(dir, 'placeholder'), '');
    await rm(runtimeDir, { recursive: true, force: true });
    await writeFile(path.join(dir, 'claude.js'), '// runtime');
    service = new ArtifactService(
      path.join(dir, '.auditaria'),
      path.join(dir, 'home'),
    );
    tunnels.length = 0;
    tunnelFactory.mockClear();
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
    await rm(dir, { recursive: true, force: true });
  });

  function createManager(
    overrides: Partial<ConstructorParameters<typeof ShareManager>[0]> = {},
  ) {
    const manager = new ShareManager({ ...options(), ...overrides });
    managers.push(manager);
    return manager;
  }

  async function publishOne(): Promise<string> {
    const store = await service.getStore();
    const { record } = await store.publish(undefined, {
      body: '<title>Shared Page</title><h1>Shared</h1>',
      format: 'html',
      source: 'tool',
      title: 'Shared Page',
      favicon: '🔗',
    });
    return record.id;
  }

  const options = () => ({
    service,
    logger: createTestLogger(),
    runtimeDir: dir,
    tunnelFactory,
  });

  it('serves the artifact only behind the capability link', async () => {
    const id = await publishOne();
    const session = createManager();
    const state = await session.start(id);
    const port = session.localPort!;
    expect(state.url).toMatch(
      /^https:\/\/fake-\d+\.trycloudflare\.com\/s\/[A-Za-z0-9_-]{32}\/$/,
    );
    const base = new URL(state.url).pathname;
    const token = base.split('/')[2];

    // Without a capability path nothing is served, not even the runtime.
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, '/__rt/claude.js')).status).toBe(404);
    expect((await get(port, '/s/wrong-token')).status).toBe(404);
    const malformed = await get(port, '/s/%ZZ/');
    expect(malformed.status).toBe(404);
    expect(malformed.body).toBe('Not Found');
    expect((await get(port, base, undefined, 'POST')).status).toBe(404);
    expect((await get(port, base, undefined, 'HEAD')).status).toBe(200);
    const robots = await get(port, '/robots.txt');
    expect(robots.body).toContain('Disallow: /');

    // The bare capability redirects to its directory; no ambient credential.
    const minted = await get(port, `/s/${token}`);
    expect(minted.status).toBe(302);
    expect(minted.headers['location']).toBe(base);
    expect(minted.headers['set-cookie']).toBeUndefined();

    const page = await get(port, base);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1>Shared</h1>');
    expect(page.body).toContain('"grants":[]');
    expect(page.body).toContain('"shared":true');
    expect(String(page.headers['content-security-policy'])).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers['cache-control']).toBe('no-store');
    expect(String(page.headers['x-robots-tag'])).toContain('noindex');
    expect((await get(port, `${base}__rt/claude.js`)).status).toBe(200);
    expect((await get(port, `${base}api/health`)).status).toBe(404);

    await session.stopAll();
    expect(tunnels[0].stop).toHaveBeenCalledTimes(1);
    expect(session.get(id)).toBeNull();
    await expect(get(port, base)).rejects.toBeTruthy();
  });

  it('serves the latest version and disappears with the artifact', async () => {
    const id = await publishOne();
    const store = await service.getStore();
    const session = createManager();
    const state = await session.start(id);
    const port = session.localPort!;
    const base = new URL(state.url).pathname;

    await store.publish(id, {
      body: '<title>Shared Page</title><h1>Shared v2</h1>',
      format: 'html',
      source: 'tool',
      title: 'Shared Page',
    });
    expect((await get(port, base)).body).toContain('Shared v2');

    await store.delete(id);
    expect((await get(port, base)).status).toBe(404);
    await session.stopAll();
  });

  it('ShareManager tracks sessions, records history, and stops everything', async () => {
    const a = await publishOne();
    const b = await publishOne();
    const manager = createManager();
    const stateA = await manager.start(a);
    expect(await manager.start(a)).toEqual(stateA); // idempotent
    const stateB = await manager.start(b);
    expect(new URL(stateA.url).origin).toBe(new URL(stateB.url).origin);
    expect(
      manager
        .states()
        .map((s) => s.id)
        .sort(),
    ).toEqual([a, b].sort());
    expect(tunnelFactory).toHaveBeenCalledTimes(1);

    await manager.stop(a);
    expect(manager.get(a)).toBeNull();
    expect(tunnels[0].stop).not.toHaveBeenCalled();
    expect(
      (await get(manager.localPort!, new URL(stateA.url).pathname)).status,
    ).toBe(404);
    expect(
      (await get(manager.localPort!, new URL(stateB.url).pathname)).status,
    ).toBe(200);
    expect(manager.get(b)).not.toBeNull();
    await manager.stopAll();
    expect(manager.states()).toEqual([]);
    for (const tunnel of tunnels) expect(tunnel.stop).toHaveBeenCalled();

    const journal = await (
      await import('node:fs/promises')
    ).readFile(
      path.join(dir, '.auditaria', 'artifacts', a, 'artifact.jsonl'),
      'utf-8',
    );
    expect(journal).toContain('"type":"shared"');
    expect(journal).toContain('"type":"unshared"');
    expect(journal).not.toContain(stateA.url.split('/s/')[1]); // no token on disk
  });

  it('tears down the listener when the tunnel cannot open', async () => {
    const id = await publishOne();
    const session = createManager({
      tunnelFactory: async () => {
        throw new Error('cloudflared is required');
      },
    });
    await expect(session.start(id)).rejects.toThrow(/cloudflared/);
    expect(session.localPort).toBeNull();
    expect(session.get(id)).toBeNull();
  });

  it('serializes concurrent publishes and rotates only a revoked capability', async () => {
    const a = await publishOne();
    const b = await publishOne();
    const manager = createManager();
    const [first, duplicate, second] = await Promise.all([
      manager.start(a),
      manager.start(a),
      manager.start(b),
    ]);
    expect(first).toEqual(duplicate);
    expect(first.url).not.toBe(second.url);
    expect(tunnelFactory).toHaveBeenCalledTimes(1);
    const port = manager.localPort!;
    await manager.stop(a);
    const replacement = await manager.start(a);
    expect(replacement.url).not.toBe(first.url);
    expect(manager.get(b)).toEqual(second);
    expect(tunnelFactory).toHaveBeenCalledTimes(1);
    for (const suffix of ['', '__rt/claude.js', '__assets/private.txt']) {
      expect(
        (await get(port, new URL(first.url).pathname + suffix)).status,
      ).toBe(404);
    }
    await manager.stop(a);
    await manager.stop(b);
    expect(manager.localPort).toBeNull();
    expect(tunnels[0].stop).toHaveBeenCalledTimes(1);
    await manager.start(a);
    expect(tunnelFactory).toHaveBeenCalledTimes(2);
  });

  it('cleans up when shutdown is requested during tunnel startup', async () => {
    const id = await publishOne();
    let release!: (tunnel: TunnelLike) => void;
    let entered!: () => void;
    const opening = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopped = vi.fn();
    const manager = createManager({
      tunnelFactory: () => {
        entered();
        return new Promise<TunnelLike>((resolve) => {
          release = resolve;
        });
      },
    });
    const start = manager.start(id);
    await opening;
    const shutdown = manager.stopAll();
    release({ url: 'https://shared.trycloudflare.com', stop: stopped });
    await Promise.all([start, shutdown]);
    expect(manager.states()).toEqual([]);
    expect(manager.localPort).toBeNull();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('recovers from failed startup without leaking a listener or poisoning the queue', async () => {
    const id = await publishOne();
    const factory = vi
      .fn<TunnelFactory>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(tunnelFactory);
    const manager = createManager({ tunnelFactory: factory });
    await expect(manager.start(id)).rejects.toThrow('offline');
    expect(manager.localPort).toBeNull();
    expect(manager.states()).toEqual([]);
    await manager.start(id);
    expect(manager.states()).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('disconnects an in-flight share response on revocation without stopping its neighbor', async () => {
    const a = await publishOne();
    const b = await publishOne();
    const manager = createManager();
    const state = await manager.start(a);
    const other = await manager.start(b);
    const store = await service.getStore();
    let entered!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.readBody.bind(store);
    const spy = vi
      .spyOn(store, 'readBody')
      .mockImplementationOnce(async (id, version) => {
        entered();
        await blocked;
        return original(id, version);
      });
    const response = get(manager.localPort!, new URL(state.url).pathname).then(
      () => 'completed',
      () => 'disconnected',
    );
    try {
      await reading;
      await manager.stop(a);
      expect(await response).toBe('disconnected');
      expect(
        (await get(manager.localPort!, new URL(other.url).pathname)).status,
      ).toBe(200);
      expect(tunnels[0].stop).not.toHaveBeenCalled();
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('isolates assets and rejects missing, deleted and revoked artifacts on every route', async () => {
    const a = await publishOne();
    const b = await publishOne();
    const source = path.join(dir, 'private.svg');
    await writeFile(
      source,
      '<svg xmlns="http://www.w3.org/2000/svg"><text>secret</text></svg>',
    );
    const asset = await (await service.getAssets(b)).add(source);
    const manager = createManager();
    await expect(manager.start('0000000000000000')).rejects.toThrow();
    expect(tunnelFactory).not.toHaveBeenCalled();
    const stateA = await manager.start(a);
    const stateB = await manager.start(b);
    const baseA = new URL(stateA.url).pathname;
    const baseB = new URL(stateB.url).pathname;
    const port = manager.localPort!;
    expect((await get(port, `${baseA}__assets/${asset.id}`)).status).toBe(404);
    const reply = await get(port, `${baseB}__assets/${asset.id}`);
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.headers['content-security-policy']).toContain(
      'sandbox allow-scripts allow-downloads',
    );
    expect(reply.headers['content-security-policy']).not.toContain(
      'allow-same-origin',
    );
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
    expect(
      (
        await get(
          port,
          '/__assets/' + asset.id,
          `auditaria_share=${baseB.split('/')[2]}`,
        )
      ).status,
    ).toBe(404);
    await (await service.getStore()).delete(b);
    for (const suffix of ['', '__rt/claude.js', '__assets/' + asset.id]) {
      expect((await get(port, baseB + suffix)).status).toBe(404);
    }
    expect((await get(port, baseA)).status).toBe(200);
  });

  async function publishSite(): Promise<string> {
    const sources: Record<string, string> = {
      'index.html':
        '<!doctype html><html><head><title>Site</title><link rel="stylesheet" href="/css/site.css"></head><body><h1>Site</h1><a href="/nested/page.html">Next</a><script type="module" src="/app.js"></script></body></html>',
      'nested/page.html':
        '<!doctype html><title>Nested</title><a href="../index.html">Home</a><img src="/image.svg">',
      'css/site.css':
        'body { color: rgb(1, 2, 3); background-image: url(/image.svg); }',
      'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
      'data.json': '{"message":"loaded"}',
      'app.js':
        'document.body.dataset.loaded = (await (await fetch("./data.json")).json()).message;',
    };
    const files = await Promise.all(
      Object.entries(sources).map(async ([name, body]) => {
        const source = path.join(dir, 'site', name);
        await mkdir(path.dirname(source), { recursive: true });
        await writeFile(source, body);
        return { path: name, source, bytes: Buffer.byteLength(body) };
      }),
    );
    const { record } = await (
      await service.getStore()
    ).publish(undefined, {
      body: sources['index.html'],
      format: 'html',
      source: 'tool',
      title: 'Site',
      favicon: '🔗',
      site: { files },
    });
    return record.id;
  }

  it('serves multi-file sites and rebases document and CSS root paths', async () => {
    const id = await publishSite();
    const manager = createManager();
    const state = await manager.start(id);
    const base = new URL(state.url).pathname;
    const port = manager.localPort!;
    const page = await get(port, base);
    expect(page.body).toContain(`href="${base}css/site.css"`);
    expect(page.body).toContain(`src="${base}app.js"`);
    expect(page.body).toContain(`src="${base}__rt/claude.js"`);
    const nested = await get(port, `${base}nested/page.html`);
    expect(nested.body).toContain(`src="${base}image.svg"`);
    expect(nested.body).toContain('href="../index.html"');
    const css = await get(port, `${base}css/site.css`);
    expect(css.body).toContain(`url(${base}image.svg)`);
    expect(css.headers['cache-control']).toBe('no-store');
    expect((await get(port, `${base}data.json`)).body).toContain('loaded');
    expect((await get(port, `${base}../../api/health`)).status).toBe(404);
    expect((await get(port, `${base}%2e%2e/artifact.jsonl`)).status).toBe(404);
  });

  // Opt in locally: AUDITARIA_BROWSER_TEST=1. The regular suite needs no browser install.
  it.runIf(process.env['AUDITARIA_BROWSER_TEST'] === '1')(
    'enforces isolation in Chromium while supporting scripts, styles and fetch',
    async () => {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({ headless: true });
      try {
        const a = await publishSite();
        const b = await publishOne();
        await writeFile(
          path.join(dir, 'claude.js'),
          await readFile(
            new URL(
              '../../../../../web-client/src/artifacts/runtime/claude.js',
              import.meta.url,
            ),
            'utf-8',
          ),
        );
        const manager = createManager({
          tunnelFactory: async (port) => ({
            url: `http://127.0.0.1:${port}`,
            stop: vi.fn(),
          }),
        });
        const stateA = await manager.start(a);
        const stateB = await manager.start(b);
        const context = await browser.newContext();
        const pageA = await context.newPage();
        const pageB = await context.newPage();
        await pageB.goto(stateB.url);
        await pageA.goto(stateA.url);
        await pageA.waitForFunction(
          () => document.body.dataset.loaded === 'loaded',
        );
        expect(
          await pageA.evaluate(() => getComputedStyle(document.body).color),
        ).toBe('rgb(1, 2, 3)');
        expect(
          await pageA.evaluate(() => {
            try {
              localStorage.setItem('escape', 'yes');
              return false;
            } catch {
              return true;
            }
          }),
        ).toBe(true);
        expect(
          await pageA.evaluate(() => {
            try {
              return document.cookie;
            } catch {
              return 'blocked';
            }
          }),
        ).toBe('blocked');
        expect(
          await pageA.evaluate(async (url) => {
            try {
              await fetch(url);
              return false;
            } catch {
              return true;
            }
          }, stateB.url),
        ).toBe(true);
        expect(await context.cookies()).toEqual([]);
        await manager.stop(a);
        expect((await pageA.reload())?.status()).toBe(404);
        expect((await pageB.reload())?.status()).toBe(200);
      } finally {
        await browser.close();
      }
    },
  );
});
