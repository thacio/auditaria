/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_HIVE_FEATURE: Agent enrollment must work before a service exists.
import { beforeEach, expect, it, vi } from 'vitest';
import type { Config, HiveTransport } from '@google/gemini-cli-core';

const state = vi.hoisted(() => ({
  connector: undefined as HiveTransport['connect'] | undefined,
  active: undefined as
    | {
        connect: ReturnType<typeof vi.fn>;
        getConnectionState: () => string;
        stop: () => Promise<void>;
      }
    | undefined,
  saved: {} as Record<string, unknown>,
  joined: vi.fn(),
  discover: vi.fn(),
  auth: vi.fn(),
}));

vi.mock('@google/gemini-cli-core', () => ({
  registerHiveConnector: (connector: HiveTransport['connect'] | undefined) => {
    state.connector = connector;
  },
}));
vi.mock('./hivePaths.js', () => ({
  getHiveHubDir: () => '/test/hub',
  getHubInfoPath: () => '/test/hub-info.json',
  checkPidLock: () => undefined,
  acquirePidLock: () => true,
  releasePidLock: vi.fn(),
}));
vi.mock('./HiveStore.js', () => ({
  readJsonFile: () => undefined,
  writeJsonFile: vi.fn(),
}));
vi.mock('./hiveShim.js', () => ({ discoverLocalHive: state.discover }));
vi.mock('./HiveService.js', async () => {
  const { parseInvite } = await import('./hivePolicy.js');
  return {
    parseInvite,
    loadHiveConfig: () => ({ ...state.saved }),
    saveHiveConfig: (cfg: Record<string, unknown>) => {
      state.saved = cfg;
    },
    effectivePassphrase: (cfg: Record<string, unknown>) => cfg['passphrase'],
    getHiveInstanceDir: () => '/test/instance',
    getActiveHiveService: () => state.active,
    setActiveHiveService: (service: typeof state.active) => {
      state.active = service;
    },
    HiveService: class {
      constructor(_config: Config, options: unknown) {
        state.joined(options);
      }
      start() {}
      getConnectionState() {
        return 'online';
      }
      async stop() {}
      getNickname() {
        return 'native-node';
      }
      connect = state.auth;
    },
  };
});

import { initializeHiveConnector } from '../../ui/commands/hiveCommand.js';

beforeEach(() => {
  vi.clearAllMocks();
  state.active = undefined;
  state.saved = {};
  state.discover.mockReturnValue(undefined);
  state.auth.mockResolvedValue('Connected as native-node');
  initializeHiveConnector({} as Config);
});

it('joins the native node through local discovery without an existing transport', async () => {
  state.discover.mockReturnValue({
    url: 'http://127.0.0.1:18800/local',
    passphrase: 'local-secret',
  });
  await expect(
    state.connector!({ nickname: 'native-node', description: 'working here' }),
  ).resolves.toContain('Connected');
  expect(state.joined).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'http://127.0.0.1:18800/local',
      passphrase: 'local-secret',
      nickname: 'native-node',
      description: 'working here',
    }),
  );
  expect(state.saved['joined']).toBe(true);
});

it('joins from an invite before any slash command has run', async () => {
  await state.connector!({
    invite: 'https://relay.example/token#secret.inv_once',
  });
  expect(state.joined).toHaveBeenCalledWith(
    expect.objectContaining({ passphrase: 'secret', inviteToken: 'inv_once' }),
  );
});

it('keeps an environment-sourced local passphrase off disk', async () => {
  state.discover.mockReturnValue({
    url: 'http://127.0.0.1:18800/local',
    passphrase: 'env-secret',
    persistPassphrase: false,
  });
  await state.connector!({});
  expect(state.saved['passphrase']).toBeUndefined();
});

it('reports authentication failure instead of claiming to have joined', async () => {
  state.auth.mockRejectedValueOnce(new Error('invalid passphrase'));
  await expect(
    state.connector!({ invite: 'https://relay.example/token#wrong' }),
  ).rejects.toThrow('invalid passphrase');
});

it('allows a corrected invite after first enrollment failed', async () => {
  state.active = {
    connect: state.auth,
    getConnectionState: () => 'stopped',
    stop: vi.fn().mockResolvedValue(undefined),
  };
  state.saved = { url: 'https://relay.example/token', passphrase: 'wrong' };
  await state.connector!({ invite: 'https://relay.example/token#correct' });
  expect(state.joined).toHaveBeenCalledWith(
    expect.objectContaining({ passphrase: 'correct' }),
  );
});

it('explains missing local configuration and does not start a service', async () => {
  await expect(state.connector!({})).rejects.toThrow('No saved hive');
  expect(state.joined).not.toHaveBeenCalled();
});
