/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: Socket lifecycle regressions with a silent relay.
import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { HiveWireClient } from './HiveWireClient.js';
import { generateIdentityKeyPair, makeNodeId } from './HiveCrypto.js';
import type { AgentCard } from './types.js';

let server: WebSocketServer | undefined;
let client: HiveWireClient | undefined;

afterEach(async () => {
  client?.stop();
  if (server) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
});

it('times out an open socket that never authenticates and cleans up waiters', async () => {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const addr = server.address();
  if (typeof addr === 'string') throw new Error('Expected TCP address');
  client = new HiveWireClient({
    url: `http://127.0.0.1:${addr.port}/test`,
    passphrase: 'test',
    identity: { ...generateIdentityKeyPair(), nodeId: makeNodeId() },
    getCard: () => ({}) as AgentCard,
    connectTimeoutMs: 100,
  });
  const states: string[] = [];
  client.on('state', (state: string) => states.push(state));
  client.start();
  client.start(); // idempotent; no duplicate connections
  await expect(client.waitUntilOnline(300)).rejects.toThrow('timed out');
  expect(states).toContain('offline');
  expect(client.isOnline()).toBe(false);
  expect(client.listenerCount('welcome')).toBe(0);
  expect(client.listenerCount('authfail')).toBe(0);
  expect(server.clients.size).toBe(0);
});
