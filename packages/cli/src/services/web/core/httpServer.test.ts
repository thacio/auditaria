/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import { WebHttpServer, buildPortCandidates } from './httpServer.js';

const HOST = '127.0.0.1';

function occupyPort(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

const closeNet = (server: Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe('buildPortCandidates', () => {
  it('lists the requested port followed by its successors', () => {
    expect(buildPortCandidates(8629, 4)).toEqual([
      8629, 8630, 8631, 8632, 8633,
    ]);
    expect(buildPortCandidates(8629, 0)).toEqual([8629]);
  });

  it('never exceeds the valid port range', () => {
    expect(buildPortCandidates(65534, 4)).toEqual([65534, 65535]);
  });
});

describe('WebHttpServer', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('serves mounted routes and reports the bound port', async () => {
    const http = new WebHttpServer(createTestLogger());
    cleanups.push(() => http.close());
    http.mount('/ping', (_req, res) => {
      res.json({ pong: true });
    });

    const result = await http.listen({
      port: 0,
      host: HOST,
      sequentialAttempts: 0,
    });
    expect(result.port).toBeGreaterThan(0);
    expect(http.isListening).toBe(true);

    const response = await fetch(`http://${HOST}:${result.port}/ping`);
    expect(await response.json()).toEqual({ pong: true });
    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('moves to the next port when the requested one is busy', async () => {
    const blocker = await occupyPort();
    cleanups.push(() => closeNet(blocker.server));
    const http = new WebHttpServer(createTestLogger());
    cleanups.push(() => http.close());

    const result = await http.listen({
      port: blocker.port,
      host: HOST,
      sequentialAttempts: 3,
    });
    expect(result.usedFallback).toBe(true);
    expect(result.port).not.toBe(blocker.port);
    expect(result.port).toBeGreaterThan(blocker.port);
    expect(result.port).toBeLessThanOrEqual(blocker.port + 3);
  });

  it('refuses to listen twice and releases the port on close', async () => {
    const http = new WebHttpServer(createTestLogger());
    const { port } = await http.listen({
      port: 0,
      host: HOST,
      sequentialAttempts: 0,
    });
    await expect(
      http.listen({ port: 0, host: HOST, sequentialAttempts: 0 }),
    ).rejects.toThrow(/already listening/);

    await http.close();
    expect(http.isListening).toBe(false);

    const again = new WebHttpServer(createTestLogger());
    cleanups.push(() => again.close());
    const reused = await again.listen({
      port,
      host: HOST,
      sequentialAttempts: 0,
    });
    expect(reused).toMatchObject({ port, usedFallback: false });
  });

  it('close() is a no-op before listening', async () => {
    await expect(
      new WebHttpServer(createTestLogger()).close(),
    ).resolves.toBeUndefined();
  });
});
