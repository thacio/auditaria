/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
  useLayoutEffect,
} from 'react';
import { type DOMElement, measureElement } from 'ink';
import { App } from './App.js';
import { AppContext } from './contexts/AppContext.js';
import { UIStateContext, type UIState } from './contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from './contexts/UIActionsContext.js';
import { ConfigContext } from './contexts/ConfigContext.js';
import {
  type HistoryItem,
  ToolCallStatus,
  type HistoryItemWithoutId,
  AuthState,
  StreamingState,
  MessageType,
} from './types.js';
import {
  type EditorType,
  type Config,
  type DetectedIde,
  type IdeContext,
  type UserTierId,
  DEFAULT_GEMINI_FLASH_MODEL,
  IdeClient,
  ideContextStore,
  getErrorMessage,
  getAllGeminiMdFilenames,
  AuthType,
  clearCachedCredentialFile,
  t,
  ShellExecutionService,
} from '@thacio/auditaria-cli-core';
import { validateAuthMethod } from '../config/auth.js';
import { loadHierarchicalGeminiMemory } from '../config/config.js';
import process from 'node:process';
import { useHistory } from './hooks/useHistoryManager.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useAuthCommand } from './auth/useAuth.js';
import { useQuotaAndFallback } from './hooks/useQuotaAndFallback.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSettingsCommand } from './hooks/useSettingsCommand.js';
import { useLanguageCommand } from './hooks/useLanguageCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useVimMode } from './contexts/VimModeContext.js';
import { useConsoleMessages } from './hooks/useConsoleMessages.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useStdin, useStdout } from 'ink';
import ansiEscapes from 'ansi-escapes';
import * as fs from 'node:fs';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { useVim } from './hooks/vim.js';
import { type LoadedSettings, SettingScope } from '../config/settings.js';
import { type InitializationResult } from '../core/initializer.js';
import { useFocus } from './hooks/useFocus.js';
import { useBracketedPaste } from './hooks/useBracketedPaste.js';
import { useKeypress, type Key } from './hooks/useKeypress.js';
import { keyMatchers, Command } from './keyMatchers.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useFolderTrust } from './hooks/useFolderTrust.js';
import { useIdeTrustListener } from './hooks/useIdeTrustListener.js';
import { type IdeIntegrationNudgeResult } from './IdeIntegrationNudge.js';
import { appEvents, AppEvent } from '../utils/events.js';
import { type UpdateObject } from './utils/updateCheck.js';
import { setUpdateHandler } from '../utils/handleAutoUpdate.js';
import { ConsolePatcher } from './utils/ConsolePatcher.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';
import { useMessageQueue } from './hooks/useMessageQueue.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useWorkspaceMigration } from './hooks/useWorkspaceMigration.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
// WEB_INTERFACE_START: Import hooks for web interface support
import { useWebInterface } from './contexts/WebInterfaceContext.js';
import { type PartListUnion } from '@google/genai';  // For multimodal support
import { useSubmitQueryRegistration } from './contexts/SubmitQueryContext.js';
import { useFooter } from './contexts/FooterContext.js';
import { useLoadingState } from './contexts/LoadingStateContext.js';
import { useToolConfirmation, type PendingToolConfirmation } from './contexts/ToolConfirmationContext.js';
import { useTerminalCapture } from './contexts/TerminalCaptureContext.js';
import { useKeypressContext } from './contexts/KeypressContext.js';
// WEB_INTERFACE_END
import type { ExtensionUpdateState } from './state/extensions.js';
import { checkForAllExtensionUpdates } from '../config/extension.js';

const CTRL_EXIT_PROMPT_DURATION_MS = 1000;

function isToolExecuting(pendingHistoryItems: HistoryItemWithoutId[]) {
  return pendingHistoryItems.some((item) => {
    if (item && item.type === 'tool_group') {
      return item.tools.some(
        (tool) => ToolCallStatus.Executing === tool.status,
      );
    }
    return false;
  });
}

interface AppContainerProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  initializationResult: InitializationResult;
}

/**
 * The fraction of the terminal width to allocate to the shell.
 * This provides horizontal padding.
 */
const SHELL_WIDTH_FRACTION = 0.89;

/**
 * The number of lines to subtract from the available terminal height
 * for the shell. This provides vertical padding and space for other UI elements.
 */
const SHELL_HEIGHT_PADDING = 10;

