/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestLogger } from '../../../test-utils/webTestSupport.js';
import { WebHttpServer, parseHostHeader } from './httpServer.js';

describe('parseHostHeader', () => {
  it('splits names, IPv4 and bracketed IPv6 with optional ports', () => {
    expect(parseHostHeader('Localhost:8629')).toEqual({
      hostname: 'localhost',
      port: 8629,
    });
    expect(parseHostHeader('abc-art.localhost')).toEqual({
      hostname: 'abc-art.localhost',
    });
    expect(parseHostHeader('[::1]:8629')).toEqual({
      hostname: '[::1]',
      port: 8629,
    });
    expect(parseHostHeader('[::1]')).toEqual({ hostname: '[::1]' });
    expect(parseHostHeader(undefined)).toEqual({ hostname: '' });
  });
});

interface Reply {
  status: number;
  body: string;
  csp?: string;
}

function request(
  port: number,
  hostHeader: string,
  path: string,
  address = '127.0.0.1',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: address, port, path, headers: { Host: hostHeader } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            csp: res.headers['content-security-policy'] as string | undefined,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('WebHttpServer virtual hosts and dual binding', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('routes by Host to virtual hosts and never falls through to the console', async () => {
    const http = new WebHttpServer(createTestLogger());
    cleanups.push(() => http.close());
    http.mount('/api/health', (_req, res) => {
      res.json({ ok: true });
    });
    http.mountHost({
      name: 'artifacts',
      matches: (h) => h.endsWith('-art.localhost'),
      handler: (req, res, next) => {
        if (req.path === '/page') {
          res.type('text/plain').send('artifact page');
          return;
        }
        next();
      },
    });
    const { port } = await http.listen({
      port: 0,
      host: '127.0.0.1',
      sequentialAttempts: 0,
    });

    const page = await request(port, `abc-art.localhost:${port}`, '/page');
    expect(page).toMatchObject({ status: 200, body: 'artifact page' });
    expect(page.csp).toBeUndefined();

    const leak = await request(
      port,
      `abc-art.localhost:${port}`,
      '/api/health',
    );
    expect(leak.status).toBe(404);

    const console_ = await request(port, `localhost:${port}`, '/api/health');
    expect(console_).toMatchObject({ status: 200, body: '{"ok":true}' });
    expect(console_.csp).toBe("frame-ancestors 'self'");
    expect(http.hasVirtualHost('abc-art.localhost')).toBe(true);
    expect(http.hasVirtualHost('localhost')).toBe(false);
    expect(() =>
      http.mountHost({
        name: 'artifacts',
        matches: () => false,
        handler: () => {},
      }),
    ).toThrow(/already mounted/);
  });

  it('binds both loopback addresses for "localhost"', async () => {
    const http = new WebHttpServer(createTestLogger());
    cleanups.push(() => http.close());
    http.mount('/ping', (_req, res) => {
      res.send('pong');
    });
    const result = await http.listen({
      port: 0,
      host: 'localhost',
      sequentialAttempts: 0,
    });
    expect(result.addresses[0]).toBe('127.0.0.1');
    const v4 = await request(result.port, `localhost:${result.port}`, '/ping');
    expect(v4.body).toBe('pong');
    if (result.addresses.includes('::1')) {
      const v6 = await request(
        result.port,
        `localhost:${result.port}`,
        '/ping',
        '::1',
      );
      expect(v6.body).toBe('pong');
      expect(http.nodeServers).toHaveLength(2);
    }
    await http.close();
    expect(http.isListening).toBe(false);
  });
});
