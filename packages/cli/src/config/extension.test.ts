/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, type MockedFunction } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type GeminiCLIExtension,
  ExtensionUninstallEvent,
  ExtensionDisableEvent,
  ExtensionEnableEvent,
} from '@thacio/auditaria-cli-core';
import { loadSettings, SettingScope } from './settings.js';
import { isWorkspaceTrusted } from './trustedFolders.js';
import { createExtension } from '../test-utils/createExtension.js';
import { ExtensionEnablementManager } from './extensions/extensionEnablement.js';
import { join } from 'node:path';
import {
  EXTENSIONS_CONFIG_FILENAME,
  EXTENSIONS_DIRECTORY_NAME,
  INSTALL_METADATA_FILENAME,
} from './extensions/variables.js';
import { hashValue, ExtensionManager } from './extension-manager.js';
import { ExtensionStorage } from './extensions/storage.js';
import { INSTALL_WARNING_MESSAGE } from './extensions/consent.js';
import type { ExtensionSetting } from './extensions/extensionSettings.js';

const mockGit = {
  clone: vi.fn(),
  getRemotes: vi.fn(),
  fetch: vi.fn(),
  checkout: vi.fn(),
  listRemote: vi.fn(),
  revparse: vi.fn(),
  // Not a part of the actual API, but we need to use this to do the correct
  // file system interactions.
  path: vi.fn(),
};

const mockDownloadFromGithubRelease = vi.hoisted(() => vi.fn());

vi.mock('./extensions/github.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('./extensions/github.js')>();
  return {
    ...original,
    downloadFromGitHubRelease: mockDownloadFromGithubRelease,
  };
});

vi.mock('simple-git', () => ({
  simpleGit: vi.fn((path: string) => {
    mockGit.path.mockReturnValue(path);
    return mockGit;
  }),
}));

vi.mock('os', async (importOriginal) => {
  const mockedOs = await importOriginal<typeof os>();
  return {
    ...mockedOs,
    homedir: vi.fn(),
  };
});

vi.mock('./trustedFolders.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trustedFolders.js')>();
  return {
    ...actual,
    isWorkspaceTrusted: vi.fn(),
  };
});