export const AppContainer = (props: AppContainerProps) => {
  const { settings, config, initializationResult } = props;
  const historyManager = useHistory();
  const [corgiMode, setCorgiMode] = useState(false);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const [showPrivacyNotice, setShowPrivacyNotice] = useState<boolean>(false);
  const [themeError, setThemeError] = useState<string | null>(
    initializationResult.themeError,
  );
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [shellFocused, setShellFocused] = useState(false);

  const [geminiMdFileCount, setGeminiMdFileCount] = useState<number>(
    initializationResult.geminiMdFileCount,
  );
  const [shellModeActive, setShellModeActive] = useState(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [historyRemountKey, setHistoryRemountKey] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<UpdateObject | null>(null);
  const [isTrustedFolder, setIsTrustedFolder] = useState<boolean | undefined>(
    config.isTrustedFolder(),
  );
  const [extensionsUpdateState, setExtensionsUpdateState] = useState(
    new Map<string, ExtensionUpdateState>(),
  );

  // Helper to determine the effective model, considering the fallback state.
  const getEffectiveModel = useCallback(() => {
    if (config.isInFallbackMode()) {
      return DEFAULT_GEMINI_FLASH_MODEL;
    }
    return config.getModel();
  }, [config]);

  const [currentModel, setCurrentModel] = useState(getEffectiveModel());

  const [userTier, setUserTier] = useState<UserTierId | undefined>(undefined);

  const [isConfigInitialized, setConfigInitialized] = useState(false);

  const logger = useLogger(config.storage);
  const [userMessages, setUserMessages] = useState<string[]>([]);

  // Terminal and layout hooks
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();

  // Additional hooks moved from App.tsx
  const { stats: sessionStats } = useSessionStats();
  const branchName = useGitBranchName(config.getTargetDir());

  // Layout measurements
  const mainControlsRef = useRef<DOMElement>(null);
  const staticExtraHeight = 3;

  useEffect(() => {
    (async () => {
      // Note: the program will not work if this fails so let errors be
      // handled by the global catch.
      await config.initialize();
      setConfigInitialized(true);
    })();
    registerCleanup(async () => {
      const ideClient = await IdeClient.getInstance();
      await ideClient.disconnect();
    });
  }, [config]);

  useEffect(
    () => setUpdateHandler(historyManager.addItem, setUpdateInfo),
    [historyManager.addItem],
  );

  // Watch for model changes (e.g., from Flash fallback)
  useEffect(() => {
    const checkModelChange = () => {
      const effectiveModel = getEffectiveModel();
      if (effectiveModel !== currentModel) {
        setCurrentModel(effectiveModel);
      }
    };

    checkModelChange();
    const interval = setInterval(checkModelChange, 1000); // Check every second

    return () => clearInterval(interval);
  }, [config, currentModel, getEffectiveModel]);

  const {
    consoleMessages,
    handleNewMessage,
    clearConsoleMessages: clearConsoleMessagesState,
  } = useConsoleMessages();

  useEffect(() => {
    const consolePatcher = new ConsolePatcher({
      onNewMessage: handleNewMessage,
      debugMode: config.getDebugMode(),
    });
    consolePatcher.patch();
    registerCleanup(consolePatcher.cleanup);
  }, [handleNewMessage, config]);

  const widthFraction = 0.9;
  const inputWidth = Math.max(
    20,
    Math.floor(terminalWidth * widthFraction) - 3,
  );
  const suggestionsWidth = Math.max(20, Math.floor(terminalWidth * 1.0));
  const mainAreaWidth = Math.floor(terminalWidth * 0.9);
  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);

  const isValidPath = useCallback((filePath: string): boolean => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_e) {
      return false;
    }
  }, []);

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath,
    shellModeActive,
  });

  useEffect(() => {
    const fetchUserMessages = async () => {
      const pastMessagesRaw = (await logger?.getPreviousUserMessages()) || [];
      const currentSessionUserMessages = historyManager.history
        .filter(
          (item): item is HistoryItem & { type: 'user'; text: string } =>
            item.type === 'user' &&
            typeof item.text === 'string' &&
            item.text.trim() !== '',
        )
        .map((item) => item.text)
        .reverse();
      const combinedMessages = [
        ...currentSessionUserMessages,
        ...pastMessagesRaw,
      ];
      const deduplicatedMessages: string[] = [];
      if (combinedMessages.length > 0) {
        deduplicatedMessages.push(combinedMessages[0]);
        for (let i = 1; i < combinedMessages.length; i++) {
          if (combinedMessages[i] !== combinedMessages[i - 1]) {
            deduplicatedMessages.push(combinedMessages[i]);
          }
        }
      }
      setUserMessages(deduplicatedMessages.reverse());
    };
    fetchUserMessages();
  }, [historyManager.history, logger]);

  const refreshStatic = useCallback(() => {
    stdout.write(ansiEscapes.clearTerminal);
    setHistoryRemountKey((prev) => prev + 1);
  }, [setHistoryRemountKey, stdout]);

  const {
    isThemeDialogOpen,
    openThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(
    settings,
    setThemeError,
    historyManager.addItem,
    initializationResult.themeError,
  );

  const { authState, setAuthState, authError, onAuthError } = useAuthCommand(
    settings,
    config,
  );

  const { proQuotaRequest, handleProQuotaChoice } = useQuotaAndFallback({
    config,
    historyManager,
    userTier,
    setAuthState,
    setModelSwitchedFromQuotaError,
  });

  // Derive auth state variables for backward compatibility with UIStateContext
  const isAuthDialogOpen = authState === AuthState.Updating;
  const isAuthenticating = authState === AuthState.Unauthenticated;

  // Create handleAuthSelect wrapper for backward compatibility
  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, scope: SettingScope) => {
      if (authType) {
        await clearCachedCredentialFile();
        settings.setValue(scope, 'security.auth.selectedType', authType);

        try {
          await config.refreshAuth(authType);
          setAuthState(AuthState.Authenticated);
        } catch (e) {
          onAuthError(
            `Failed to authenticate: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }

        if (
          authType === AuthType.LOGIN_WITH_GOOGLE &&
          config.isBrowserLaunchSuppressed()
        ) {
          await runExitCleanup();
          console.log(`
----------------------------------------------------------------
Logging in with Google... Please restart Gemini CLI to continue.
----------------------------------------------------------------
          `);
          process.exit(0);
        }
      }
      setAuthState(AuthState.Authenticated);
    },
    [settings, config, setAuthState, onAuthError],
  );

  // Sync user tier from config when authentication changes
  useEffect(() => {
    // Only sync when not currently authenticating
    if (authState === AuthState.Authenticated) {
      setUserTier(config.getUserTier());
    }
  }, [config, authState]);

  // Check for enforced auth type mismatch
  useEffect(() => {
    if (
      settings.merged.security?.auth?.enforcedType &&
      settings.merged.security?.auth.selectedType &&
      settings.merged.security?.auth.enforcedType !==
        settings.merged.security?.auth.selectedType
    ) {
      onAuthError(
        `Authentication is enforced to be ${settings.merged.security?.auth.enforcedType}, but you are currently using ${settings.merged.security?.auth.selectedType}.`,
      );
    } else if (
      settings.merged.security?.auth?.selectedType &&
      !settings.merged.security?.auth?.useExternal
    ) {
      const error = validateAuthMethod(
        settings.merged.security.auth.selectedType,
      );
      if (error) {
        onAuthError(error);
      }
    }
  }, [
    settings.merged.security?.auth?.selectedType,
    settings.merged.security?.auth?.enforcedType,
    settings.merged.security?.auth?.useExternal,
    onAuthError,
  ]);

  const [editorError, setEditorError] = useState<string | null>(null);
  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, historyManager.addItem);

  const [languageError, setLanguageError] = useState<string | null>(null);
  const { isLanguageDialogOpen, openLanguageDialog, handleLanguageSelect } =
    useLanguageCommand(
      settings,
      setLanguageError,
      historyManager.addItem,
      refreshStatic,
    );

  const { isSettingsDialogOpen, openSettingsDialog, closeSettingsDialog } =
    useSettingsCommand();

  const {
    showWorkspaceMigrationDialog,
    workspaceExtensions,
    onWorkspaceMigrationDialogOpen,
    onWorkspaceMigrationDialogClose,
  } = useWorkspaceMigration(settings);

  const { toggleVimEnabled } = useVimMode();

  const slashCommandActions = useMemo(
    () => ({
      openAuthDialog: () => setAuthState(AuthState.Updating),
      openThemeDialog,
      openEditorDialog,
      openLanguageDialog,
      openPrivacyNotice: () => setShowPrivacyNotice(true),
      openSettingsDialog,
      quit: (messages: HistoryItem[]) => {
        setQuittingMessages(messages);
        setTimeout(async () => {
          await runExitCleanup();
          process.exit(0);
        }, 100);
      },
      setDebugMessage,
      toggleCorgiMode: () => setCorgiMode((prev) => !prev),
      setExtensionsUpdateState,
    }),
    [
      setAuthState,
      openThemeDialog,
      openEditorDialog,
      openLanguageDialog,
      openSettingsDialog,
      setQuittingMessages,
      setDebugMessage,
      setShowPrivacyNotice,
      setCorgiMode,
      setExtensionsUpdateState,
    ],
  );

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
    shellConfirmationRequest,
    confirmationRequest,
  } = useSlashCommandProcessor(
    config,
    settings,
    historyManager.addItem,
    historyManager.clearItems,
    historyManager.loadHistory,
    refreshStatic,
    toggleVimEnabled,
    setIsProcessing,
    setGeminiMdFileCount,
    slashCommandActions,
    extensionsUpdateState,
    isConfigInitialized,
  );

  const performMemoryRefresh = useCallback(async () => {
    historyManager.addItem(
      {
        type: MessageType.INFO,
        text: t('app.memory_refreshing', 'Refreshing hierarchical memory (GEMINI.md or other context files)...'),
      },
      Date.now(),
    );
    try {
      const { memoryContent, fileCount } = await loadHierarchicalGeminiMemory(
        process.cwd(),
        settings.merged.context?.loadMemoryFromIncludeDirectories
          ? config.getWorkspaceContext().getDirectories()
          : [],
        config.getDebugMode(),
        config.getFileService(),
        settings.merged,
        config.getExtensionContextFilePaths(),
        config.isTrustedFolder(),
        settings.merged.context?.importFormat || 'tree', // Use setting or default to 'tree'
        config.getFileFilteringOptions(),
      );

      config.setUserMemory(memoryContent);
      config.setGeminiMdFileCount(fileCount);
      setGeminiMdFileCount(fileCount);

      historyManager.addItem(
        {
          type: MessageType.INFO,
          text:
            memoryContent.length > 0
              ? t(
                  'app.memory_refreshed_success',
                  'Memory refreshed successfully. Loaded {chars} characters from {count} file(s).',
                  { chars: memoryContent.length, count: fileCount }
                )
              : t('app.memory_refreshed_no_content', 'Memory refreshed successfully. No memory content found.'),
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        console.log(
          `[DEBUG] Refreshed memory content in config: ${memoryContent.substring(
            0,
            200,
          )}...`,
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      historyManager.addItem(
        {
          type: MessageType.ERROR,
          text: t('app.memory_refresh_error', 'Error refreshing memory: {error}', { error: errorMessage }),
        },
        Date.now(),
      );
      console.error('Error refreshing memory:', error);
    }
  }, [config, historyManager, settings.merged]);

  const cancelHandlerRef = useRef<() => void>(() => {});

  const {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems: pendingGeminiHistoryItems,
    thought,
    cancelOngoingRequest,
    handleApprovalModeChange,
    activePtyId,
    loopDetectionConfirmationRequest,
  } = useGeminiStream(
    config.getGeminiClient(),
    historyManager.history,
    historyManager.addItem,
    config,
    settings,
    setDebugMessage,
    handleSlashCommand,
    shellModeActive,
    () => settings.merged.general?.preferredEditor as EditorType,
    onAuthError,
    performMemoryRefresh,
    modelSwitchedFromQuotaError,
    setModelSwitchedFromQuotaError,
    refreshStatic,
    () => cancelHandlerRef.current(),
    setShellFocused,
    terminalWidth,
    terminalHeight,
    shellFocused,
  );

  // Auto-accept indicator
  const showAutoAcceptIndicator = useAutoAcceptIndicator({
    config,
    addItem: historyManager.addItem,
    onApprovalModeChange: handleApprovalModeChange,
  });

  const { messageQueue, addMessage, clearQueue, getQueuedMessagesText } =
    useMessageQueue({
      isConfigInitialized,
      streamingState,
      submitQuery,
    });

  cancelHandlerRef.current = useCallback(() => {
    const pendingHistoryItems = [
      ...pendingSlashCommandHistoryItems,
      ...pendingGeminiHistoryItems,
    ];
    if (isToolExecuting(pendingHistoryItems)) {
      buffer.setText(''); // Just clear the prompt
      return;
    }

    const lastUserMessage = userMessages.at(-1);
    let textToSet = lastUserMessage || '';

    const queuedText = getQueuedMessagesText();
    if (queuedText) {
      textToSet = textToSet ? `${textToSet}\n\n${queuedText}` : queuedText;
      clearQueue();
    }

    if (textToSet) {
      buffer.setText(textToSet);
    }
  }, [
    buffer,
    userMessages,
    getQueuedMessagesText,
    clearQueue,
    pendingSlashCommandHistoryItems,
    pendingGeminiHistoryItems,
  ]);

  const handleFinalSubmit = useCallback(
    (submittedValue: string) => {
      addMessage(submittedValue);
    },
    [addMessage],
  );

  const handleClearScreen = useCallback(() => {
    historyManager.clearItems();
    clearConsoleMessagesState();
    console.clear();
    refreshStatic();
  }, [historyManager, clearConsoleMessagesState, refreshStatic]);

  const { handleInput: vimHandleInput } = useVim(buffer, handleFinalSubmit);

  /**
   * Determines if the input prompt should be active and accept user input.
   * Input is disabled during:
   * - Initialization errors
   * - Slash command processing
   * - Tool confirmations (WaitingForConfirmation state)
   * - Any future streaming states not explicitly allowed
   */
  const isInputActive =
    !initError &&
    !isProcessing &&
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.Responding) &&
    !proQuotaRequest;

  const [controlsHeight, setControlsHeight] = useState(0);

  useLayoutEffect(() => {
    if (mainControlsRef.current) {
      const fullFooterMeasurement = measureElement(mainControlsRef.current);
      if (fullFooterMeasurement.height > 0) {
        setControlsHeight(fullFooterMeasurement.height);
      }
    }
  }, [buffer, terminalWidth, terminalHeight]);

  // Compute available terminal height based on controls measurement
  const availableTerminalHeight = Math.max(
    0,
    terminalHeight - controlsHeight - staticExtraHeight - 2,
  );

  config.setShellExecutionConfig({
    terminalWidth: Math.floor(terminalWidth * SHELL_WIDTH_FRACTION),
    terminalHeight: Math.max(
      Math.floor(availableTerminalHeight - SHELL_HEIGHT_PADDING),
      1,
    ),
    pager: settings.merged.tools?.shell?.pager,
    showColor: settings.merged.tools?.shell?.showColor,
  });

  const isFocused = useFocus();
  useBracketedPaste();

  // Context file names computation
  const contextFileNames = useMemo(() => {
    const fromSettings = settings.merged.context?.fileName;
    return fromSettings
      ? Array.isArray(fromSettings)
        ? fromSettings
        : [fromSettings]
      : getAllGeminiMdFilenames();
  }, [settings.merged.context?.fileName]);

  // IDE prompt related state (moved here for web interface dependencies)
  const [idePromptAnswered, setIdePromptAnswered] = useState(false);
  const [currentIDE, setCurrentIDE] = useState<DetectedIde | null>(null);

  useEffect(() => {
    const getIde = async () => {
      const ideClient = await IdeClient.getInstance();
      const currentIde = ideClient.getCurrentIde();
      setCurrentIDE(currentIde || null);
    };
    getIde();
  }, []);
  const shouldShowIdePrompt = Boolean(
    currentIDE &&
      !config.getIdeMode() &&
      !settings.merged.ide?.hasSeenNudge &&
      !idePromptAnswered,
  );

  // Initial prompt handling
  const initialPrompt = useMemo(() => config.getQuestion(), [config]);
  const initialPromptSubmitted = useRef(false);
  const geminiClient = config.getGeminiClient();

  useEffect(() => {
    if (activePtyId) {
      ShellExecutionService.resizePty(
        activePtyId,
        Math.floor(terminalWidth * SHELL_WIDTH_FRACTION),
        Math.max(Math.floor(availableTerminalHeight - SHELL_HEIGHT_PADDING), 1),
      );
    }
  }, [terminalWidth, availableTerminalHeight, activePtyId]);

  useEffect(() => {
    if (
      initialPrompt &&
      isConfigInitialized &&
      !initialPromptSubmitted.current &&
      !isAuthenticating &&
      !isAuthDialogOpen &&
      !isThemeDialogOpen &&
      !isEditorDialogOpen &&
      !showPrivacyNotice &&
      geminiClient?.isInitialized?.()
    ) {
      handleFinalSubmit(initialPrompt);
      initialPromptSubmitted.current = true;
    }
  }, [
    initialPrompt,
    isConfigInitialized,
    handleFinalSubmit,
    isAuthenticating,
    isAuthDialogOpen,
    isThemeDialogOpen,
    isEditorDialogOpen,
    showPrivacyNotice,
    geminiClient,
  ]);

  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showToolDescriptions, setShowToolDescriptions] =
    useState<boolean>(false);

  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [ideContextState, setIdeContextState] = useState<
    IdeContext | undefined
  >();
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [showIdeRestartPrompt, setShowIdeRestartPrompt] = useState(false);

  const { isFolderTrustDialogOpen, handleFolderTrustSelect, isRestarting } =
    useFolderTrust(settings, setIsTrustedFolder, refreshStatic);
  const { needsRestart: ideNeedsRestart } = useIdeTrustListener();
  const isInitialMount = useRef(true);

  useEffect(() => {
    if (ideNeedsRestart) {
      // IDE trust changed, force a restart.
      setShowIdeRestartPrompt(true);
    }
  }, [ideNeedsRestart]);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    const handler = setTimeout(() => {
      refreshStatic();
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [terminalWidth, refreshStatic]);

  useEffect(() => {
    const unsubscribe = ideContextStore.subscribe(setIdeContextState);
    setIdeContextState(ideContextStore.get());
    return unsubscribe;
  }, []);

  useEffect(() => {
    const openDebugConsole = () => {
      setShowErrorDetails(true);
      setConstrainHeight(false);
    };
    appEvents.on(AppEvent.OpenDebugConsole, openDebugConsole);

    const logErrorHandler = (errorMessage: unknown) => {
      handleNewMessage({
        type: 'error',
        content: String(errorMessage),
        count: 1,
      });
    };
    appEvents.on(AppEvent.LogError, logErrorHandler);

    return () => {
      appEvents.off(AppEvent.OpenDebugConsole, openDebugConsole);
      appEvents.off(AppEvent.LogError, logErrorHandler);
    };
  }, [handleNewMessage]);

  const handleEscapePromptChange = useCallback((showPrompt: boolean) => {
    setShowEscapePrompt(showPrompt);
  }, []);

  const handleIdePromptComplete = useCallback(
    (result: IdeIntegrationNudgeResult) => {
      if (result.userSelection === 'yes') {
        handleSlashCommand('/ide install');
        settings.setValue(
          SettingScope.User,
          'hasSeenIdeIntegrationNudge',
          true,
        );
      } else if (result.userSelection === 'dismiss') {
        settings.setValue(
          SettingScope.User,
          'hasSeenIdeIntegrationNudge',
          true,
        );
      }
      setIdePromptAnswered(true);
    },
    [handleSlashCommand, settings],
  );

  const { elapsedTime, currentLoadingPhrase } =
    useLoadingIndicator(streamingState);

  const handleExit = useCallback(
    (
      pressedOnce: boolean,
      setPressedOnce: (value: boolean) => void,
      timerRef: React.MutableRefObject<NodeJS.Timeout | null>,
    ) => {
      if (pressedOnce) {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        handleSlashCommand('/quit');
      } else {
        setPressedOnce(true);
        timerRef.current = setTimeout(() => {
          setPressedOnce(false);
          timerRef.current = null;
        }, CTRL_EXIT_PROMPT_DURATION_MS);
      }
    },
    [handleSlashCommand],
  );

  const handleGlobalKeypress = useCallback(
    (key: Key) => {
      // Debug log keystrokes if enabled
      if (settings.merged.general?.debugKeystrokeLogging) {
        console.log('[DEBUG] Keystroke:', JSON.stringify(key));
      }

      const anyDialogOpen =
        isThemeDialogOpen ||
        isAuthDialogOpen ||
        isEditorDialogOpen ||
        isLanguageDialogOpen ||
        isSettingsDialogOpen ||
        isFolderTrustDialogOpen ||
        showPrivacyNotice;
      if (anyDialogOpen) {
        return;
      }

      let enteringConstrainHeightMode = false;
      if (!constrainHeight) {
        enteringConstrainHeightMode = true;
        setConstrainHeight(true);
      }

      if (keyMatchers[Command.SHOW_ERROR_DETAILS](key)) {
        setShowErrorDetails((prev) => !prev);
      } else if (keyMatchers[Command.TOGGLE_TOOL_DESCRIPTIONS](key)) {
        const newValue = !showToolDescriptions;
        setShowToolDescriptions(newValue);

        const mcpServers = config.getMcpServers();
        if (Object.keys(mcpServers || {}).length > 0) {
          handleSlashCommand(newValue ? '/mcp desc' : '/mcp nodesc');
        }
      } else if (
        keyMatchers[Command.TOGGLE_IDE_CONTEXT_DETAIL](key) &&
        config.getIdeMode() &&
        ideContextState
      ) {
        handleSlashCommand('/ide status');
      } else if (keyMatchers[Command.QUIT](key)) {
        if (!ctrlCPressedOnce) {
          cancelOngoingRequest?.();
        }
        handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
      } else if (keyMatchers[Command.EXIT](key)) {
        if (buffer.text.length > 0) {
          return;
        }
        handleExit(ctrlDPressedOnce, setCtrlDPressedOnce, ctrlDTimerRef);
      } else if (
        keyMatchers[Command.SHOW_MORE_LINES](key) &&
        !enteringConstrainHeightMode
      ) {
        setConstrainHeight(false);
      } else if (keyMatchers[Command.TOGGLE_SHELL_INPUT_FOCUS](key)) {
        if (activePtyId || shellFocused) {
          setShellFocused((prev) => !prev);
        }
      }
    },
    [
      constrainHeight,
      setConstrainHeight,
      setShowErrorDetails,
      showToolDescriptions,
      setShowToolDescriptions,
      config,
      ideContextState,
      handleExit,
      ctrlCPressedOnce,
      setCtrlCPressedOnce,
      ctrlCTimerRef,
      buffer.text.length,
      ctrlDPressedOnce,
      setCtrlDPressedOnce,
      ctrlDTimerRef,
      handleSlashCommand,
      cancelOngoingRequest,
      isThemeDialogOpen,
      isAuthDialogOpen,
      isEditorDialogOpen,
      isSettingsDialogOpen,
      isFolderTrustDialogOpen,
      showPrivacyNotice,
      activePtyId,
      shellFocused,
      settings.merged.general?.debugKeystrokeLogging,
    ],
  );

  useKeypress(handleGlobalKeypress, { isActive: true });
  useKeypress(
    (key) => {
      if (key.name === 'r' || key.name === 'R') {
        process.exit(0);
      }
    },
    { isActive: showIdeRestartPrompt },
  );

  const filteredConsoleMessages = useMemo(() => {
    if (config.getDebugMode()) {
      return consoleMessages;
    }
    return consoleMessages.filter((msg) => msg.type !== 'debug');
  }, [consoleMessages, config]);

  // Computed values
  const errorCount = useMemo(
    () =>
      filteredConsoleMessages
        .filter((msg) => msg.type === 'error')
        .reduce((total, msg) => total + msg.count, 0),
    [filteredConsoleMessages],
  );

  const nightly = props.version.includes('nightly');

  const dialogsVisible = useMemo(
    () =>
      showWorkspaceMigrationDialog ||
      shouldShowIdePrompt ||
      isFolderTrustDialogOpen ||
      !!shellConfirmationRequest ||
      !!confirmationRequest ||
      !!loopDetectionConfirmationRequest ||
      isThemeDialogOpen ||
      isSettingsDialogOpen ||
      isAuthenticating ||
      isAuthDialogOpen ||
      isEditorDialogOpen ||
      isLanguageDialogOpen ||
      showPrivacyNotice ||
      !!proQuotaRequest,
    [
      showWorkspaceMigrationDialog,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen,
      shellConfirmationRequest,
      confirmationRequest,
      loopDetectionConfirmationRequest,
      isThemeDialogOpen,
      isSettingsDialogOpen,
      isAuthenticating,
      isAuthDialogOpen,
      isEditorDialogOpen,
      isLanguageDialogOpen,
      showPrivacyNotice,
      proQuotaRequest,
    ],
  );

  const pendingHistoryItems = useMemo(
    () => [...pendingSlashCommandHistoryItems, ...pendingGeminiHistoryItems],
    [pendingSlashCommandHistoryItems, pendingGeminiHistoryItems],
  );

  // WEB_INTERFACE_START: Web interface integration - submitQuery registration and abort handler
  const webInterface = useWebInterface();

  // Store current submitQuery in ref for web interface
  const submitQueryRef = useRef(submitQuery);
  useEffect(() => {
    submitQueryRef.current = submitQuery;
  }, [submitQuery]);

  // Create a completely stable function that will never change
  const stableWebSubmitQuery = useCallback((query: PartListUnion) => {
    if (submitQueryRef.current) {
      submitQueryRef.current(query);
    }
  }, []); // Empty dependency array - this function never changes

  // Register once and never again
  const registerSubmitQuery = useSubmitQueryRegistration();
  const submitQueryRegisteredRef = useRef(false);
  useEffect(() => {
    if (!submitQueryRegisteredRef.current) {
      registerSubmitQuery(stableWebSubmitQuery);
      submitQueryRegisteredRef.current = true;
    }
  }, []); // Empty dependency array - only run once

  // Register abort handler with web interface service
  useEffect(() => {
    if (webInterface?.service && cancelOngoingRequest) {
      webInterface.service.setAbortHandler(cancelOngoingRequest);
    }
  }, [webInterface?.service, cancelOngoingRequest]);

  // Register with web interface service once
  const submitHandlerRegistered = useRef(false);
  useEffect(() => {
    const register = () => {
      if (webInterface?.service && !submitHandlerRegistered.current) {
        webInterface.service.setSubmitQueryHandler(stableWebSubmitQuery);
        submitHandlerRegistered.current = true;
      }
    };

    register();
    const timeout = setTimeout(register, 100);
    return () => clearTimeout(timeout);
  }, []); // Empty dependency array - only register once

  // Terminal capture for interactive screens
  const terminalCapture = useTerminalCapture();
  const { subscribe: subscribeToKeypress } = useKeypressContext();

  // Create a function to pre-start capture for dialogs that render immediately
  const preStartTerminalCapture = useCallback(() => {
    // Start capture immediately to catch the initial render
    terminalCapture.setInteractiveScreenActive(true);
  }, [terminalCapture]);

  // Expose the pre-start function globally for the slash command processor
  useEffect(() => {
    if (webInterface?.service) {
      (global as any).__preStartTerminalCapture = preStartTerminalCapture;
    }
    return () => {
      delete (global as any).__preStartTerminalCapture;
    };
  }, [preStartTerminalCapture, webInterface]);

  // Detect when any interactive screen is shown
  const isAnyInteractiveScreenOpen =
    authState === AuthState.Updating ||
    authState === AuthState.Unauthenticated ||
    isThemeDialogOpen ||
    isEditorDialogOpen ||
    isLanguageDialogOpen ||
    isSettingsDialogOpen ||
    showPrivacyNotice ||
    shouldShowIdePrompt ||
    isFolderTrustDialogOpen ||
    !!proQuotaRequest ||
    !!shellConfirmationRequest ||
    !!confirmationRequest ||
    !!loopDetectionConfirmationRequest;

  // Start/stop terminal capture when interactive screens change
  useEffect(() => {
    if (isAnyInteractiveScreenOpen) {
      terminalCapture.setInteractiveScreenActive(true);
    } else {
      const timer = setTimeout(() => {
        terminalCapture.setInteractiveScreenActive(false);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isAnyInteractiveScreenOpen, terminalCapture]);

  // Handle keyboard input from web interface
  useEffect(() => {
    if (!webInterface?.service) return;

    const handleTerminalInput = (keyData: any) => {
      // Create a synthetic key event that matches the Ink key format
      const syntheticKey = {
        name: keyData.name,
        sequence: keyData.sequence,
        ctrl: keyData.ctrl || false,
        meta: keyData.meta || false,
        shift: keyData.shift || false,
        alt: keyData.alt || false,
        raw: keyData.sequence || '',
      };

      // Emit synthetic keypress event to all listeners
      if (isAnyInteractiveScreenOpen) {
        // Fix for VSCode terminal ESC key handling
        process.stdin.emit('keypress', syntheticKey.sequence, syntheticKey);
      }
    };

    // Listen for terminal input events from web interface
    webInterface.service.on('terminal_input', handleTerminalInput);

    return () => {
      webInterface?.service?.off('terminal_input', handleTerminalInput);
    };
  }, [webInterface?.service, isAnyInteractiveScreenOpen]);

  // Web interface broadcasting - footer, loading state, commands, MCP servers, console messages, CLI action required, startup message, and tool confirmations
  const footerContext = useFooter();
  useEffect(() => {
    if (footerContext?.footerData && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastFooterData(footerContext.footerData);
    }
  }, [footerContext?.footerData, webInterface?.service, webInterface?.isRunning]);

  const loadingStateContext = useLoadingState();
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastLoadingState({
        isLoading: streamingState === StreamingState.Responding || isProcessing,
        streamingState,
        elapsedTime,
        currentLoadingPhrase,
        thought: typeof thought === 'string' ? thought : (thought?.subject || null),
        thoughtObject: typeof thought === 'object' && thought !== null ? thought : null,
      });
    }
  }, [webInterface?.service, webInterface?.isRunning, streamingState, elapsedTime, currentLoadingPhrase, isProcessing, thought]);

  // Broadcast slash commands
  useEffect(() => {
    if (slashCommands && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastSlashCommands(slashCommands);
    }
  }, [slashCommands, webInterface?.service, webInterface?.isRunning]);

  // Broadcast MCP servers when they change
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      const mcpServers = config.getMcpServers();
      if (mcpServers) {
        // For now, pass empty arrays/maps for the additional parameters
        // These would need to be obtained from the actual MCP system
        const blockedServers: Array<{ name: string; extensionName: string }> = [];
        const serverTools = new Map<string, any[]>();
        const serverStatuses = new Map<string, string>();

        // Set all servers as connected for now
        Object.keys(mcpServers).forEach(name => {
          serverStatuses.set(name, 'connected');
          serverTools.set(name, []);
        });

        webInterface.service.broadcastMCPServers(mcpServers, blockedServers, serverTools, serverStatuses);
      }
    }
  }, [config, webInterface?.service, webInterface?.isRunning]);

  // Broadcast console messages
  useEffect(() => {
    if (filteredConsoleMessages && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastConsoleMessages(filteredConsoleMessages);
    }
  }, [filteredConsoleMessages, webInterface?.service, webInterface?.isRunning]);

  // Broadcast CLI action required messages for different dialogs
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      let message = '';
      let title = t('web.cli_action.title', 'CLI Action Required');
      let reason = 'general';

      if (shouldShowIdePrompt) {
        message = t('web.cli_action.ide_integration', 'IDE integration prompt is displayed. Please respond to connect your editor to Auditaria CLI in the terminal.');
        reason = 'ide_integration';
      } else if (isAuthenticating || isAuthDialogOpen) {
        const authMessageKey = isAuthenticating ? 'web.cli_action.auth_in_progress' : 'web.cli_action.auth_required';
        const authMessageFallback = isAuthenticating
          ? 'Authentication is in progress. Please check the CLI terminal.'
          : 'Authentication is required. Please complete the authentication process in the CLI terminal.';
        message = t(authMessageKey, authMessageFallback);
        reason = 'authentication';
      } else if (isThemeDialogOpen) {
        message = t('web.cli_action.theme_selection', 'Theme selection is open. Please choose a theme in the CLI terminal.');
        reason = 'theme_selection';
      } else if (isEditorDialogOpen) {
        message = t('web.cli_action.editor_settings', 'Editor settings are open. Please configure your editor in the CLI terminal.');
        reason = 'editor_settings';
      } else if (isLanguageDialogOpen) {
        message = t('web.cli_action.language_selection', 'Language selection is open. Please choose a language in the CLI terminal.');
        reason = 'language_selection';
      } else if (isSettingsDialogOpen) {
        message = t('web.cli_action.settings', 'Settings dialog is open. Please configure settings in the CLI terminal.');
        reason = 'settings';
      } else if (isFolderTrustDialogOpen) {
        message = t('web.cli_action.folder_trust', 'Folder trust dialog is open. Please respond in the CLI terminal.');
        reason = 'folder_trust';
      } else if (showPrivacyNotice) {
        message = t('web.cli_action.privacy_notice', 'Privacy notice is displayed. Please review in the CLI terminal.');
        reason = 'privacy_notice';
      } else if (proQuotaRequest) {
        message = t('web.cli_action.quota_exceeded', 'Quota exceeded dialog is open. Please choose an option in the CLI terminal.');
        reason = 'quota_exceeded';
      } else if (shellConfirmationRequest) {
        message = t('web.cli_action.shell_confirmation', 'Shell command confirmation required. Please respond in the CLI terminal.');
        reason = 'shell_confirmation';
      } else if (confirmationRequest) {
        message = t('web.cli_action.confirmation', 'Confirmation required. Please respond in the CLI terminal.');
        reason = 'confirmation';
      } else if (loopDetectionConfirmationRequest) {
        message = t('web.cli_action.loop_detection', 'Loop detection confirmation required. Please choose whether to keep or disable loop detection in the CLI terminal.');
        reason = 'loop_detection';
      }

      if (message) {
        webInterface.service.broadcastCliActionRequired(true, reason, title, message);
      } else {
        webInterface.service.broadcastCliActionRequired(false);
      }
    }
  }, [
    webInterface?.service,
    webInterface?.isRunning,
    shouldShowIdePrompt,
    isAuthenticating,
    isAuthDialogOpen,
    isThemeDialogOpen,
    isEditorDialogOpen,
    isLanguageDialogOpen,
    isSettingsDialogOpen,
    isFolderTrustDialogOpen,
    showPrivacyNotice,
    proQuotaRequest,
    shellConfirmationRequest,
    confirmationRequest,
    loopDetectionConfirmationRequest,
  ]);

  // Broadcast startup message once
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning && initializationResult.geminiMdFileCount) {
      const startupMessage = t('web.startup_message', 'Auditaria CLI is ready. Loaded {count} context file(s).', {
        count: initializationResult.geminiMdFileCount,
      });
      // Use a generic broadcast since there's no specific setStartupMessage method
      webInterface.service.broadcastMessage({
        id: Date.now(),
        type: 'info',
        text: startupMessage,
      } as HistoryItem);
    }
  }, [webInterface?.service, webInterface?.isRunning, initializationResult.geminiMdFileCount]);

  // Tool confirmation broadcasting
  const toolConfirmationContext = useToolConfirmation();
  useEffect(() => {
    const pendingConfirmation = toolConfirmationContext?.pendingConfirmations?.[0];
    if (pendingConfirmation && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastToolConfirmation(pendingConfirmation);
    }
  }, [toolConfirmationContext?.pendingConfirmations, webInterface?.service, webInterface?.isRunning]);

  // Broadcast history updates
  useEffect(() => {
    if (historyManager.history && webInterface?.service) {
      webInterface.service.setCurrentHistory(historyManager.history);
    }
  }, [historyManager.history, webInterface?.service]);

  // Broadcast pending items
  const pendingItem = pendingHistoryItems.length > 0 ? pendingHistoryItems[0] as HistoryItem : null;
  useEffect(() => {
    if (webInterface?.service) {
      webInterface.service.broadcastPendingItem(pendingItem);
    }
  }, [pendingItem, webInterface?.service]);
  // WEB_INTERFACE_END

  const uiState: UIState = useMemo(
    () => ({
      history: historyManager.history,
      isThemeDialogOpen,
      themeError,
      isAuthenticating,
      isConfigInitialized,
      authError,
      isAuthDialogOpen,
      editorError,
      isEditorDialogOpen,
      languageError,
      isLanguageDialogOpen,
      showPrivacyNotice,
      corgiMode,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      shellConfirmationRequest,
      confirmationRequest,
      loopDetectionConfirmationRequest,
      geminiMdFileCount,
      streamingState,
      initError,
      pendingGeminiHistoryItems,
      thought,
      shellModeActive,
      userMessages,
      buffer,
      inputWidth,
      suggestionsWidth,
      isInputActive,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen: isFolderTrustDialogOpen ?? false,
      isTrustedFolder,
      constrainHeight,
      showErrorDetails,
      filteredConsoleMessages,
      ideContextState,
      showToolDescriptions,
      ctrlCPressedOnce,
      ctrlDPressedOnce,
      showEscapePrompt,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      messageQueue,
      showAutoAcceptIndicator,
      showWorkspaceMigrationDialog,
      workspaceExtensions,
      currentModel,
      userTier,
      proQuotaRequest,
      contextFileNames,
      errorCount,
      availableTerminalHeight,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      staticExtraHeight,
      dialogsVisible,
      pendingHistoryItems,
      nightly,
      branchName,
      sessionStats,
      terminalWidth,
      terminalHeight,
      mainControlsRef,
      currentIDE,
      updateInfo,
      showIdeRestartPrompt,
      isRestarting,
      extensionsUpdateState,
      activePtyId,
      shellFocused,
    }),
    [
      historyManager.history,
      isThemeDialogOpen,
      themeError,
      isAuthenticating,
      isConfigInitialized,
      authError,
      isAuthDialogOpen,
      editorError,
      isEditorDialogOpen,
      languageError,
      isLanguageDialogOpen,
      showPrivacyNotice,
      corgiMode,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      shellConfirmationRequest,
      confirmationRequest,
      loopDetectionConfirmationRequest,
      geminiMdFileCount,
      streamingState,
      initError,
      pendingGeminiHistoryItems,
      thought,
      shellModeActive,
      userMessages,
      buffer,
      inputWidth,
      suggestionsWidth,
      isInputActive,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen,
      isTrustedFolder,
      constrainHeight,
      showErrorDetails,
      filteredConsoleMessages,
      ideContextState,
      showToolDescriptions,
      ctrlCPressedOnce,
      ctrlDPressedOnce,
      showEscapePrompt,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      messageQueue,
      showAutoAcceptIndicator,
      showWorkspaceMigrationDialog,
      workspaceExtensions,
      userTier,
      proQuotaRequest,
      contextFileNames,
      errorCount,
      availableTerminalHeight,
      mainAreaWidth,
      staticAreaMaxItemHeight,
      staticExtraHeight,
      dialogsVisible,
      pendingHistoryItems,
      nightly,
      branchName,
      sessionStats,
      terminalWidth,
      terminalHeight,
      mainControlsRef,
      currentIDE,
      updateInfo,
      showIdeRestartPrompt,
      isRestarting,
      currentModel,
      extensionsUpdateState,
      activePtyId,
      shellFocused,
    ],
  );

  const uiActions: UIActions = useMemo(
    () => ({
      handleThemeSelect,
      handleThemeHighlight,
      handleAuthSelect,
      setAuthState,
      onAuthError,
      handleEditorSelect,
      exitEditorDialog,
      handleLanguageSelect,
      exitPrivacyNotice: () => setShowPrivacyNotice(false),
      closeSettingsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleFolderTrustSelect,
      setConstrainHeight,
      onEscapePromptChange: handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      handleClearScreen,
      onWorkspaceMigrationDialogOpen,
      onWorkspaceMigrationDialogClose,
      handleProQuotaChoice,
    }),
    [
      handleThemeSelect,
      handleThemeHighlight,
      handleAuthSelect,
      setAuthState,
      onAuthError,
      handleEditorSelect,
      exitEditorDialog,
      handleLanguageSelect,
      closeSettingsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleFolderTrustSelect,
      setConstrainHeight,
      handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      handleClearScreen,
      onWorkspaceMigrationDialogOpen,
      onWorkspaceMigrationDialogClose,
      handleProQuotaChoice,
    ],
  );

  const extensions = config.getExtensions();
  useEffect(() => {
    checkForAllExtensionUpdates(extensions, setExtensionsUpdateState);
  }, [extensions, setExtensionsUpdateState]);

  return (
    <UIStateContext.Provider value={uiState}>
      <UIActionsContext.Provider value={uiActions}>
        <ConfigContext.Provider value={config}>
          <AppContext.Provider
            value={{
              version: props.version,
              startupWarnings: props.startupWarnings || [],
            }}
          >
            <App />
          </AppContext.Provider>
        </ConfigContext.Provider>
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
};
