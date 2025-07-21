/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const { mockProcessExit } = vi.hoisted(() => ({
  mockProcessExit: vi.fn((_code?: number): never => undefined as never),
}));

vi.mock('node:process', () => ({
  default: {
    exit: mockProcessExit,
    cwd: vi.fn(() => '/mock/cwd'),
    get env() {
      return process.env;
    },
    platform: 'test-platform',
    version: 'test-node-version',
    memoryUsage: vi.fn(() => ({
      rss: 12345678,
      heapTotal: 23456789,
      heapUsed: 10234567,
      external: 1234567,
      arrayBuffers: 123456,
    })),
  },
  exit: mockProcessExit,
  cwd: vi.fn(() => '/mock/cwd'),
  get env() {
    return process.env;
  },
  platform: 'test-platform',
  version: 'test-node-version',
  memoryUsage: vi.fn(() => ({
    rss: 12345678,
    heapTotal: 23456789,
    heapUsed: 10234567,
    external: 1234567,
    arrayBuffers: 123456,
  })),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

const mockGetCliVersionFn = vi.fn(() => Promise.resolve('0.1.0'));
vi.mock('../../utils/version.js', () => ({
  getCliVersion: (...args: []) => mockGetCliVersionFn(...args),
}));

import { act, renderHook } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach, beforeAll, Mock } from 'vitest';
import open from 'open';
import { useSlashCommandProcessor } from './slashCommandProcessor.js';
import { MessageType, SlashCommandProcessorResult } from '../types.js';
import {
  Config,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPDiscoveryState,
  getMCPServerStatus,
  GeminiClient,
} from '@thacio/auditaria-cli-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import { LoadedSettings } from '../../config/settings.js';
import * as ShowMemoryCommandModule from './useShowMemoryCommand.js';
import { CommandService } from '../../services/CommandService.js';
import { SlashCommand } from '../commands/types.js';

vi.mock('../contexts/SessionContext.js', () => ({
  useSessionStats: vi.fn(),
}));

vi.mock('open', () => ({
  default: vi.fn(),
}));

vi.mock('@thacio/auditaria-cli-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@thacio/auditaria-cli-core')>();
  return {
    ...actual,
  };
});

