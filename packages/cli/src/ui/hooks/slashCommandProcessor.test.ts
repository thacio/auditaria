/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, act } from '@testing-library/react';
import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  Mock,
} from 'vitest';
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
import { GIT_COMMIT_INFO } from '../../generated/git-commit.js';
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

  const getProcessor = () => getProcessorHook().result.current;

  describe('Other commands', () => {
    it('should return false for non-string input', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand([
        { text: 'not a slash command' },
      ]);
      expect(result).toBe(false);
    });

    it('should return false for non-slash command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('not a slash command');
      expect(result).toBe(false);
    });

    it('should handle /help command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/help');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenHelp).toHaveBeenCalled();
    });

    it('should handle /auth command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/auth');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenAuthDialog).toHaveBeenCalled();
    });

    it('should handle /theme command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/theme');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenThemeDialog).toHaveBeenCalled();
    });

    it('should handle /privacy command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/privacy');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenPrivacyNotice).toHaveBeenCalled();
    });

    it('should handle /editor command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/editor');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenEditorDialog).toHaveBeenCalled();
    });

    it('should handle /language command', async () => {
      const { handleSlashCommand } = getProcessor();
      const result = await handleSlashCommand('/language');
      expect(result).toEqual({ type: 'handled' });
      expect(mockOpenLanguageDialog).toHaveBeenCalled();
    });

    it('should handle /quit command', async () => {
      const { handleSlashCommand } = getProcessor();
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit called');
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

      expect(mockAddItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.INFO,
          text: expect.stringContaining('Gemini CLI'),
        }),
        expect.any(Number),
      );
      expect(commandResult).toEqual({ type: 'handled' });
    });

    it('should handle /stats command', async () => {
      const { handleSlashCommand } = getProcessor();
      let commandResult: SlashCommandProcessorResult | false = false;
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

<<<<<<< HEAD
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
=======
    it('should use the custom bug command URL from config if available', async () => {
      process.env.CLI_VERSION = '0.1.0';
      process.env.SANDBOX = 'sandbox-exec';
      process.env.SEATBELT_PROFILE = 'permissive-open';
      const bugCommand = {
        urlTemplate:
          'https://custom-bug-tracker.com/new?title={title}&info={info}',
      };
      mockConfig = {
        ...mockConfig,
        getBugCommand: vi.fn(() => bugCommand),
      } as unknown as Config;
      process.env.CLI_VERSION = '0.1.0';

      const { handleSlashCommand } = getProcessor();
      const bugDescription = 'This is a custom bug';
      const info = `
*   **CLI Version:** 0.1.0
*   **Git Commit:** ${GIT_COMMIT_INFO}
*   **Operating System:** test-platform test-node-version
*   **Sandbox Environment:** sandbox-exec (permissive-open)
*   **Model Version:** test-model
*   **Memory Usage:** 11.8 MB
`;
      const expectedUrl = bugCommand.urlTemplate
        .replace('{title}', encodeURIComponent(bugDescription))
        .replace('{info}', encodeURIComponent(info));

      let commandResult: SlashCommandProcessorResult | false = false;
      await act(async () => {
        commandResult = await handleSlashCommand(`/bug ${bugDescription}`);
      });

      expect(mockAddItem).toHaveBeenCalledTimes(2);
      expect(open).toHaveBeenCalledWith(expectedUrl);
      expect(commandResult).toEqual({ type: 'handled' });
    });
  });

  describe('/quit and /exit commands', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each([['/quit'], ['/exit']])(
      'should handle %s, set quitting messages, and exit the process',
      async (command) => {
        const { handleSlashCommand } = getProcessor();
        const mockDate = new Date('2025-01-01T01:02:03.000Z');
        vi.setSystemTime(mockDate);

        await act(async () => {
          handleSlashCommand(command);
        });

        expect(mockAddItem).not.toHaveBeenCalled();
        expect(mockSetQuittingMessages).toHaveBeenCalledWith([
          {
            type: 'user',
            text: command,
            id: expect.any(Number),
          },
          {
            type: 'quit',
            duration: '1h 2m 3s',
            id: expect.any(Number),
          },
        ]);

        // Fast-forward timers to trigger process.exit
        await act(async () => {
          vi.advanceTimersByTime(100);
        });
        expect(mockProcessExit).toHaveBeenCalledWith(0);
      },
    );
  });
});
>>>>>>> 21eb44b2
