/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactService } from '@google/gemini-cli-core';

// The core package index cannot load under the lean web config (a
// pre-existing core→browser-agent import cycle), so the modules under test
// get the real artifact helpers straight from their own built files.
vi.mock('@google/gemini-cli-core', async () => {
  const [service, shell, paths, store] = await Promise.all([
    import('@google/gemini-cli-core/dist/src/artifacts/artifactService.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/htmlShell.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/artifactPaths.js'),
    import('@google/gemini-cli-core/dist/src/artifacts/artifactStore.js'),
  ]);
  return { ...service, ...shell, ...paths, ...store };
});
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import { ShareManager, ShareSession, type TunnelLike } from './shareSession.js';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(port: number, pathname: string, cookie?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
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

describe('ShareSession', () => {
  let dir: string;
  let service: ArtifactService;
  let runtimeDir: string;
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
  afterEach(() => rm(dir, { recursive: true, force: true }));

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
    const session = new ShareSession(id, options());
    const state = await session.start();
    const port = session.localPort!;
    expect(state.url).toMatch(
      /^https:\/\/fake-\d+\.trycloudflare\.com\/s\/[A-Za-z0-9_-]{32}$/,
    );
    const token = state.url.split('/s/')[1];

    // No cookie: nothing is served, not even the runtime.
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, '/__rt/claude.js')).status).toBe(404);
    expect((await get(port, '/s/wrong-token')).status).toBe(404);
    const robots = await get(port, '/robots.txt');
    expect(robots.body).toContain('Disallow: /');

    // The link mints the cookie and redirects home.
    const minted = await get(port, `/s/${token}`);
    expect(minted.status).toBe(302);
    expect(minted.headers['location']).toBe('/');
    const setCookie = String(minted.headers['set-cookie']);
    expect(setCookie).toMatch(
      /^auditaria_share=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Lax/,
    );
    const cookie = setCookie.split(';')[0];

    const page = await get(port, '/', cookie);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1>Shared</h1>');
    expect(page.body).toContain('"grants":[]');
    expect(page.body).toContain('"shared":true');
    expect(String(page.headers['content-security-policy'])).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers['cache-control']).toBe('no-store');
    expect(String(page.headers['x-robots-tag'])).toContain('noindex');
    expect((await get(port, '/__rt/claude.js', cookie)).status).toBe(200);
    expect((await get(port, '/api/health', cookie)).status).toBe(404);

    await session.stop();
    expect(tunnels[0].stop).toHaveBeenCalledTimes(1);
    expect(session.current).toBeNull();
    await expect(get(port, '/', cookie)).rejects.toBeTruthy();
  });

  it('serves the latest version and disappears with the artifact', async () => {
    const id = await publishOne();
    const store = await service.getStore();
    const session = new ShareSession(id, options());
    const state = await session.start();
    const port = session.localPort!;
    const cookie = `auditaria_share=${state.url.split('/s/')[1]}`;

    await store.publish(id, {
      body: '<title>Shared Page</title><h1>Shared v2</h1>',
      format: 'html',
      source: 'tool',
      title: 'Shared Page',
    });
    expect((await get(port, '/', cookie)).body).toContain('Shared v2');

    await store.delete(id);
    expect((await get(port, '/', cookie)).status).toBe(404);
    await session.stop();
  });

  it('ShareManager tracks sessions, records history, and stops everything', async () => {
    const a = await publishOne();
    const b = await publishOne();
    const manager = new ShareManager(options());
    const stateA = await manager.start(a);
    expect(await manager.start(a)).toEqual(stateA); // idempotent
    await manager.start(b);
    expect(
      manager
        .states()
        .map((s) => s.id)
        .sort(),
    ).toEqual([a, b].sort());
    expect(tunnelFactory).toHaveBeenCalledTimes(2);

    await manager.stop(a);
    expect(manager.get(a)).toBeNull();
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
    const session = new ShareSession(id, {
      ...options(),
      tunnelFactory: async () => {
        throw new Error('cloudflared is required');
      },
    });
    await expect(session.start()).rejects.toThrow(/cloudflared/);
    expect(session.localPort).toBeNull();
    expect(session.current).toBeNull();
  });
});
