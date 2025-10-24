/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, type Mock } from 'vitest';
import { listMcpServers } from './list.js';
import { loadSettings } from '../../config/settings.js';
import { createTransport, debugLogger } from '@thacio/auditaria-cli-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ExtensionStorage } from '../../config/extensions/storage.js';
import { ExtensionManager } from '../../config/extension-manager.js';

vi.mock('../../config/settings.js', () => ({
  loadSettings: vi.fn(),
}));
vi.mock('../../config/extensions/storage.js', () => ({
  ExtensionStorage: {
    getUserExtensionsDir: vi.fn(),
  },
}));
vi.mock('../../config/extension-manager.js');
vi.mock('@thacio/auditaria-cli-core', () => ({
  createTransport: vi.fn(),
  MCPServerStatus: {
    CONNECTED: 'CONNECTED',
    CONNECTING: 'CONNECTING',
    DISCONNECTED: 'DISCONNECTED',
  },
  Storage: vi.fn().mockImplementation((_cwd: string) => ({
    getGlobalSettingsPath: () => '/tmp/gemini/settings.json',
    getWorkspaceSettingsPath: () => '/tmp/gemini/workspace-settings.json',
    getProjectTempDir: () => '/test/home/.gemini/tmp/mocked_hash',
  })),
  GEMINI_DIR: '.gemini',
  getErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  debugLogger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js');

const mockedGetUserExtensionsDir =
  ExtensionStorage.getUserExtensionsDir as Mock;
const mockedLoadSettings = loadSettings as Mock;
const mockedCreateTransport = createTransport as Mock;
const MockedClient = Client as Mock;
const MockedExtensionManager = ExtensionManager as Mock;

interface MockClient {
  connect: Mock;
  ping: Mock;
  close: Mock;
}

interface MockExtensionManager {
  loadExtensions: Mock;
}

interface MockTransport {
  close: Mock;
}

describe('mcp list command', () => {
  let mockClient: MockClient;
  let mockExtensionManager: MockExtensionManager;
  let mockTransport: MockTransport;

  beforeEach(() => {
    vi.resetAllMocks();

    mockTransport = { close: vi.fn() };
    mockClient = {
      connect: vi.fn(),
      ping: vi.fn(),
      close: vi.fn(),
    };
    mockExtensionManager = {
      loadExtensions: vi.fn(),
    };

    MockedClient.mockImplementation(() => mockClient);
    MockedExtensionManager.mockImplementation(() => mockExtensionManager);
    mockedCreateTransport.mockResolvedValue(mockTransport);
    mockExtensionManager.loadExtensions.mockReturnValue([]);
    mockedGetUserExtensionsDir.mockReturnValue('/mocked/extensions/dir');
  });

  it('should display message when no servers configured', async () => {
    mockedLoadSettings.mockReturnValue({ merged: { mcpServers: {} } });

    await listMcpServers();

    expect(debugLogger.log).toHaveBeenCalledWith('No MCP servers configured.');
  });

  it('should display different server types with connected status', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          'stdio-server': { command: '/path/to/server', args: ['arg1'] },
          'sse-server': { url: 'https://example.com/sse' },
          'http-server': { httpUrl: 'https://example.com/http' },
        },
      },
    });

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(debugLogger.log).toHaveBeenCalledWith('Configured MCP servers:\n');
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'stdio-server: /path/to/server arg1 (stdio) - Connected',
      ),
    );
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'sse-server: https://example.com/sse (sse) - Connected',
      ),
    );
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'http-server: https://example.com/http (http) - Connected',
      ),
    );
  });

  it('should display disconnected status when connection fails', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: {
          'test-server': { command: '/test/server' },
        },
      },
    });

    mockClient.connect.mockRejectedValue(new Error('Connection failed'));

    await listMcpServers();

    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'test-server: /test/server  (stdio) - Disconnected',
      ),
    );
  });

  it('should merge extension servers with config servers', async () => {
    mockedLoadSettings.mockReturnValue({
      merged: {
        mcpServers: { 'config-server': { command: '/config/server' } },
      },
    });

    mockExtensionManager.loadExtensions.mockReturnValue([
      {
        name: 'test-extension',
        mcpServers: { 'extension-server': { command: '/ext/server' } },
      },
    ]);

    mockClient.connect.mockResolvedValue(undefined);
    mockClient.ping.mockResolvedValue(undefined);

    await listMcpServers();

    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'config-server: /config/server  (stdio) - Connected',
      ),
    );
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.stringContaining(
        'extension-server (from test-extension): /ext/server  (stdio) - Connected',
      ),
    );
  });
});
