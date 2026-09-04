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
import { WebSocketHub, matchWsRoute } from './webSocketHub.js';

type Envelope = Record<string, unknown>;

/**
 * A `ws` client that buffers every JSON message from the moment it is
 * created — the server's first messages can arrive in the same tick as
 * `open`, before a test gets a chance to attach a listener.
 */
class TestClient {
  readonly ws: WebSocket;
  private readonly queue: Envelope[] = [];
  private waiter: (() => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      this.queue.push(JSON.parse(raw.toString()) as Envelope);
      this.waiter?.();
    });
  }

  opened(): Promise<this> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve(this));
      this.ws.once('error', reject);
    });
  }

  /** Resolves with the next `count` messages, in arrival order. */
  take(count: number, timeoutMs = 2_000): Promise<Envelope[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(
          new Error(
            `Timed out with ${this.queue.length}/${count} messages: ${JSON.stringify(this.queue)}`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        if (this.queue.length < count) return;
        clearTimeout(timer);
        this.waiter = null;
        resolve(this.queue.splice(0, count));
      };
      this.waiter = check;
      check();
    });
  }

  send(message: Envelope): void {
    this.ws.send(JSON.stringify(message));
  }

  closed(): Promise<number> {
    return new Promise((resolve) =>
      this.ws.once('close', (code) => resolve(code)),
    );
  }
}

const connect = (url: string) => new TestClient(url).opened();

async function startHub() {
  const logger = createTestLogger();
  const clients = new ClientRegistry(4);
  const broadcaster = new Broadcaster(clients, logger);
  const inbound = new InboundRouter(logger);
  const http = new WebHttpServer(logger);
  const sendInitialState = vi.fn((ws: WebSocket) => {
    const sequence = broadcaster.nextSequence();
    broadcaster.sendSequenced(ws, sequence, 'connection', {
      startingSequence: sequence,
    });
    broadcaster.send(ws, 'console_messages', []);
  });
  const hub = new WebSocketHub({
    clients,
    broadcaster,
    inbound,
    logger,
    sendInitialState,
  });
  hub.addEndpoint({
    path: '/stream/browser/:sessionId',
    onConnection: (ws, params) => {
      ws.send(
        JSON.stringify({ type: 'hello', sessionId: params['sessionId'] }),
      );
    },
  });
  const { port } = await http.listen({
    port: 0,
    host: '127.0.0.1',
    sequentialAttempts: 0,
  });
  const server = http.nodeServer;
  if (!server) throw new Error('no server');
  hub.attach(server);
  const url = `ws://127.0.0.1:${port}`;
  const stop = async () => {
    hub.close();
    await http.close();
  };
  return { clients, broadcaster, inbound, hub, url, sendInitialState, stop };
}

describe('matchWsRoute', () => {
  it('captures named segments and rejects mismatches', () => {
    expect(
      matchWsRoute('/stream/browser/:sessionId', '/stream/browser/s1'),
    ).toEqual({ sessionId: 's1' });
    expect(matchWsRoute('/control/agent/:id', '/control/agent/a%20b')).toEqual({
      id: 'a b',
    });
    expect(
      matchWsRoute('/stream/browser/:sessionId', '/stream/browser/'),
    ).toBeNull();
    expect(
      matchWsRoute('/stream/browser/:sessionId', '/stream/other/s1'),
    ).toBeNull();
    expect(matchWsRoute('/a/:x', '/a/b/c')).toBeNull();
    expect(matchWsRoute('/', '/')).toEqual({});
  });
});

describe('WebSocketHub', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await stop?.();
    stop = undefined;
  });

  it('registers chat clients, sends the handshake, and removes them on close', async () => {
    const hub = await startHub();
    stop = hub.stop;
    const client = await connect(hub.url);
    const [connection, second] = await client.take(2);

    expect(connection['type']).toBe('connection');
    expect(connection['sequence']).toBe(
      (connection['data'] as Envelope)['startingSequence'],
    );
    expect(second['type']).toBe('console_messages');
    expect(hub.clients.size).toBe(1);

    const removed = new Promise<void>((resolve) =>
      hub.clients.onDisconnected(() => resolve()),
    );
    client.ws.close();
    await removed;
    expect(hub.clients.size).toBe(0);
  });

  it('routes path-scoped endpoints outside the chat registry', async () => {
    const hub = await startHub();
    stop = hub.stop;
    const client = await connect(`${hub.url}/stream/browser/session-7`);
    const [hello] = await client.take(1);
    expect(hello).toEqual({ type: 'hello', sessionId: 'session-7' });
    expect(hub.clients.size).toBe(0);
    expect(hub.sendInitialState).not.toHaveBeenCalled();
    client.ws.close();
  });

  it('dispatches inbound chat messages to the router', async () => {
    const hub = await startHub();
    stop = hub.stop;
    const received = new Promise<Envelope>((resolve) =>
      hub.inbound.on('user_message', (message) => resolve(message)),
    );
    const client = await connect(hub.url);
    await client.take(2);
    client.send({ type: 'user_message', content: 'ping' });
    expect(await received).toEqual({ type: 'user_message', content: 'ping' });
    client.ws.close();
  });

  it('replays missed persistent messages on resync and forces a full resync past the buffer', async () => {
    const hub = await startHub();
    stop = hub.stop;
    const client = await connect(hub.url);
    const [connection] = await client.take(2);
    const start = connection['sequence'] as number;

    // Four more messages (= buffer capacity), one of them ephemeral.
    hub.broadcaster.broadcast('history_item', 'a');
    hub.broadcaster.broadcast('loading_state', 'b', { ephemeral: true });
    hub.broadcaster.broadcast('history_item', 'c');
    hub.broadcaster.broadcast('footer_data', 'd');
    await client.take(4);

    client.send({
      type: 'resync_request',
      from: start + 2,
      persistentOnly: true,
    });
    const replayed = await client.take(2);
    expect(replayed.map((e) => e['data'])).toEqual(['c', 'd']);

    // Ack everything, then ask for a replay from before the retained window.
    client.send({ type: 'ack', lastSequence: start + 5 });
    hub.broadcaster.broadcast('history_item', 'e');
    await client.take(1);
    client.send({ type: 'resync_request', from: start });
    const [forced, handshake] = await client.take(2);
    expect(forced['type']).toBe('force_resync');
    expect(handshake['type']).toBe('connection');
    expect(hub.sendInitialState).toHaveBeenCalledTimes(2);
    client.ws.close();
  });

  it('close() shuts every socket down with a going-away code', async () => {
    const hub = await startHub();
    stop = hub.stop;
    const chat = await connect(hub.url);
    const stream = await connect(`${hub.url}/stream/browser/x`);
    await chat.take(2);
    await stream.take(1);

    const codes = Promise.all([chat.closed(), stream.closed()]);
    hub.hub.close();
    expect(await codes).toEqual([1001, 1001]);
    expect(hub.clients.size).toBe(0);
  });
});