const mockLogExtensionEnable = vi.hoisted(() => vi.fn());
const mockLogExtensionInstallEvent = vi.hoisted(() => vi.fn());
const mockLogExtensionUninstall = vi.hoisted(() => vi.fn());
const mockLogExtensionUpdateEvent = vi.hoisted(() => vi.fn());
const mockLogExtensionDisable = vi.hoisted(() => vi.fn());
vi.mock('@thacio/auditaria-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@thacio/auditaria-cli-core')>();
  return {
    ...actual,
    logExtensionEnable: mockLogExtensionEnable,
    logExtensionInstallEvent: mockLogExtensionInstallEvent,
    logExtensionUninstall: mockLogExtensionUninstall,
    logExtensionUpdateEvent: mockLogExtensionUpdateEvent,
    logExtensionDisable: mockLogExtensionDisable,
    ExtensionEnableEvent: vi.fn(),
    ExtensionInstallEvent: vi.fn(),
    ExtensionUninstallEvent: vi.fn(),
    ExtensionDisableEvent: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

describe('extension tests', () => {
  let tempHomeDir: string;
  let tempWorkspaceDir: string;
  let userExtensionsDir: string;
  let extensionManager: ExtensionManager;
  let mockRequestConsent: MockedFunction<(consent: string) => Promise<boolean>>;
  let mockPromptForSettings: MockedFunction<
    (setting: ExtensionSetting) => Promise<string>
  >;

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'gemini-cli-test-home-'),
    );
    tempWorkspaceDir = fs.mkdtempSync(
      path.join(tempHomeDir, 'gemini-cli-test-workspace-'),
    );
    userExtensionsDir = path.join(tempHomeDir, EXTENSIONS_DIRECTORY_NAME);
    mockRequestConsent = vi.fn();
    mockRequestConsent.mockResolvedValue(true);
    mockPromptForSettings = vi.fn();
    mockPromptForSettings.mockResolvedValue('');
    fs.mkdirSync(userExtensionsDir, { recursive: true });
    vi.mocked(os.homedir).mockReturnValue(tempHomeDir);
    vi.mocked(isWorkspaceTrusted).mockReturnValue({
      isTrusted: true,
      source: undefined,
    });
    vi.spyOn(process, 'cwd').mockReturnValue(tempWorkspaceDir);
    extensionManager = new ExtensionManager({
      workspaceDir: tempWorkspaceDir,
      requestConsent: mockRequestConsent,
      requestSetting: mockPromptForSettings,
      loadedSettings: loadSettings(tempWorkspaceDir),
    });
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('loadExtensions', () => {
    it('should include extension path in loaded extension', () => {
      const extensionDir = path.join(userExtensionsDir, 'test-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
      });

      const extensions = extensionManager.loadExtensions();
      expect(extensions).toHaveLength(1);
      expect(extensions[0].path).toBe(extensionDir);
      expect(extensions[0].name).toBe('test-extension');
    });

    it('should load context file path when GEMINI.md is present', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        addContextFile: true,
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '2.0.0',
      });

      const extensions = extensionManager.loadExtensions();

      expect(extensions).toHaveLength(2);
      const ext1 = extensions.find((e) => e.name === 'ext1');
      const ext2 = extensions.find((e) => e.name === 'ext2');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'GEMINI.md'),
      ]);
      expect(ext2?.contextFiles).toEqual([]);
    });

    it('should load context file path from the extension config', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        addContextFile: false,
        contextFileName: 'my-context-file.md',
      });

      const extensions = extensionManager.loadExtensions();

      expect(extensions).toHaveLength(1);
      const ext1 = extensions.find((e) => e.name === 'ext1');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'my-context-file.md'),
      ]);
    });

    it('should annotate disabled extensions', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'disabled-extension',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'enabled-extension',
        version: '2.0.0',
      });
      extensionManager.disableExtension(
        'disabled-extension',
        SettingScope.User,
      );
      const extensions = extensionManager.loadExtensions();
      expect(extensions).toHaveLength(2);
      expect(extensions[0].name).toBe('disabled-extension');
      expect(extensions[0].isActive).toBe(false);
      expect(extensions[1].name).toBe('enabled-extension');
      expect(extensions[1].isActive).toBe(true);
    });

    it('should hydrate variables', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
        addContextFile: false,
        contextFileName: undefined,
        mcpServers: {
          'test-server': {
            cwd: '${extensionPath}${/}server',
          },
        },
      });

      const extensions = extensionManager.loadExtensions();
      expect(extensions).toHaveLength(1);
      const expectedCwd = path.join(
        userExtensionsDir,
        'test-extension',
        'server',
      );
      expect(extensions[0].mcpServers?.['test-server'].cwd).toBe(expectedCwd);
    });

    it('should load a linked extension correctly', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempWorkspaceDir,
        name: 'my-linked-extension',
        version: '1.0.0',
        contextFileName: 'context.md',
      });
      fs.writeFileSync(path.join(sourceExtDir, 'context.md'), 'linked context');

      const extensionName = await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'link',
      });

      expect(extensionName).toEqual('my-linked-extension');
      const extensions = extensionManager.loadExtensions();
      expect(extensions).toHaveLength(1);

      const linkedExt = extensions[0];
      expect(linkedExt.name).toBe('my-linked-extension');

      expect(linkedExt.path).toBe(sourceExtDir);
      expect(linkedExt.installMetadata).toEqual({
        source: sourceExtDir,
        type: 'link',
      });
      expect(linkedExt.contextFiles).toEqual([
        path.join(sourceExtDir, 'context.md'),
      ]);
    });

    it('should resolve environment variables in extension configuration', () => {
      process.env['TEST_API_KEY'] = 'test-api-key-123';
      process.env['TEST_DB_URL'] = 'postgresql://localhost:5432/testdb';

      try {
        const userExtensionsDir = path.join(
          tempHomeDir,
          EXTENSIONS_DIRECTORY_NAME,
        );
        fs.mkdirSync(userExtensionsDir, { recursive: true });

        const extDir = path.join(userExtensionsDir, 'test-extension');
        fs.mkdirSync(extDir);

        // Write config to a separate file for clarity and good practices
        const configPath = path.join(extDir, EXTENSIONS_CONFIG_FILENAME);
        const extensionConfig = {
          name: 'test-extension',
          version: '1.0.0',
          mcpServers: {
            'test-server': {
              command: 'node',
              args: ['server.js'],
              env: {
                API_KEY: '$TEST_API_KEY',
                DATABASE_URL: '${TEST_DB_URL}',
                STATIC_VALUE: 'no-substitution',
              },
            },
          },
        };
        fs.writeFileSync(configPath, JSON.stringify(extensionConfig));

        const extensions = extensionManager.loadExtensions();

        expect(extensions).toHaveLength(1);
        const extension = extensions[0];
        expect(extension.name).toBe('test-extension');
        expect(extension.mcpServers).toBeDefined();

        const serverConfig = extension.mcpServers?.['test-server'];
        expect(serverConfig).toBeDefined();
        expect(serverConfig?.env).toBeDefined();
        expect(serverConfig?.env?.['API_KEY']).toBe('test-api-key-123');
        expect(serverConfig?.env?.['DATABASE_URL']).toBe(
          'postgresql://localhost:5432/testdb',
        );
        expect(serverConfig?.env?.['STATIC_VALUE']).toBe('no-substitution');
      } finally {
        delete process.env['TEST_API_KEY'];
        delete process.env['TEST_DB_URL'];
      }
    });

    it('should resolve environment variables from an extension .env file', () => {
      const extDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: {
              API_KEY: '$MY_API_KEY',
              STATIC_VALUE: 'no-substitution',
            },
          },
        },
      });

      const envFilePath = path.join(extDir, '.env');
      fs.writeFileSync(envFilePath, 'MY_API_KEY=test-key-from-file\n');

      const extensions = extensionManager.loadExtensions();

      expect(extensions).toHaveLength(1);
      const extension = extensions[0];
      const serverConfig = extension.mcpServers!['test-server'];
      expect(serverConfig.env).toBeDefined();
      expect(serverConfig.env!['API_KEY']).toBe('test-key-from-file');
      expect(serverConfig.env!['STATIC_VALUE']).toBe('no-substitution');
    });

    it('should handle missing environment variables gracefully', () => {
      const userExtensionsDir = path.join(
        tempHomeDir,
        EXTENSIONS_DIRECTORY_NAME,
      );
      fs.mkdirSync(userExtensionsDir, { recursive: true });

      const extDir = path.join(userExtensionsDir, 'test-extension');
      fs.mkdirSync(extDir);

      const extensionConfig = {
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: {
              MISSING_VAR: '$UNDEFINED_ENV_VAR',
              MISSING_VAR_BRACES: '${ALSO_UNDEFINED}',
            },
          },
        },
      };

      fs.writeFileSync(
        path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(extensionConfig),
      );

      const extensions = extensionManager.loadExtensions();

      expect(extensions).toHaveLength(1);
      const extension = extensions[0];
      const serverConfig = extension.mcpServers!['test-server'];
      expect(serverConfig.env).toBeDefined();
      expect(serverConfig.env!['MISSING_VAR']).toBe('$UNDEFINED_ENV_VAR');
      expect(serverConfig.env!['MISSING_VAR_BRACES']).toBe('${ALSO_UNDEFINED}');
    });

    it('should skip extensions with invalid JSON and log a warning', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      // Good extension
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'good-ext',
        version: '1.0.0',
      });

      // Bad extension
      const badExtDir = path.join(userExtensionsDir, 'bad-ext');
      fs.mkdirSync(badExtDir);
      const badConfigPath = path.join(badExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(badConfigPath, '{ "name": "bad-ext"'); // Malformed

      const extensions = extensionManager.loadExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].name).toBe('good-ext');
      expect(consoleSpy).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Warning: Skipping extension in ${badExtDir}: Failed to load extension config from ${badConfigPath}`,
        ),
      );

      consoleSpy.mockRestore();
    });

    it('should skip extensions with missing name and log a warning', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      // Good extension
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'good-ext',
        version: '1.0.0',
      });

      // Bad extension
      const badExtDir = path.join(userExtensionsDir, 'bad-ext-no-name');
      fs.mkdirSync(badExtDir);
      const badConfigPath = path.join(badExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(badConfigPath, JSON.stringify({ version: '1.0.0' }));

      const extensions = extensionManager.loadExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].name).toBe('good-ext');
      expect(consoleSpy).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `Warning: Skipping extension in ${badExtDir}: Failed to load extension config from ${badConfigPath}: Invalid configuration in ${badConfigPath}: missing "name"`,
        ),
      );

      consoleSpy.mockRestore();
    });

    it('should filter trust out of mcp servers', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            trust: true,
          },
        },
      });

      const extensions = extensionManager.loadExtensions();
      expect(extensions).toHaveLength(1);
      expect(extensions[0].mcpServers?.['test-server'].trust).toBeUndefined();
    });

    it('should throw an error for invalid extension names', () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      const badExtDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'bad_name',
        version: '1.0.0',
      });

      const extension = extensionManager.loadExtension(badExtDir);

      expect(extension).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid extension name: "bad_name"'),
      );
      consoleSpy.mockRestore();
    });

    describe('id generation', () => {
      it('should generate id from source for non-github git urls', () => {
        const extensionDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'my-ext',
          version: '1.0.0',
          installMetadata: {
            type: 'git',
            source: 'http://somehost.com/foo/bar',
          },
        });

        const extension = extensionManager.loadExtension(extensionDir);
        expect(extension?.id).toBe(hashValue('http://somehost.com/foo/bar'));
      });

      it('should generate id from owner/repo for github http urls', () => {
        const extensionDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'my-ext',
          version: '1.0.0',
          installMetadata: {
            type: 'git',
            source: 'http://github.com/foo/bar',
          },
        });

        const extension = extensionManager.loadExtension(extensionDir);
        expect(extension?.id).toBe(hashValue('https://github.com/foo/bar'));
      });

      it('should generate id from owner/repo for github ssh urls', () => {
        const extensionDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'my-ext',
          version: '1.0.0',
          installMetadata: {
            type: 'git',
            source: 'git@github.com:foo/bar',
          },
        });

        const extension = extensionManager.loadExtension(extensionDir);
        expect(extension?.id).toBe(hashValue('https://github.com/foo/bar'));
      });

      it('should generate id from source for github-release extension', () => {
        const extensionDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'my-ext',
          version: '1.0.0',
          installMetadata: {
            type: 'github-release',
            source: 'https://github.com/foo/bar',
          },
        });

        const extension = extensionManager.loadExtension(extensionDir);
        expect(extension?.id).toBe(hashValue('https://github.com/foo/bar'));
      });

      it('should generate id from the original source for local extension', () => {
        const extensionDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'local-ext-name',
          version: '1.0.0',
          installMetadata: {
            type: 'local',
            source: '/some/path',
          },
        });

        const extension = extensionManager.loadExtension(extensionDir);
        expect(extension?.id).toBe(hashValue('/some/path'));
      });

      it('should generate id from the original source for linked extensions', async () => {
        const extDevelopmentDir = path.join(tempHomeDir, 'local_extensions');
        const actualExtensionDir = createExtension({
          extensionsDir: extDevelopmentDir,
          name: 'link-ext-name',
          version: '1.0.0',
        });
        const extensionName = await extensionManager.installOrUpdateExtension({
          type: 'link',
          source: actualExtensionDir,
        });

        const extension = extensionManager.loadExtension(
          new ExtensionStorage(extensionName).getExtensionDir(),
        );
        expect(extension?.id).toBe(hashValue(actualExtensionDir));
      });

      it('should generate id from name for extension with no install metadata', () => {
        const extensionDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'no-meta-name',
          version: '1.0.0',
        });

        const extension = extensionManager.loadExtension(extensionDir);
        expect(extension?.id).toBe(hashValue('no-meta-name'));
      });
    });
  });

  describe('installExtension', () => {
    it('should install an extension from a local path', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
      });
      const targetExtDir = path.join(userExtensionsDir, 'my-local-extension');
      const metadataPath = path.join(targetExtDir, INSTALL_METADATA_FILENAME);

      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'local',
      });

      expect(fs.existsSync(targetExtDir)).toBe(true);
      expect(fs.existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      expect(metadata).toEqual({
        source: sourceExtDir,
        type: 'local',
      });
      fs.rmSync(targetExtDir, { recursive: true, force: true });
    });

    it('should throw an error if the extension already exists', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
      });
      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'local',
      });
      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).rejects.toThrow(
        'Extension "my-local-extension" is already installed. Please uninstall it first.',
      );
    });

    it('should throw an error and cleanup if gemini-extension.json is missing', async () => {
      const sourceExtDir = path.join(tempHomeDir, 'bad-extension');
      fs.mkdirSync(sourceExtDir, { recursive: true });
      const configPath = path.join(sourceExtDir, EXTENSIONS_CONFIG_FILENAME);

      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).rejects.toThrow(`Configuration file not found at ${configPath}`);

      const targetExtDir = path.join(userExtensionsDir, 'bad-extension');
      expect(fs.existsSync(targetExtDir)).toBe(false);
    });

    it('should throw an error for invalid JSON in gemini-extension.json', async () => {
      const sourceExtDir = path.join(tempHomeDir, 'bad-json-ext');
      fs.mkdirSync(sourceExtDir, { recursive: true });
      const configPath = path.join(sourceExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(configPath, '{ "name": "bad-json", "version": "1.0.0"'); // Malformed JSON

      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).rejects.toThrow(
        new RegExp(
          `^Failed to load extension config from ${configPath.replace(
            /\\/g,
            '\\\\',
          )}`,
        ),
      );
    });

    it('should throw an error for missing name in gemini-extension.json', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'missing-name-ext',
        version: '1.0.0',
      });
      const configPath = path.join(sourceExtDir, EXTENSIONS_CONFIG_FILENAME);
      // Overwrite with invalid config
      fs.writeFileSync(configPath, JSON.stringify({ version: '1.0.0' }));

      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).rejects.toThrow(
        `Invalid configuration in ${configPath}: missing "name"`,
      );
    });

    it('should install an extension from a git URL', async () => {
      const gitUrl = 'https://somehost.com/somerepo.git';
      const extensionName = 'some-extension';
      const targetExtDir = path.join(userExtensionsDir, extensionName);
      const metadataPath = path.join(targetExtDir, INSTALL_METADATA_FILENAME);

      mockGit.clone.mockImplementation(async (_, destination) => {
        fs.mkdirSync(path.join(mockGit.path(), destination), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(mockGit.path(), destination, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: extensionName, version: '1.0.0' }),
        );
      });
      mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
      mockDownloadFromGithubRelease.mockResolvedValue({
        success: false,
        failureReason: 'no release data',
        type: 'github-release',
      });

      await extensionManager.installOrUpdateExtension({
        source: gitUrl,
        type: 'git',
      });

      expect(fs.existsSync(targetExtDir)).toBe(true);
      expect(fs.existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      expect(metadata).toEqual({
        source: gitUrl,
        type: 'git',
      });
    });

    it('should install a linked extension', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-linked-extension',
        version: '1.0.0',
      });
      const targetExtDir = path.join(userExtensionsDir, 'my-linked-extension');
      const metadataPath = path.join(targetExtDir, INSTALL_METADATA_FILENAME);
      const configPath = path.join(targetExtDir, EXTENSIONS_CONFIG_FILENAME);

      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'link',
      });

      expect(fs.existsSync(targetExtDir)).toBe(true);
      expect(fs.existsSync(metadataPath)).toBe(true);

      expect(fs.existsSync(configPath)).toBe(false);

      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      expect(metadata).toEqual({
        source: sourceExtDir,
        type: 'link',
      });
      fs.rmSync(targetExtDir, { recursive: true, force: true });
    });

    describe.each([true, false])(
      'with previous extension config: %s',
      (isUpdate: boolean) => {
        let sourceExtDir: string;

        beforeEach(async () => {
          sourceExtDir = createExtension({
            extensionsDir: tempHomeDir,
            name: 'my-local-extension',
            version: '1.1.0',
          });
          if (isUpdate) {
            await extensionManager.installOrUpdateExtension({
              source: sourceExtDir,
              type: 'local',
            });
          }
          // Clears out any calls to mocks from the above function calls.
          vi.clearAllMocks();
        });

        it(`should log an ${isUpdate ? 'update' : 'install'} event to clearcut on success`, async () => {
          await extensionManager.installOrUpdateExtension(
            { source: sourceExtDir, type: 'local' },
            isUpdate
              ? {
                  name: 'my-local-extension',
                  version: '1.0.0',
                }
              : undefined,
          );

          if (isUpdate) {
            expect(mockLogExtensionUpdateEvent).toHaveBeenCalled();
            expect(mockLogExtensionInstallEvent).not.toHaveBeenCalled();
          } else {
            expect(mockLogExtensionInstallEvent).toHaveBeenCalled();
            expect(mockLogExtensionUpdateEvent).not.toHaveBeenCalled();
          }
        });

        it(`should ${isUpdate ? 'not ' : ''} alter the extension enablement configuration`, async () => {
          const enablementManager = new ExtensionEnablementManager();
          enablementManager.enable('my-local-extension', true, '/some/scope');

          await extensionManager.installOrUpdateExtension(
            { source: sourceExtDir, type: 'local' },
            isUpdate
              ? {
                  name: 'my-local-extension',
                  version: '1.0.0',
                }
              : undefined,
          );

          const config = enablementManager.readConfig()['my-local-extension'];
          if (isUpdate) {
            expect(config).not.toBeUndefined();
            expect(config.overrides).toContain('/some/scope/*');
          } else {
            expect(config).not.toContain('/some/scope/*');
          }
        });
      },
    );

    it('should show users information on their ansi escaped mcp servers when installing', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node dobadthing \u001b[12D\u001b[K',
            args: ['server.js'],
            description: 'a local mcp server',
          },
          'test-server-2': {
            description: 'a remote mcp server',
            httpUrl: 'https://google.com',
          },
        },
      });

      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).resolves.toBe('my-local-extension');

      expect(mockRequestConsent).toHaveBeenCalledWith(
        `Installing extension "my-local-extension".
