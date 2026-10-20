/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { ProviderDriver } from './types.js';
import { AgentSessionManager } from './agent-session-manager.js';
import { ToolExecutorServer } from './mcp-bridge/toolExecutorServer.js';
import { resolveBridgeScriptPath } from './mcp-bridge/toolBridgeService.js';
import { createProviderDriver } from './driverFactory.js';

const { startServer, servers } = vi.hoisted(() => ({
  startServer: vi.fn<() => Promise<number>>(),
  servers: [] as Array<{ stop: ReturnType<typeof vi.fn> }>,
}));

vi.mock('./mcp-bridge/toolExecutorServer.js', () => ({
  ToolExecutorServer: class {
    private port: number | null = null;
    constructor() {
      servers.push(this);
    }
    async start() {
      this.port = await startServer();
      return this.port;
    }
    getPort() {
      return this.port;
    }
    stop = vi.fn(() => {
      this.port = null;
    });
  },
}));
vi.mock('./mcp-bridge/toolBridgeService.js', () => ({
  resolveBridgeScriptPath: vi.fn(),
}));
vi.mock('./driverFactory.js', () => ({ createProviderDriver: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('AgentSessionManager bridge lifecycle', () => {
  let cwd: string;
  let manager: AgentSessionManager;
  const registry = { getAllTools: () => [] } as unknown as ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    servers.length = 0;
    startServer.mockReset().mockResolvedValue(19751);
    vi.mocked(resolveBridgeScriptPath).mockResolvedValue('bridge.js');
    cwd = mkdtempSync(join(tmpdir(), 'agent-session-lifecycle-'));
    manager = new AgentSessionManager(
      cwd,
      () => 'gemini',
      () => ({
        claude: true,
        codex: true,
        copilot: true,
        agy: true,
        auditaria: true,
      }),
      registry,
    );
  });

  afterEach(() => {
    manager.disposeAll();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('coalesces cold concurrent requests and stops its owned listener once', async () => {
    const gate = deferred<number>();
    startServer.mockReturnValue(gate.promise);
    const requests = Array.from({ length: 4 }, () => manager.getToolBridge());
    await vi.waitFor(() => expect(startServer).toHaveBeenCalled());
    gate.resolve(19751);
    expect(await Promise.all(requests)).toEqual(
      Array.from({ length: 4 }, () => ({
        port: 19751,
        scriptPath: 'bridge.js',
      })),
    );
    expect(startServer).toHaveBeenCalledOnce();
    expect(servers).toHaveLength(1);
    manager.disposeAll();
    manager.disposeAll();
    expect(servers[0].stop).toHaveBeenCalledOnce();
    await expect(manager.getToolBridge()).resolves.toBeUndefined();
    expect(startServer).toHaveBeenCalledOnce();
  });

  it('closes a listener whose startup completes after disposal', async () => {
    const gate = deferred<number>();
    startServer.mockReturnValue(gate.promise);
    const pending = manager.getToolBridge();
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledOnce());
    manager.disposeAll();
    gate.resolve(19751);
    await expect(pending).resolves.toBeUndefined();
    expect(servers[0].stop).toHaveBeenCalledOnce();
  });

  it('does not start a listener when disposal races script resolution', async () => {
    const gate = deferred<string | undefined>();
    vi.mocked(resolveBridgeScriptPath).mockReturnValue(gate.promise);
    const pending = manager.getToolBridge();
    manager.disposeAll();
    gate.resolve('bridge.js');
    await expect(pending).resolves.toBeUndefined();
    expect(startServer).not.toHaveBeenCalled();
  });

  it('keeps an injected shared listener and closes the displaced pending listener', async () => {
    const shared = new ToolExecutorServer(registry);
    await shared.start();
    const gate = deferred<number>();
    startServer.mockReturnValue(gate.promise);
    const pending = manager.getToolBridge();
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledTimes(2));
    manager.setToolBridgeInfo(shared, 'shared-bridge.js');
    gate.resolve(19752);
    await expect(pending).resolves.toEqual({
      port: 19751,
      scriptPath: 'shared-bridge.js',
    });
    expect(servers[1].stop).toHaveBeenCalledOnce();
    manager.disposeAll();
    expect(servers[0].stop).not.toHaveBeenCalled();
  });

  it('releases a replaced owned listener without stopping the shared replacement', async () => {
    await manager.getToolBridge();
    const shared = new ToolExecutorServer(registry);
    await shared.start();
    manager.setToolBridgeInfo(shared, 'shared-bridge.js');
    expect(servers[0].stop).toHaveBeenCalledOnce();
    manager.disposeAll();
    expect(servers[1].stop).not.toHaveBeenCalled();
  });

  it('starts an owned listener when the borrowed server has been stopped by its owner', async () => {
    const shared = new ToolExecutorServer(registry);
    await shared.start();
    manager.setToolBridgeInfo(shared, 'shared-bridge.js');
    shared.stop();
    await expect(manager.getToolBridge()).resolves.toEqual({
      port: 19751,
      scriptPath: 'shared-bridge.js',
    });
    expect(startServer).toHaveBeenCalledTimes(2);
    manager.disposeAll();
    expect(servers[0].stop).toHaveBeenCalledOnce();
    expect(servers[1].stop).toHaveBeenCalledOnce();
  });

  it('allows a failed bridge startup to be retried', async () => {
    startServer.mockRejectedValueOnce(new Error('No available ports'));
    await expect(manager.getToolBridge()).resolves.toBeUndefined();
    await expect(manager.getToolBridge()).resolves.toMatchObject({
      port: 19751,
    });
    expect(startServer).toHaveBeenCalledTimes(2);
  });

  it('does not create a driver when disposal races bridge initialization', async () => {
    const gate = deferred<number>();
    startServer.mockReturnValue(gate.promise);
    const pending = manager.createSession({ provider: 'claude-cli' });
    await vi.waitFor(() => expect(startServer).toHaveBeenCalledOnce());
    manager.disposeAll();
    gate.resolve(19751);
    await expect(pending).rejects.toThrow('disposed');
    expect(createProviderDriver).not.toHaveBeenCalled();
  });

  it('disposes a driver that arrives after shutdown without registering its session', async () => {
    const gate = deferred<ProviderDriver>();
    vi.mocked(createProviderDriver).mockReturnValue(gate.promise);
    const pending = manager.createSession({ provider: 'claude-cli' });
    await vi.waitFor(() => expect(createProviderDriver).toHaveBeenCalledOnce());
    manager.disposeAll();
    const driver: ProviderDriver = {
      async *sendMessage() {},
      async interrupt() {},
      getSessionId: () => undefined,
      dispose: vi.fn(),
      canResume: false,
    };
    gate.resolve(driver);
    await expect(pending).rejects.toThrow('disposed');
    expect(driver.dispose).toHaveBeenCalledOnce();
    expect(manager.listSessions()).toEqual([]);
  });
});
