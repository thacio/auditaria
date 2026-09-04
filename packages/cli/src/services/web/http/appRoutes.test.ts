/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import { WebHttpServer } from '../core/httpServer.js';
import {
  createHealthRouter,
  createStaticAssetsHandler,
  resolveWebClientRoot,
  webClientCandidates,
} from './appRoutes.js';

describe('resolveWebClientRoot', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'auditaria-webclient-'));
    await mkdir(path.join(dir, 'client'));
    await writeFile(path.join(dir, 'client', 'index.html'), '<h1>hi</h1>');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it('picks the first candidate that holds an index.html', () => {
    const missing = path.join(dir, 'nope');
    const client = path.join(dir, 'client');
    expect(resolveWebClientRoot([missing, client])).toBe(client);
  });

  it('fails with every attempted path listed', () => {
    const missing = path.join(dir, 'nope');
    expect(() => resolveWebClientRoot([missing])).toThrow(missing);
  });

  it('finds the real client from this source checkout', () => {
    const root = resolveWebClientRoot(webClientCandidates());
    expect(root).toMatch(/web-client/);
  });
});

describe('health and static routes', () => {
  let dir: string;
  let baseUrl: string;
  const http = new WebHttpServer(createTestLogger());

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'auditaria-static-'));
    await writeFile(path.join(dir, 'index.html'), '<h1>web client</h1>');
    http.mount(createHealthRouter(() => 3));
    http.mount(createStaticAssetsHandler(dir));
    const { port } = await http.listen({
      port: 0,
      host: '127.0.0.1',
      sequentialAttempts: 0,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await http.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports liveness with the client count', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(await response.json()).toEqual({ status: 'ok', clients: 3 });
  });

  it('serves the client index at the root', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>web client</h1>');
  });
});