describe('useSlashCommandProcessor', () => {
  let mockAddItem: ReturnType<typeof vi.fn>;
  let mockClearItems: ReturnType<typeof vi.fn>;
  let mockLoadHistory: ReturnType<typeof vi.fn>;
  let mockRefreshStatic: ReturnType<typeof vi.fn>;
  let mockOpenHelp: ReturnType<typeof vi.fn>;
  let mockOpenAuthDialog: ReturnType<typeof vi.fn>;
  let mockOpenEditorDialog: ReturnType<typeof vi.fn>;
  let mockOpenLanguageDialog: ReturnType<typeof vi.fn>;
  let mockOpenPrivacyNotice: ReturnType<typeof vi.fn>;
  let mockOpenThemeDialog: ReturnType<typeof vi.fn>;
  let mockToggleCorgiMode: ReturnType<typeof vi.fn>;
  let mockSetDebugMessage: ReturnType<typeof vi.fn>;
  let mockSetQuittingMessages: ReturnType<typeof vi.fn>;
  let mockSetPendingCompressionItem: ReturnType<typeof vi.fn>;
  let mockUseShowMemoryCommand: ReturnType<typeof vi.fn>;
  let mockPendingCompressionItemRef: { current: null };
  let mockGeminiClient: GeminiClient;
  let mockTryCompressChat: ReturnType<typeof vi.fn>;
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockCommandService: CommandService;

  beforeAll(() => {
    vi.useFakeTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddItem = vi.fn();
    mockClearItems = vi.fn();
    mockLoadHistory = vi.fn();
    mockRefreshStatic = vi.fn();
    mockOpenHelp = vi.fn();
    mockOpenAuthDialog = vi.fn();
    mockOpenEditorDialog = vi.fn();
    mockOpenLanguageDialog = vi.fn();
    mockOpenPrivacyNotice = vi.fn();
    mockOpenThemeDialog = vi.fn();
    mockToggleCorgiMode = vi.fn();
    mockSetDebugMessage = vi.fn();
    mockSetQuittingMessages = vi.fn();
    mockSetPendingCompressionItem = vi.fn();
    mockUseShowMemoryCommand = vi.fn();
    mockPendingCompressionItemRef = { current: null };
    mockTryCompressChat = vi.fn();

    mockGeminiClient = {
      tryCompressChat: mockTryCompressChat,
    } as unknown as GeminiClient;

    mockConfig = {
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getProjectTempDir: vi.fn().mockReturnValue('/tmp/test'),
      getCheckpointingEnabled: vi.fn().mockReturnValue(true),
      getToolRegistry: vi.fn().mockResolvedValue({
        getAllTools: vi.fn().mockReturnValue([]),
      }),
      getMcpServers: vi.fn().mockReturnValue({}),
      getDebugMode: vi.fn(() => false),
      getSandbox: vi.fn(() => 'test-sandbox'),
      getModel: vi.fn(() => 'test-model'),
      getProjectRoot: vi.fn(() => '/test/dir'),
      getBugCommand: vi.fn(() => undefined),
      getSessionId: vi.fn(() => 'test-session-id'),
      getIdeMode: vi.fn(() => false),
    } as unknown as Config;

    mockSettings = {
      theme: 'dark',
      externalEditorPreference: 'vscode',
      acceptedPrivacyNoticeVersion: 1,
      languagePreference: 'en',
    } as LoadedSettings;

    mockCommandService = {
      loadCommands: vi.fn(),
      getCommands: vi.fn().mockReturnValue([]),
    } as unknown as CommandService;

    vi.mocked(useSessionStats).mockReturnValue({
      stats: {
        sessionStartTime: new Date(),
        lastPromptTokenCount: 0,
        metrics: {
          models: {},
          tools: {},
          userDecisions: {
            totalReviewed: 0,
            accepted: 0,
            rejected: 0,
            modified: 0,
            manuallyReviewed: 0,
          },
        },
      },
    });

    vi.mocked(ShowMemoryCommandModule.useShowMemoryCommand).mockReturnValue(
      mockUseShowMemoryCommand,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const getProcessorHook = () => {
    const settings = {
      merged: {
        contextFileName: 'GEMINI.md',
      },
    } as unknown as LoadedSettings;
    return renderHook(() =>
      useSlashCommandProcessor(
        mockConfig,
        settings,
        mockAddItem,
        mockClearItems,
        mockLoadHistory,
        mockRefreshStatic,
        mockOpenHelp,
        mockOpenAuthDialog,
        mockOpenEditorDialog,
        mockOpenLanguageDialog,
        mockToggleCorgiMode,
        mockSetQuittingMessages,
        mockOpenPrivacyNotice,
        mockSetPendingCompressionItem,
        mockPendingCompressionItemRef,
        mockConfig,
        mockSettings,
        undefined,
        mockCommandService,
      ),
    );

  };

  describe('Command Processing', () => {
    let ActualCommandService: typeof CommandService;

    beforeAll(async () => {
      const actual = (await vi.importActual(
        '../../services/CommandService.js',
      )) as { CommandService: typeof CommandService };
      ActualCommandService = actual.CommandService;
    });

    it('should handle /language command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/language');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenLanguageDialog).toHaveBeenCalled();
    });

<<<<<<< HEAD
    it('should handle /quit command', async () => {
      const { handleSlashCommand } = getProcessor();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
=======
    it('should execute a registered command', async () => {
      const mockAction = vi.fn();
      const newCommand: SlashCommand = { name: 'test', action: mockAction };
      const mockLoader = async () => [newCommand];

      // We create the instance outside the mock implementation.
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );

      // This mock ensures the hook uses our pre-configured instance.
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();

      await vi.waitFor(() => {
        // We check that the `slashCommands` array, which is the public API
        // of our hook, eventually contains the command we injected.
        expect(
          result.current.slashCommands.some((c) => c.name === 'test'),
        ).toBe(true);
      });

      expect(async () => {
        await handleSlashCommand('/quit');
        vi.advanceTimersByTime(200);
      }).rejects.toThrow('process.exit called');

      expect(mockSetQuittingMessages).toHaveBeenCalledWith([
        expect.objectContaining({
          type: 'user',
          text: '/quit',
        }),
        expect.objectContaining({
          type: 'quit',
        }),
      ]);

      exitSpy.mockRestore();
    });

    it('should handle /about command', async () => {
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand('/about');
      });

<<<<<<< HEAD
=======
      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should return "schedule_tool" for a command returning a tool action', async () => {
      const mockAction = vi.fn().mockResolvedValue({
        type: 'tool',
        toolName: 'my_tool',
        toolArgs: { arg1: 'value1' },
      });
      const newCommand: SlashCommand = { name: 'test', action: mockAction };
      const mockLoader = async () => [newCommand];
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();
      await vi.waitFor(() => {
        expect(
          result.current.slashCommands.some((c) => c.name === 'test'),
        ).toBe(true);
      });

      const commandResult = await result.current.handleSlashCommand('/test');

      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(commandResult).toEqual({
        type: 'schedule_tool',
        toolName: 'my_tool',
        toolArgs: { arg1: 'value1' },
      });
    });

    it('should return "handled" for a command returning a message action', async () => {
      const mockAction = vi.fn().mockResolvedValue({
        type: 'message',
        messageType: 'info',
        content: 'This is a message',
      });
      const newCommand: SlashCommand = { name: 'test', action: mockAction };
      const mockLoader = async () => [newCommand];
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();
      await vi.waitFor(() => {
        expect(
          result.current.slashCommands.some((c) => c.name === 'test'),
        ).toBe(true);
      });

      const commandResult = await result.current.handleSlashCommand('/test');

      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Gemini CLI'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

<<<<<<< HEAD
    it('should handle /stats command', async () => {
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
=======
    it('should return "handled" for a command returning a dialog action', async () => {
      const mockAction = vi.fn().mockResolvedValue({
        type: 'dialog',
        dialog: 'help',
      });
      const newCommand: SlashCommand = { name: 'test', action: mockAction };
      const mockLoader = async () => [newCommand];
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();
      await vi.waitFor(() => {
        expect(
          result.current.slashCommands.some((c) => c.name === 'test'),
        ).toBe(true);
      });

      const commandResult = await result.current.handleSlashCommand('/test');

      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(mockSetShowHelp).toHaveBeenCalledWith(true);
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should open the auth dialog for a command returning an auth dialog action', async () => {
      const mockAction = vi.fn().mockResolvedValue({
        type: 'dialog',
        dialog: 'auth',
      });
      const newAuthCommand: SlashCommand = { name: 'auth', action: mockAction };

      const mockLoader = async () => [newAuthCommand];
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();
      await vi.waitFor(() => {
        expect(
          result.current.slashCommands.some((c) => c.name === 'auth'),
        ).toBe(true);
      });

      const commandResult = await result.current.handleSlashCommand('/auth');

      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(mockOpenAuthDialog).toHaveBeenCalledWith();
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should open the theme dialog for a command returning a theme dialog action', async () => {
      const mockAction = vi.fn().mockResolvedValue({
        type: 'dialog',
        dialog: 'theme',
      });
      const newCommand: SlashCommand = { name: 'test', action: mockAction };
      const mockLoader = async () => [newCommand];
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();
      await vi.waitFor(() => {
        expect(
          result.current.slashCommands.some((c) => c.name === 'test'),
        ).toBe(true);
      });

      const commandResult = await result.current.handleSlashCommand('/test');

      expect(mockAction).toHaveBeenCalledTimes(1);
      expect(mockOpenThemeDialog).toHaveBeenCalledWith();
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should show help for a parent command with no action', async () => {
      const parentCommand: SlashCommand = {
        name: 'parent',
        subCommands: [
          { name: 'child', description: 'A child.', action: vi.fn() },
        ],
      };

      const mockLoader = async () => [parentCommand];
      const commandServiceInstance = new ActualCommandService(
        mockConfig,
        mockLoader,
      );
      vi.mocked(CommandService).mockImplementation(
        () => commandServiceInstance,
      );

      const { result } = getProcessorHook();

      await vi.waitFor(() => {
        expect(
          result.current.slashCommands.some((c) => c.name === 'parent'),
        ).toBe(true);
      });

      await act(async () => {
        commandResult = await handleSlashCommand('/stats');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Session Stats'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should handle /memory command', async () => {
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand('/memory');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.ERROR,
          text: expect.stringContaining('requires a subcommand'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should handle /docs command', async () => {
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand('/docs');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Opening documentation'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should handle /bug command', async () => {
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand('/bug');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('bug report'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should handle /tools command', async () => {
      mockConfig = {
        ...mockConfig,
        getToolRegistry: vi.fn().mockResolvedValue({
          getAllTools: vi.fn().mockReturnValue([
            { name: 'Tool1', description: 'Description for Tool1' },
            { name: 'Tool2', description: 'Description for Tool2' },
          ]),
        }),
      } as unknown as Config;
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand('/tools');
      });

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Available Gemini CLI tools'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should handle /tools desc command', async () => {
      mockConfig = {
        ...mockConfig,
        getToolRegistry: vi.fn().mockResolvedValue({
          getAllTools: vi.fn().mockReturnValue([
            { name: 'Tool1', description: 'Description for Tool1' },
            { name: 'Tool2', description: 'Description for Tool2' },
          ]),
        }),
      } as unknown as Config;
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand('/tools desc');
      });

      const message = mockAddItem.mock.calls[1][0].text;
      expect(message).toContain('Tool1');
      expect(message).toContain('Description for Tool1');
      expect(message).toContain('Tool2');
      expect(message).toContain('Description for Tool2');
      expect(commandResult).toEqual({ type: 'handled' });
    });
  });
});
