/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import { Broadcaster } from './broadcaster.js';
import { ClientRegistry } from './clientRegistry.js';
import { WebHttpServer } from './httpServer.js';
import { InboundRouter } from './inboundRouter.js';
import type { WsEndpoint } from './types.js';
import { WebSocketHub, judgeUpgrade } from './webSocketHub.js';

const isArtifactHost = (h: string) => h.endsWith('-art.localhost');

describe('judgeUpgrade', () => {
  const loopback = {
    loopback: true,
    port: 8629,
    isVirtualHost: isArtifactHost,
  };
  const exposed = { ...loopback, loopback: false };
  const chat = undefined;
  const scoped: WsEndpoint = {
    path: '/__runtime/live',
    host: isArtifactHost,
    onConnection: () => {},
  };
  const appEndpoint: WsEndpoint = {
    path: '/stream/browser/:id',
    onConnection: () => {},
  };

  it('lets non-browser clients (no Origin) reach the console hosts', () => {
    expect(judgeUpgrade(loopback, 'localhost:8629', undefined, chat)).toEqual({
      allow: true,
    });
    expect(
      judgeUpgrade(loopback, '127.0.0.1:8629', undefined, appEndpoint).allow,
    ).toBe(true);
  });

  it('accepts loopback console origins on the bound port only', () => {
    for (const origin of [
      'http://localhost:8629',
      'http://127.0.0.1:8629',
      'http://[::1]:8629',
    ]) {
      expect(judgeUpgrade(loopback, 'localhost:8629', origin, chat).allow).toBe(
        true,
      );
    }
    expect(
      judgeUpgrade(loopback, 'localhost:8629', 'http://localhost:9999', chat),
    ).toMatchObject({ allow: false, status: 403 });
  });

  it('refuses foreign and rebound origins on the console hosts', () => {
    // DNS rebinding: evil.com resolves to 127.0.0.1, so Host equals Origin.
    expect(
      judgeUpgrade(loopback, 'evil.com:8629', 'http://evil.com:8629', chat),
    ).toMatchObject({ allow: false, status: 403 });
    expect(
      judgeUpgrade(loopback, 'localhost:8629', 'null', chat),
    ).toMatchObject({ allow: false, status: 403 });
    // An artifact page must never reach the chat socket.
    expect(
      judgeUpgrade(
        loopback,
        'localhost:8629',
        'http://abc-art.localhost:8629',
        chat,
      ),
    ).toMatchObject({ allow: false, status: 403 });
  });

  it('serves only host-scoped endpoints on a virtual host, with an exact Origin', () => {
    const host = 'abc-art.localhost:8629';
    expect(judgeUpgrade(loopback, host, `http://${host}`, scoped)).toEqual({
      allow: true,
    });
    expect(judgeUpgrade(loopback, host, undefined, scoped)).toMatchObject({
      allow: false,
      status: 403,
    });
    expect(
      judgeUpgrade(loopback, host, 'http://other-art.localhost:8629', scoped),
    ).toMatchObject({ allow: false, status: 403 });
    expect(judgeUpgrade(loopback, host, `http://${host}`, chat)).toMatchObject({
      allow: false,
      status: 404,
    });
    expect(
      judgeUpgrade(loopback, host, `http://${host}`, appEndpoint),
    ).toMatchObject({ allow: false, status: 404 });
    expect(
      judgeUpgrade(loopback, 'localhost:8629', 'http://localhost:8629', scoped),
    ).toMatchObject({ allow: false, status: 404 });
  });

  it('falls back to origin-equals-host when not bound to loopback', () => {
    expect(
      judgeUpgrade(
        exposed,
        'console.example:8629',
        'https://console.example:8629',
        chat,
      ).allow,
    ).toBe(true);
    expect(
      judgeUpgrade(
        exposed,
        'console.example:8629',
        'https://evil.example',
        chat,
      ),
    ).toMatchObject({ allow: false, status: 403 });
  });
});

describe('WebSocketHub on virtual hosts', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('refuses the chat socket on a virtual host and serves the scoped endpoint', async () => {
    const logger = createTestLogger();
    const clients = new ClientRegistry(4);
    const broadcaster = new Broadcaster(clients, logger);
    const inbound = new InboundRouter(logger);
    const http = new WebHttpServer(logger);
    const hub = new WebSocketHub({
      clients,
      broadcaster,
      inbound,
      logger,
      sendInitialState: vi.fn(),
    });
    hub.addEndpoint({
      path: '/__runtime/live',
      host: isArtifactHost,
      onConnection: (ws) => ws.send(JSON.stringify({ type: 'runtime' })),
    });
    const { port } = await http.listen({
      port: 0,
      host: '127.0.0.1',
      sequentialAttempts: 0,
    });
    hub.attach(http.nodeServers, {
      loopback: true,
      port,
      isVirtualHost: isArtifactHost,
    });
    stop = async () => {
      hub.close();
      await http.close();
    };
    const host = `abc-art.localhost:${port}`;

    const refused = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { host, origin: `http://${host}` },
    });
    const refusal = await new Promise<string>((resolve) => {
      refused.once('unexpected-response', (_req, res) =>
        resolve(String(res.statusCode)),
      );
      refused.once('error', (e) => resolve(e.message));
    });
    expect(refusal).toBe('404');
    expect(clients.size).toBe(0);

    const runtime = new WebSocket(`ws://127.0.0.1:${port}/__runtime/live`, {
      headers: { host, origin: `http://${host}` },
    });
    const first = await new Promise<unknown>((resolve, reject) => {
      runtime.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      runtime.once('error', reject);
    });
    expect(first).toEqual({ type: 'runtime' });
    runtime.close();
  });
});