${INSTALL_WARNING_MESSAGE}
This extension will run the following MCP servers:
  * test-server (local): node dobadthing \\u001b[12D\\u001b[K server.js
  * test-server-2 (remote): https://google.com`,
      );
    });

    it('should continue installation if user accepts prompt for local extension with mcp servers', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
          },
        },
      });

      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).resolves.toBe('my-local-extension');
    });

    it('should cancel installation if user declines prompt for local extension with mcp servers', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
          },
        },
      });
      mockRequestConsent.mockResolvedValue(false);
      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).rejects.toThrow('Installation cancelled for "my-local-extension".');
    });

    it('should save the autoUpdate flag to the install metadata', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
      });
      const targetExtDir = path.join(userExtensionsDir, 'my-local-extension');
      const metadataPath = path.join(targetExtDir, INSTALL_METADATA_FILENAME);

      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'local',
        autoUpdate: true,
      });

      expect(fs.existsSync(targetExtDir)).toBe(true);
      expect(fs.existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
      expect(metadata).toEqual({
        source: sourceExtDir,
        type: 'local',
        autoUpdate: true,
      });
      fs.rmSync(targetExtDir, { recursive: true, force: true });
    });

    it('should ignore consent flow if not required', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
          },
        },
      });

      // Install it with hard coded consent first.
      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'local',
      });
      expect(mockRequestConsent).toHaveBeenCalledOnce();

      // Now update it without changing anything.
      await expect(
        extensionManager.installOrUpdateExtension(
          { source: sourceExtDir, type: 'local' },
          // Provide its own existing config as the previous config.
          await extensionManager.loadExtensionConfig(sourceExtDir),
        ),
      ).resolves.toBe('my-local-extension');

      // Still only called once
      expect(mockRequestConsent).toHaveBeenCalledOnce();
    });

    it('should prompt for settings if promptForSettings', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
        settings: [
          {
            name: 'API Key',
            description: 'Your API key for the service.',
            envVar: 'MY_API_KEY',
          },
        ],
      });

      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'local',
      });

      expect(mockPromptForSettings).toHaveBeenCalled();
    });

    it('should not prompt for settings if promptForSettings is false', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-local-extension',
        version: '1.0.0',
        settings: [
          {
            name: 'API Key',
            description: 'Your API key for the service.',
            envVar: 'MY_API_KEY',
          },
        ],
      });

      extensionManager = new ExtensionManager({
        workspaceDir: tempWorkspaceDir,
        requestConsent: mockRequestConsent,
        requestSetting: null,
        loadedSettings: loadSettings(tempWorkspaceDir),
      });

      await extensionManager.installOrUpdateExtension({
        source: sourceExtDir,
        type: 'local',
      });
    });

    it('should only prompt for new settings on update, and preserve old settings', async () => {
      // 1. Create and install the "old" version of the extension.
      const oldSourceExtDir = createExtension({
        extensionsDir: tempHomeDir, // Create it in a temp location first
        name: 'my-local-extension',
        version: '1.0.0',
        settings: [
          {
            name: 'API Key',
            description: 'Your API key for the service.',
            envVar: 'MY_API_KEY',
          },
        ],
      });

      mockPromptForSettings.mockResolvedValueOnce('old-api-key');
      // Install it so it exists in the userExtensionsDir
      await extensionManager.installOrUpdateExtension({
        source: oldSourceExtDir,
        type: 'local',
      });

      const envPath = new ExtensionStorage(
        'my-local-extension',
      ).getEnvFilePath();
      expect(fs.existsSync(envPath)).toBe(true);
      let envContent = fs.readFileSync(envPath, 'utf-8');
      expect(envContent).toContain('MY_API_KEY=old-api-key');
      expect(mockPromptForSettings).toHaveBeenCalledTimes(1);

      // 2. Create the "new" version of the extension in a new source directory.
      const newSourceExtDir = createExtension({
        extensionsDir: path.join(tempHomeDir, 'new-source'), // Another temp location
        name: 'my-local-extension', // Same name
        version: '1.1.0', // New version
        settings: [
          {
            name: 'API Key',
            description: 'Your API key for the service.',
            envVar: 'MY_API_KEY',
          },
          {
            name: 'New Setting',
            description: 'A new setting.',
            envVar: 'NEW_SETTING',
          },
        ],
      });

      const previousExtensionConfig = extensionManager.loadExtensionConfig(
        path.join(userExtensionsDir, 'my-local-extension'),
      );
      mockPromptForSettings.mockResolvedValueOnce('new-setting-value');

      // 3. Call installOrUpdateExtension to perform the update.
      await extensionManager.installOrUpdateExtension(
        { source: newSourceExtDir, type: 'local' },
        previousExtensionConfig,
      );

      expect(mockPromptForSettings).toHaveBeenCalledTimes(2);
      expect(mockPromptForSettings).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Setting' }),
      );

      expect(fs.existsSync(envPath)).toBe(true);
      envContent = fs.readFileSync(envPath, 'utf-8');
      expect(envContent).toContain('MY_API_KEY=old-api-key');
      expect(envContent).toContain('NEW_SETTING=new-setting-value');
    });

    it('should fail auto-update if settings have changed', async () => {
      // 1. Install initial version with autoUpdate: true
      const oldSourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-auto-update-ext',
        version: '1.0.0',
        settings: [
          {
            name: 'OLD_SETTING',
            envVar: 'OLD_SETTING',
            description: 'An old setting',
          },
        ],
      });
      await extensionManager.installOrUpdateExtension({
        source: oldSourceExtDir,
        type: 'local',
        autoUpdate: true,
      });

      // 2. Create new version with different settings
      const newSourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'my-auto-update-ext',
        version: '1.1.0',
        settings: [
          {
            name: 'NEW_SETTING',
            envVar: 'NEW_SETTING',
            description: 'A new setting',
          },
        ],
      });

      const previousExtensionConfig = extensionManager.loadExtensionConfig(
        path.join(userExtensionsDir, 'my-auto-update-ext'),
      );

      // 3. Attempt to update and assert it fails
      await expect(
        extensionManager.installOrUpdateExtension(
          { source: newSourceExtDir, type: 'local', autoUpdate: true },
          previousExtensionConfig,
        ),
      ).rejects.toThrow(
        'Extension "my-auto-update-ext" has settings changes and cannot be auto-updated. Please update manually.',
      );
    });

    it('should throw an error for invalid extension names', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: tempHomeDir,
        name: 'bad_name',
        version: '1.0.0',
      });

      await expect(
        extensionManager.installOrUpdateExtension({
          source: sourceExtDir,
          type: 'local',
        }),
      ).rejects.toThrow('Invalid extension name: "bad_name"');
    });

    describe('installing from github', () => {
      const gitUrl = 'https://github.com/google/gemini-test-extension.git';
      const extensionName = 'gemini-test-extension';

      beforeEach(() => {
        // Mock the git clone behavior for github installs that fallback to it.
        mockGit.clone.mockImplementation(async (_, destination) => {
          fs.mkdirSync(path.join(mockGit.path(), destination), {
            recursive: true,
          });
          fs.writeFileSync(
            path.join(mockGit.path(), destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: extensionName, version: '1.0.0' }),
          );
        });
        mockGit.getRemotes.mockResolvedValue([{ name: 'origin' }]);
      });

      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('should install from a github release successfully', async () => {
        const targetExtDir = path.join(userExtensionsDir, extensionName);
        mockDownloadFromGithubRelease.mockResolvedValue({
          success: true,
          tagName: 'v1.0.0',
          type: 'github-release',
        });

        const tempDir = path.join(tempHomeDir, 'temp-ext');
        fs.mkdirSync(tempDir, { recursive: true });
        createExtension({
          extensionsDir: tempDir,
          name: extensionName,
          version: '1.0.0',
        });
        vi.spyOn(ExtensionStorage, 'createTmpDir').mockResolvedValue(
          join(tempDir, extensionName),
        );

        await extensionManager.installOrUpdateExtension({
          source: gitUrl,
          type: 'github-release',
        });

        expect(fs.existsSync(targetExtDir)).toBe(true);
        const metadataPath = path.join(targetExtDir, INSTALL_METADATA_FILENAME);
        expect(fs.existsSync(metadataPath)).toBe(true);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        expect(metadata).toEqual({
          source: gitUrl,
          type: 'github-release',
          releaseTag: 'v1.0.0',
        });
      });

      it('should fallback to git clone if github release download fails and user consents', async () => {
        mockDownloadFromGithubRelease.mockResolvedValue({
          success: false,
          failureReason: 'failed to download asset',
          errorMessage: 'download failed',
          type: 'github-release',
        });

        await extensionManager.installOrUpdateExtension(
          { source: gitUrl, type: 'github-release' }, // Use github-release to force consent
        );

        // It gets called once to ask for a git clone, and once to consent to
        // the actual extension features.
        expect(mockRequestConsent).toHaveBeenCalledTimes(2);
        expect(mockRequestConsent).toHaveBeenCalledWith(
          expect.stringContaining(
            'Would you like to attempt to install via "git clone" instead?',
          ),
        );
        expect(mockGit.clone).toHaveBeenCalled();
        const metadataPath = path.join(
          userExtensionsDir,
          extensionName,
          INSTALL_METADATA_FILENAME,
        );
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        expect(metadata.type).toBe('git');
      });

      it('should throw an error if github release download fails and user denies consent', async () => {
        mockDownloadFromGithubRelease.mockResolvedValue({
          success: false,
          errorMessage: 'download failed',
          type: 'github-release',
        });
        mockRequestConsent.mockResolvedValue(false);

        await expect(
          extensionManager.installOrUpdateExtension({
            source: gitUrl,
            type: 'github-release',
          }),
        ).rejects.toThrow(
          `Failed to install extension ${gitUrl}: download failed`,
        );

        expect(mockRequestConsent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(
            'Would you like to attempt to install via "git clone" instead?',
          ),
        );
        expect(mockGit.clone).not.toHaveBeenCalled();
      });

      it('should fallback to git clone without consent if no release data is found on first install', async () => {
        mockDownloadFromGithubRelease.mockResolvedValue({
          success: false,
          failureReason: 'no release data',
          type: 'github-release',
        });

        await extensionManager.installOrUpdateExtension({
          source: gitUrl,
          type: 'git',
        });

        // We should not see the request to use git clone, this is a repo that
        // has no github releases so it is the only install method.
        expect(mockRequestConsent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(
            'Installing extension "gemini-test-extension"',
          ),
        );
        expect(mockGit.clone).toHaveBeenCalled();
        const metadataPath = path.join(
          userExtensionsDir,
          extensionName,
          INSTALL_METADATA_FILENAME,
        );
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
        expect(metadata.type).toBe('git');
      });

      it('should ask for consent if no release data is found for an existing github-release extension', async () => {
        mockDownloadFromGithubRelease.mockResolvedValue({
          success: false,
          failureReason: 'no release data',
          errorMessage: 'No release data found',
          type: 'github-release',
        });

        await extensionManager.installOrUpdateExtension(
          { source: gitUrl, type: 'github-release' }, // Note the type
        );

        expect(mockRequestConsent).toHaveBeenCalledWith(
          expect.stringContaining(
            'Would you like to attempt to install via "git clone" instead?',
          ),
        );
        expect(mockGit.clone).toHaveBeenCalled();
      });
    });
  });

  describe('uninstallExtension', () => {
    it('should uninstall an extension by name', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-local-extension',
        version: '1.0.0',
      });

      await extensionManager.uninstallExtension('my-local-extension', false);

      expect(fs.existsSync(sourceExtDir)).toBe(false);
    });

    it('should uninstall an extension by name and retain existing extensions', async () => {
      const sourceExtDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-local-extension',
        version: '1.0.0',
      });
      const otherExtDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'other-extension',
        version: '1.0.0',
      });

      await extensionManager.uninstallExtension('my-local-extension', false);

      expect(fs.existsSync(sourceExtDir)).toBe(false);
      expect(extensionManager.loadExtensions()).toHaveLength(1);
      expect(fs.existsSync(otherExtDir)).toBe(true);
    });

    it('should throw an error if the extension does not exist', async () => {
      await expect(
        extensionManager.uninstallExtension('nonexistent-extension', false),
      ).rejects.toThrow('Extension not found.');
    });

    describe.each([true, false])('with isUpdate: %s', (isUpdate: boolean) => {
      it(`should ${isUpdate ? 'not ' : ''}log uninstall event`, async () => {
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'my-local-extension',
          version: '1.0.0',
          installMetadata: {
            source: userExtensionsDir,
            type: 'local',
          },
        });

        await extensionManager.uninstallExtension(
          'my-local-extension',
          isUpdate,
        );

        if (isUpdate) {
          expect(mockLogExtensionUninstall).not.toHaveBeenCalled();
          expect(ExtensionUninstallEvent).not.toHaveBeenCalled();
        } else {
          expect(mockLogExtensionUninstall).toHaveBeenCalled();
          expect(ExtensionUninstallEvent).toHaveBeenCalledWith(
            hashValue('my-local-extension'),
            hashValue(userExtensionsDir),
            'success',
          );
        }
      });

      it(`should ${isUpdate ? 'not ' : ''} alter the extension enablement configuration`, async () => {
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'test-extension',
          version: '1.0.0',
        });
        const enablementManager = new ExtensionEnablementManager();
        enablementManager.enable('test-extension', true, '/some/scope');

        await extensionManager.uninstallExtension('test-extension', isUpdate);

        const config = enablementManager.readConfig()['test-extension'];
        if (isUpdate) {
          expect(config).not.toBeUndefined();
          expect(config.overrides).toEqual(['/some/scope/*']);
        } else {
          expect(config).toBeUndefined();
        }
      });
    });

    it('should uninstall an extension by its source URL', async () => {
      const gitUrl = 'https://github.com/google/gemini-sql-extension.git';
      const sourceExtDir = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'gemini-sql-extension',
        version: '1.0.0',
        installMetadata: {
          source: gitUrl,
          type: 'git',
        },
      });

      await extensionManager.uninstallExtension(gitUrl, false);

      expect(fs.existsSync(sourceExtDir)).toBe(false);
      expect(mockLogExtensionUninstall).toHaveBeenCalled();
      expect(ExtensionUninstallEvent).toHaveBeenCalledWith(
        hashValue('gemini-sql-extension'),
        hashValue('https://github.com/google/gemini-sql-extension'),
        'success',
      );
    });

    it('should fail to uninstall by URL if an extension has no install metadata', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'no-metadata-extension',
        version: '1.0.0',
        // No installMetadata provided
      });

      await expect(
        extensionManager.uninstallExtension(
          'https://github.com/google/no-metadata-extension',
          false,
        ),
      ).rejects.toThrow('Extension not found.');
    });
  });

  describe('disableExtension', () => {
    it('should disable an extension at the user scope', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      extensionManager.disableExtension('my-extension', SettingScope.User);
      expect(
        isEnabled({
          name: 'my-extension',
          enabledForPath: tempWorkspaceDir,
        }),
      ).toBe(false);
    });

    it('should disable an extension at the workspace scope', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      extensionManager.disableExtension('my-extension', SettingScope.Workspace);
      expect(
        isEnabled({
          name: 'my-extension',
          enabledForPath: tempHomeDir,
        }),
      ).toBe(true);
      expect(
        isEnabled({
          name: 'my-extension',
          enabledForPath: tempWorkspaceDir,
        }),
      ).toBe(false);
    });

    it('should handle disabling the same extension twice', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      extensionManager.disableExtension('my-extension', SettingScope.User);
      extensionManager.disableExtension('my-extension', SettingScope.User);
      expect(
        isEnabled({
          name: 'my-extension',
          enabledForPath: tempWorkspaceDir,
        }),
      ).toBe(false);
    });

    it('should throw an error if you request system scope', () => {
      expect(() =>
        extensionManager.disableExtension('my-extension', SettingScope.System),
      ).toThrow('System and SystemDefaults scopes are not supported.');
    });

    it('should log a disable event', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        installMetadata: {
          source: userExtensionsDir,
          type: 'local',
        },
      });

      extensionManager.disableExtension('ext1', SettingScope.Workspace);

      expect(mockLogExtensionDisable).toHaveBeenCalled();
      expect(ExtensionDisableEvent).toHaveBeenCalledWith(
        hashValue('ext1'),
        hashValue(userExtensionsDir),
        SettingScope.Workspace,
      );
    });
  });

  describe('enableExtension', () => {
    afterAll(() => {
      vi.restoreAllMocks();
    });

    const getActiveExtensions = (): GeminiCLIExtension[] => {
      const extensions = extensionManager.loadExtensions();
      return extensions.filter((e) => e.isActive);
    };

    it('should enable an extension at the user scope', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      extensionManager.disableExtension('ext1', SettingScope.User);
      let activeExtensions = getActiveExtensions();
      expect(activeExtensions).toHaveLength(0);

      extensionManager.enableExtension('ext1', SettingScope.User);
      activeExtensions = getActiveExtensions();
      expect(activeExtensions).toHaveLength(1);
      expect(activeExtensions[0].name).toBe('ext1');
    });

    it('should enable an extension at the workspace scope', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      extensionManager.disableExtension('ext1', SettingScope.Workspace);
      let activeExtensions = getActiveExtensions();
      expect(activeExtensions).toHaveLength(0);

      extensionManager.enableExtension('ext1', SettingScope.Workspace);
      activeExtensions = getActiveExtensions();
      expect(activeExtensions).toHaveLength(1);
      expect(activeExtensions[0].name).toBe('ext1');
    });

    it('should log an enable event', () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        installMetadata: {
          source: userExtensionsDir,
          type: 'local',
        },
      });
      extensionManager.disableExtension('ext1', SettingScope.Workspace);
      extensionManager.enableExtension('ext1', SettingScope.Workspace);

      expect(mockLogExtensionEnable).toHaveBeenCalled();
      expect(ExtensionEnableEvent).toHaveBeenCalledWith(
        hashValue('ext1'),
        hashValue(userExtensionsDir),
        SettingScope.Workspace,
      );
    });
  });
});

function isEnabled(options: { name: string; enabledForPath: string }) {
  const manager = new ExtensionEnablementManager();
  return manager.isEnabled(options.name, options.enabledForPath);
}
