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
  type IdeInfo,
  type IdeContext,
  type UserTierId,
  type UserFeedbackPayload,
  DEFAULT_GEMINI_FLASH_MODEL,
  IdeClient,
  ideContextStore,
  getErrorMessage,
  getAllGeminiMdFilenames,
  AuthType,
  clearCachedCredentialFile,
  type ResumedSessionData,
  recordExitFail,
  ShellExecutionService,
  saveApiKey,
  debugLogger,
  DiscoveredMCPTool, // AUDITARIA_WEB_INTERFACE
  getMCPServerStatus, // AUDITARIA_WEB_INTERFACE
  MCPServerStatus, // AUDITARIA_WEB_INTERFACE
  coreEvents,
  CoreEvent,
  refreshServerHierarchicalMemory,
  type ModelChangedPayload,
  type MemoryChangedPayload,
  writeToStdout,
  disableMouseEvents,
  enterAlternateScreen,
  enableMouseEvents,
  disableLineWrapping,
  shouldEnterAlternateScreen,
  startupProfiler,
} from '@google/gemini-cli-core';
import { validateAuthMethod } from '../config/auth.js';
import process from 'node:process';
import { useHistory } from './hooks/useHistoryManager.js';
import { useMemoryMonitor } from './hooks/useMemoryMonitor.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useAuthCommand } from './auth/useAuth.js';
import { useQuotaAndFallback } from './hooks/useQuotaAndFallback.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useSettingsCommand } from './hooks/useSettingsCommand.js';
import { useLanguageCommand } from './hooks/useLanguageCommand.js';
import { useModelCommand } from './hooks/useModelCommand.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useVimMode } from './contexts/VimModeContext.js';
import { useConsoleMessages } from './hooks/useConsoleMessages.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { calculatePromptWidths } from './components/InputPrompt.js';
import { useApp, useStdout, useStdin } from 'ink';
import { calculateMainAreaWidth } from './utils/ui-sizing.js';
import ansiEscapes from 'ansi-escapes';
import * as fs from 'node:fs';
import { basename } from 'node:path';
import { computeWindowTitle } from '../utils/windowTitle.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { useVim } from './hooks/vim.js';
import { type LoadableSettingScope, SettingScope } from '../config/settings.js';
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
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';
import { RELAUNCH_EXIT_CODE } from '../utils/processUtils.js';
import type { SessionInfo } from '../utils/sessionUtils.js';
import { useMessageQueue } from './hooks/useMessageQueue.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useSessionStats } from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
// WEB_INTERFACE_START: Import hooks for web interface support
import { useWebInterface } from './contexts/WebInterfaceContext.js';
import { type PartListUnion } from '@google/genai'; // For multimodal support
import { useSubmitQueryRegistration } from './contexts/SubmitQueryContext.js';
import { useFooter } from './contexts/FooterContext.js';
import { useLoadingState } from './contexts/LoadingStateContext.js';
import { useToolConfirmation } from './contexts/ToolConfirmationContext.js';
import { useTerminalCapture } from './contexts/TerminalCaptureContext.js';
import { useKeypressContext } from './contexts/KeypressContext.js';
// WEB_INTERFACE_END
import {
  useConfirmUpdateRequests,
  useExtensionUpdates,
} from './hooks/useExtensionUpdates.js';
import { ShellFocusContext } from './contexts/ShellFocusContext.js';
import { type ExtensionManager } from '../config/extension-manager.js';
import { requestConsentInteractive } from '../config/extensions/consent.js';
import { useSessionBrowser } from './hooks/useSessionBrowser.js';
import { useSessionResume } from './hooks/useSessionResume.js';
import { useIncludeDirsTrust } from './hooks/useIncludeDirsTrust.js';
import { isWorkspaceTrusted } from '../config/trustedFolders.js';
import { useAlternateBuffer } from './hooks/useAlternateBuffer.js';
import { useSettings } from './contexts/SettingsContext.js';
import { enableSupportedProtocol } from './utils/kittyProtocolDetector.js';
import { useInputHistoryStore } from './hooks/useInputHistoryStore.js';
import { enableBracketedPaste } from './utils/bracketedPaste.js';

const WARNING_PROMPT_DURATION_MS = 1000;
const QUEUE_ERROR_DISPLAY_DURATION_MS = 3000;

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
  startupWarnings?: string[];
  version: string;
  initializationResult: InitializationResult;
  resumedSessionData?: ResumedSessionData;
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
  const { config, initializationResult, resumedSessionData } = props;
  const historyManager = useHistory({
    chatRecordingService: config.getGeminiClient()?.getChatRecordingService(),
  });
  useMemoryMonitor(historyManager);
  const settings = useSettings();
  const isAlternateBuffer = useAlternateBuffer();
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
  const [embeddedShellFocused, setEmbeddedShellFocused] = useState(false);
  const [showDebugProfiler, setShowDebugProfiler] = useState(false);
  const [customDialog, setCustomDialog] = useState<React.ReactNode | null>(
    null,
  );
  const [copyModeEnabled, setCopyModeEnabled] = useState(false);
  const [pendingRestorePrompt, setPendingRestorePrompt] = useState(false);

  const [shellModeActive, setShellModeActive] = useState(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [historyRemountKey, setHistoryRemountKey] = useState(0);
  const [mcpClientUpdateCounter, setMcpClientUpdateCounter] = useState(0); // WEB_INTERFACE_START: Track MCP client updates for web sync
  const [updateInfo, setUpdateInfo] = useState<UpdateObject | null>(null);
  const [isTrustedFolder, setIsTrustedFolder] = useState<boolean | undefined>(
    isWorkspaceTrusted(settings.merged).isTrusted,
  );

  const [queueErrorMessage, setQueueErrorMessage] = useState<string | null>(
    null,
  );

  const [defaultBannerText, setDefaultBannerText] = useState('');
  const [warningBannerText, setWarningBannerText] = useState('');
  const [bannerVisible, setBannerVisible] = useState(true);

  const extensionManager = config.getExtensionLoader() as ExtensionManager;
  // We are in the interactive CLI, update how we request consent and settings.
  extensionManager.setRequestConsent((description) =>
    requestConsentInteractive(description, addConfirmUpdateExtensionRequest),
  );
  extensionManager.setRequestSetting();

  const { addConfirmUpdateExtensionRequest, confirmUpdateExtensionRequests } =
    useConfirmUpdateRequests();
  const {
    extensionsUpdateState,
    extensionsUpdateStateInternal,
    dispatchExtensionStateUpdate,
  } = useExtensionUpdates(
    extensionManager,
    historyManager.addItem,
    config.getEnableExtensionReloading(),
  );

  const [isPermissionsDialogOpen, setPermissionsDialogOpen] = useState(false);
  const [permissionsDialogProps, setPermissionsDialogProps] = useState<{
    targetDirectory?: string;
  } | null>(null);
  const openPermissionsDialog = useCallback(
    (props?: { targetDirectory?: string }) => {
      setPermissionsDialogOpen(true);
      setPermissionsDialogProps(props ?? null);
    },
    [],
  );
  const closePermissionsDialog = useCallback(() => {
    setPermissionsDialogOpen(false);
    setPermissionsDialogProps(null);
  }, []);

  const toggleDebugProfiler = useCallback(
    () => setShowDebugProfiler((prev) => !prev),
    [],
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
  const { inputHistory, addInput, initializeFromLogger } =
    useInputHistoryStore();

  // Terminal and layout hooks
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const app = useApp();

  // Additional hooks moved from App.tsx
  const { stats: sessionStats } = useSessionStats();
  const branchName = useGitBranchName(config.getTargetDir());

  // Layout measurements
  const mainControlsRef = useRef<DOMElement>(null);
  // For performance profiling only
  const rootUiRef = useRef<DOMElement>(null);
  const originalTitleRef = useRef(
    computeWindowTitle(basename(config.getTargetDir())),
  );
  const lastTitleRef = useRef<string | null>(null);
  const staticExtraHeight = 3;

  useEffect(() => {
    (async () => {
      // Note: the program will not work if this fails so let errors be
      // handled by the global catch.
      await config.initialize();
      setConfigInitialized(true);
      startupProfiler.flush(config);
    })();
    registerCleanup(async () => {
      // Turn off mouse scroll.
      disableMouseEvents();
      const ideClient = await IdeClient.getInstance();
      await ideClient.disconnect();
    });
  }, [config]);

  useEffect(
    () => setUpdateHandler(historyManager.addItem, setUpdateInfo),
    [historyManager.addItem],
  );

  // Subscribe to fallback mode and model changes from core
  useEffect(() => {
    const handleFallbackModeChanged = () => {
      const effectiveModel = getEffectiveModel();
      setCurrentModel(effectiveModel);
    };

    const handleModelChanged = (payload: ModelChangedPayload) => {
      setCurrentModel(payload.model);
    };

    coreEvents.on(CoreEvent.FallbackModeChanged, handleFallbackModeChanged);
    coreEvents.on(CoreEvent.ModelChanged, handleModelChanged);
    return () => {
      coreEvents.off(CoreEvent.FallbackModeChanged, handleFallbackModeChanged);
      coreEvents.off(CoreEvent.ModelChanged, handleModelChanged);
    };
  }, [getEffectiveModel]);

  const { consoleMessages, clearConsoleMessages: clearConsoleMessagesState } =
    useConsoleMessages();

  const mainAreaWidth = calculateMainAreaWidth(terminalWidth, settings);
  // Derive widths for InputPrompt using shared helper
  const { inputWidth, suggestionsWidth } = useMemo(() => {
    const { inputWidth, suggestionsWidth } =
      calculatePromptWidths(mainAreaWidth);
    return { inputWidth, suggestionsWidth };
  }, [mainAreaWidth]);

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

  // Initialize input history from logger (past sessions)
  useEffect(() => {
    initializeFromLogger(logger);
  }, [logger, initializeFromLogger]);

  const refreshStatic = useCallback(() => {
    if (!isAlternateBuffer) {
      stdout.write(ansiEscapes.clearTerminal);
    }
    setHistoryRemountKey((prev) => prev + 1);
  }, [setHistoryRemountKey, isAlternateBuffer, stdout]);
  const handleEditorClose = useCallback(() => {
    if (
      shouldEnterAlternateScreen(isAlternateBuffer, config.getScreenReader())
    ) {
      // The editor may have exited alternate buffer mode so we need to
      // enter it again to be safe.
      enterAlternateScreen();
      enableMouseEvents();
      disableLineWrapping();
      app.rerender();
    }
    enableBracketedPaste();
    enableSupportedProtocol();
    refreshStatic();
  }, [refreshStatic, isAlternateBuffer, app, config]);

  useEffect(() => {
    coreEvents.on(CoreEvent.ExternalEditorClosed, handleEditorClose);
    return () => {
      coreEvents.off(CoreEvent.ExternalEditorClosed, handleEditorClose);
    };
  }, [handleEditorClose]);

  const {
    isThemeDialogOpen,
    openThemeDialog,
    closeThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(
    settings,
    setThemeError,
    historyManager.addItem,
    initializationResult.themeError,
  );

  const {
    authState,
    setAuthState,
    authError,
    onAuthError,
    apiKeyDefaultValue,
    reloadApiKey,
  } = useAuthCommand(settings, config);

  const { proQuotaRequest, handleProQuotaChoice } = useQuotaAndFallback({
    config,
    historyManager,
    userTier,
    setModelSwitchedFromQuotaError,
  });

  // Derive auth state variables for backward compatibility with UIStateContext
  const isAuthDialogOpen = authState === AuthState.Updating;
  const isAuthenticating = authState === AuthState.Unauthenticated;

  // Session browser and resume functionality
  const isGeminiClientInitialized = config.getGeminiClient()?.isInitialized();

  const { loadHistoryForResume } = useSessionResume({
    config,
    historyManager,
    refreshStatic,
    isGeminiClientInitialized,
    setQuittingMessages,
    resumedSessionData,
    isAuthenticating,
  });
  const {
    isSessionBrowserOpen,
    openSessionBrowser,
    closeSessionBrowser,
    handleResumeSession,
    handleDeleteSession: handleDeleteSessionSync,
  } = useSessionBrowser(config, loadHistoryForResume);
  // Wrap handleDeleteSession to return a Promise for UIActions interface
  const handleDeleteSession = useCallback(
    async (session: SessionInfo): Promise<void> => {
      handleDeleteSessionSync(session);
    },
    [handleDeleteSessionSync],
  );

  // Create handleAuthSelect wrapper for backward compatibility
  const handleAuthSelect = useCallback(
    async (authType: AuthType | undefined, scope: LoadableSettingScope) => {
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
          writeToStdout(`
----------------------------------------------------------------
Logging in with Google... Restarting Gemini CLI to continue.
----------------------------------------------------------------
          `);
          process.exit(RELAUNCH_EXIT_CODE);
        }
      }
      setAuthState(AuthState.Authenticated);
    },
    [settings, config, setAuthState, onAuthError],
  );

  const handleApiKeySubmit = useCallback(
    async (apiKey: string) => {
      try {
        onAuthError(null);
        if (!apiKey.trim() && apiKey.length > 1) {
          onAuthError(
            'API key cannot be empty string with length greater than 1.',
          );
          return;
        }

        await saveApiKey(apiKey);
        await reloadApiKey();
        await config.refreshAuth(AuthType.USE_GEMINI);
        setAuthState(AuthState.Authenticated);
      } catch (e) {
        onAuthError(
          `Failed to save API key: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [setAuthState, onAuthError, reloadApiKey, config],
  );

  const handleApiKeyCancel = useCallback(() => {
    // Go back to auth method selection
    setAuthState(AuthState.Updating);
  }, [setAuthState]);

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

  const { isModelDialogOpen, openModelDialog, closeModelDialog } =
    useModelCommand();

  const { toggleVimEnabled } = useVimMode();

  const slashCommandActions = useMemo(
    () => ({
      openAuthDialog: () => setAuthState(AuthState.Updating),
      openThemeDialog,
      openEditorDialog,
      openLanguageDialog,
      openPrivacyNotice: () => setShowPrivacyNotice(true),
      openSettingsDialog,
      openSessionBrowser,
      openModelDialog,
      openPermissionsDialog,
      quit: (messages: HistoryItem[]) => {
        setQuittingMessages(messages);
        setTimeout(async () => {
          await runExitCleanup();
          process.exit(0);
        }, 100);
      },
      setDebugMessage,
      toggleCorgiMode: () => setCorgiMode((prev) => !prev),
      toggleDebugProfiler,
      dispatchExtensionStateUpdate,
      addConfirmUpdateExtensionRequest,
    }),
    [
      setAuthState,
      openThemeDialog,
      openEditorDialog,
      openLanguageDialog,
      openSettingsDialog,
      openSessionBrowser,
      openModelDialog,
      setQuittingMessages,
      setDebugMessage,
      setShowPrivacyNotice,
      setCorgiMode,
      dispatchExtensionStateUpdate,
      openPermissionsDialog,
      addConfirmUpdateExtensionRequest,
      toggleDebugProfiler,
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
    slashCommandActions,
    extensionsUpdateStateInternal,
    isConfigInitialized,
    setBannerVisible,
    setCustomDialog,
  );

  const performMemoryRefresh = useCallback(async () => {
    historyManager.addItem(
      {
        type: MessageType.INFO,
        text: 'Refreshing hierarchical memory (GEMINI.md or other context files)...',
      },
      Date.now(),
    );
    try {
      const { memoryContent, fileCount } =
        await refreshServerHierarchicalMemory(config);

      historyManager.addItem(
        {
          type: MessageType.INFO,
          text: `Memory refreshed successfully. ${
            memoryContent.length > 0
              ? `Loaded ${memoryContent.length} characters from ${fileCount} file(s).`
              : 'No memory content found.'
          }`,
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        debugLogger.log(
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
          text: `Error refreshing memory: ${errorMessage}`,
        },
        Date.now(),
      );
      debugLogger.warn('Error refreshing memory:', error);
    }
  }, [config, historyManager]);

  const cancelHandlerRef = useRef<(shouldRestorePrompt?: boolean) => void>(
    () => {},
  );

  const getPreferredEditor = useCallback(
    () => settings.merged.general?.preferredEditor as EditorType,
    [settings.merged.general?.preferredEditor],
  );

  const onCancelSubmit = useCallback((shouldRestorePrompt?: boolean) => {
    if (shouldRestorePrompt) {
      setPendingRestorePrompt(true);
    } else {
      setPendingRestorePrompt(false);
      cancelHandlerRef.current(false);
    }
  }, []);

  useEffect(() => {
    if (pendingRestorePrompt) {
      const lastHistoryUserMsg = historyManager.history.findLast(
        (h) => h.type === 'user',
      );
      const lastUserMsg = inputHistory.at(-1);

      if (
        !lastHistoryUserMsg ||
        (typeof lastHistoryUserMsg.text === 'string' &&
          lastHistoryUserMsg.text === lastUserMsg)
      ) {
        cancelHandlerRef.current(true);
        setPendingRestorePrompt(false);
      }
    }
  }, [pendingRestorePrompt, inputHistory, historyManager.history]);

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
    lastOutputTime,
  } = useGeminiStream(
    config.getGeminiClient(),
    historyManager.history,
    historyManager.addItem,
    config,
    settings,
    setDebugMessage,
    handleSlashCommand,
    shellModeActive,
    getPreferredEditor,
    onAuthError,
    performMemoryRefresh,
    modelSwitchedFromQuotaError,
    setModelSwitchedFromQuotaError,
    onCancelSubmit,
    setEmbeddedShellFocused,
    terminalWidth,
    terminalHeight,
    embeddedShellFocused,
  );

  // Auto-accept indicator
  const showAutoAcceptIndicator = useAutoAcceptIndicator({
    config,
    addItem: historyManager.addItem,
    onApprovalModeChange: handleApprovalModeChange,
  });

  const {
    messageQueue,
    addMessage,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
  } = useMessageQueue({
    isConfigInitialized,
    streamingState,
    submitQuery,
  });

  cancelHandlerRef.current = useCallback(
    (shouldRestorePrompt: boolean = true) => {
      const pendingHistoryItems = [
        ...pendingSlashCommandHistoryItems,
        ...pendingGeminiHistoryItems,
      ];
      if (isToolExecuting(pendingHistoryItems)) {
        buffer.setText(''); // Just clear the prompt
        return;
      }

      const lastUserMessage = inputHistory.at(-1);
      let textToSet = shouldRestorePrompt ? lastUserMessage || '' : '';

      const queuedText = getQueuedMessagesText();
      if (queuedText) {
        textToSet = textToSet ? `${textToSet}\n\n${queuedText}` : queuedText;
        clearQueue();
      }

      if (textToSet || !shouldRestorePrompt) {
        buffer.setText(textToSet);
      }
    },
    [
      buffer,
      inputHistory,
      getQueuedMessagesText,
      clearQueue,
      pendingSlashCommandHistoryItems,
      pendingGeminiHistoryItems,
    ],
  );

  const handleFinalSubmit = useCallback(
    (submittedValue: string) => {
      addMessage(submittedValue);
      addInput(submittedValue); // Track input for up-arrow history
    },
    [addMessage, addInput],
  );

  const handleClearScreen = useCallback(() => {
    historyManager.clearItems();
    clearConsoleMessagesState();
    if (!isAlternateBuffer) {
      console.clear();
    }
    refreshStatic();
  }, [
    historyManager,
    clearConsoleMessagesState,
    refreshStatic,
    isAlternateBuffer,
  ]);

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
    !!slashCommands &&
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.Responding) &&
    !proQuotaRequest;

  const [controlsHeight, setControlsHeight] = useState(0);

  useLayoutEffect(() => {
    if (mainControlsRef.current) {
      const fullFooterMeasurement = measureElement(mainControlsRef.current);
      if (
        fullFooterMeasurement.height > 0 &&
        fullFooterMeasurement.height !== controlsHeight
      ) {
        setControlsHeight(fullFooterMeasurement.height);
      }
    }
  }, [buffer, terminalWidth, terminalHeight, controlsHeight]);

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

  const contextFileNames = useMemo(() => {
    // AUDITARIA_FEATURE_START: Context file names computation - use actual loaded file paths
    // Get actual loaded file paths from config
    const loadedFilePaths = config.getGeminiMdFilePaths();
    if (loadedFilePaths && loadedFilePaths.length > 0) {
      // Extract basenames from actual loaded paths
      return loadedFilePaths.map((filePath) => basename(filePath));
    }
    // AUDITARIA_FEATURE_END: Fallback to configured names if no files loaded yet
    const fromSettings = settings.merged.context?.fileName;
    return fromSettings
      ? Array.isArray(fromSettings)
        ? fromSettings
        : [fromSettings]
      : getAllGeminiMdFilenames();
    // }, [config, settings.merged.context?.fileName]); // original line
  }, [config, settings.merged.context?.fileName]); // AUDITARIA_FEATURE

  // Initial prompt handling
  const initialPrompt = useMemo(() => config.getQuestion(), [config]);
  const initialPromptSubmitted = useRef(false);
  const geminiClient = config.getGeminiClient();

  useEffect(() => {
    if (activePtyId) {
      try {
        ShellExecutionService.resizePty(
          activePtyId,
          Math.floor(terminalWidth * SHELL_WIDTH_FRACTION),
          Math.max(
            Math.floor(availableTerminalHeight - SHELL_HEIGHT_PADDING),
            1,
          ),
        );
      } catch (e) {
        // This can happen in a race condition where the pty exits
        // right before we try to resize it.
        if (
          !(
            e instanceof Error &&
            e.message.includes('Cannot resize a pty that has already exited')
          )
        ) {
          throw e;
        }
      }
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

  const [idePromptAnswered, setIdePromptAnswered] = useState(false);
  const [currentIDE, setCurrentIDE] = useState<IdeInfo | null>(null);

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

  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showFullTodos, setShowFullTodos] = useState<boolean>(false);
  const [renderMarkdown, setRenderMarkdown] = useState<boolean>(true);

  const [ctrlCPressCount, setCtrlCPressCount] = useState(0);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressCount, setCtrlDPressCount] = useState(0);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [ideContextState, setIdeContextState] = useState<
    IdeContext | undefined
  >();
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [showIdeRestartPrompt, setShowIdeRestartPrompt] = useState(false);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);

  const { isFolderTrustDialogOpen, handleFolderTrustSelect, isRestarting } =
    useFolderTrust(settings, setIsTrustedFolder, historyManager.addItem);
  const {
    needsRestart: ideNeedsRestart,
    restartReason: ideTrustRestartReason,
  } = useIdeTrustListener();
  const isInitialMount = useRef(true);

  useIncludeDirsTrust(config, isTrustedFolder, historyManager, setCustomDialog);

  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const handleWarning = (message: string) => {
      setWarningMessage(message);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      timeoutId = setTimeout(() => {
        setWarningMessage(null);
      }, WARNING_PROMPT_DURATION_MS);
    };

    const handleSelectionWarning = () => {
      handleWarning('Press Ctrl-S to enter selection mode to copy text.');
    };
    const handlePasteTimeout = () => {
      handleWarning('Paste Timed out. Possibly due to slow connection.');
    };
    appEvents.on(AppEvent.SelectionWarning, handleSelectionWarning);
    appEvents.on(AppEvent.PasteTimeout, handlePasteTimeout);
    return () => {
      appEvents.off(AppEvent.SelectionWarning, handleSelectionWarning);
      appEvents.off(AppEvent.PasteTimeout, handlePasteTimeout);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    if (ideNeedsRestart) {
      // IDE trust changed, force a restart.
      setShowIdeRestartPrompt(true);
    }
  }, [ideNeedsRestart]);

  useEffect(() => {
    if (queueErrorMessage) {
      const timer = setTimeout(() => {
        setQueueErrorMessage(null);
      }, QUEUE_ERROR_DISPLAY_DURATION_MS);

      return () => clearTimeout(timer);
    }
    return undefined;
  }, [queueErrorMessage, setQueueErrorMessage]);

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

    return () => {
      appEvents.off(AppEvent.OpenDebugConsole, openDebugConsole);
    };
  }, [config]);

  // WEB_INTERFACE_START: Listen for MCP client updates to sync tools to web
  useEffect(() => {
    const handleMcpClientUpdate = () => {
      setMcpClientUpdateCounter((prev) => prev + 1);
    };
    appEvents.on(AppEvent.McpClientUpdate, handleMcpClientUpdate);

    return () => {
      appEvents.off(AppEvent.McpClientUpdate, handleMcpClientUpdate);
    };
  }, []);
  // WEB_INTERFACE_END

  useEffect(() => {
    if (ctrlCTimerRef.current) {
      clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = null;
    }
    if (ctrlCPressCount > 2) {
      recordExitFail(config);
    }
    if (ctrlCPressCount > 1) {
      handleSlashCommand('/quit', undefined, undefined, false);
    } else {
      ctrlCTimerRef.current = setTimeout(() => {
        setCtrlCPressCount(0);
        ctrlCTimerRef.current = null;
      }, WARNING_PROMPT_DURATION_MS);
    }
  }, [ctrlCPressCount, config, setCtrlCPressCount, handleSlashCommand]);

  useEffect(() => {
    if (ctrlDTimerRef.current) {
      clearTimeout(ctrlDTimerRef.current);
      ctrlCTimerRef.current = null;
    }
    if (ctrlDPressCount > 2) {
      recordExitFail(config);
    }
    if (ctrlDPressCount > 1) {
      handleSlashCommand('/quit', undefined, undefined, false);
    } else {
      ctrlDTimerRef.current = setTimeout(() => {
        setCtrlDPressCount(0);
        ctrlDTimerRef.current = null;
      }, WARNING_PROMPT_DURATION_MS);
    }
  }, [ctrlDPressCount, config, setCtrlDPressCount, handleSlashCommand]);

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

  const { elapsedTime, currentLoadingPhrase } = useLoadingIndicator(
    streamingState,
    settings.merged.ui?.customWittyPhrases,
    !!activePtyId && !embeddedShellFocused,
    lastOutputTime,
  );

  const handleGlobalKeypress = useCallback(
    (key: Key) => {
      if (copyModeEnabled) {
        setCopyModeEnabled(false);
        enableMouseEvents();
        // We don't want to process any other keys if we're in copy mode.
        return;
      }

      // Debug log keystrokes if enabled
      if (settings.merged.general?.debugKeystrokeLogging) {
        debugLogger.log('[DEBUG] Keystroke:', JSON.stringify(key));
      }

      if (isAlternateBuffer && keyMatchers[Command.TOGGLE_COPY_MODE](key)) {
        setCopyModeEnabled(true);
        disableMouseEvents();
        return;
      }

      if (keyMatchers[Command.QUIT](key)) {
        // If the user presses Ctrl+C, we want to cancel any ongoing requests.
        // This should happen regardless of the count.
        cancelOngoingRequest?.();

        setCtrlCPressCount((prev) => prev + 1);
        return;
      } else if (keyMatchers[Command.EXIT](key)) {
        if (buffer.text.length > 0) {
          return;
        }
        setCtrlDPressCount((prev) => prev + 1);
        return;
      }

      let enteringConstrainHeightMode = false;
      if (!constrainHeight) {
        enteringConstrainHeightMode = true;
        setConstrainHeight(true);
      }

      if (keyMatchers[Command.SHOW_ERROR_DETAILS](key)) {
        setShowErrorDetails((prev) => !prev);
      } else if (keyMatchers[Command.SHOW_FULL_TODOS](key)) {
        setShowFullTodos((prev) => !prev);
      } else if (keyMatchers[Command.TOGGLE_MARKDOWN](key)) {
        setRenderMarkdown((prev) => {
          const newValue = !prev;
          // Force re-render of static content
          refreshStatic();
          return newValue;
        });
      } else if (
        keyMatchers[Command.TOGGLE_IDE_CONTEXT_DETAIL](key) &&
        config.getIdeMode() &&
        ideContextState
      ) {
        handleSlashCommand('/ide status');
      } else if (
        keyMatchers[Command.SHOW_MORE_LINES](key) &&
        !enteringConstrainHeightMode
      ) {
        setConstrainHeight(false);
      } else if (keyMatchers[Command.TOGGLE_SHELL_INPUT_FOCUS](key)) {
        if (activePtyId || embeddedShellFocused) {
          setEmbeddedShellFocused((prev) => !prev);
        }
      }
    },
    [
      constrainHeight,
      setConstrainHeight,
      setShowErrorDetails,
      config,
      ideContextState,
      setCtrlCPressCount,
      buffer.text.length,
      setCtrlDPressCount,
      handleSlashCommand,
      cancelOngoingRequest,
      activePtyId,
      embeddedShellFocused,
      settings.merged.general?.debugKeystrokeLogging,
      refreshStatic,
      setCopyModeEnabled,
      copyModeEnabled,
      isAlternateBuffer,
    ],
  );

  useKeypress(handleGlobalKeypress, { isActive: true });

  // Update terminal title with Gemini CLI status and thoughts
  useEffect(() => {
    // Respect both showStatusInTitle and hideWindowTitle settings
    if (
      !settings.merged.ui?.showStatusInTitle ||
      settings.merged.ui?.hideWindowTitle
    )
      return;

    let title;
    if (streamingState === StreamingState.Idle) {
      title = originalTitleRef.current;
    } else {
      const statusText = thought?.subject
        ?.replace(/[\r\n]+/g, ' ')
        .substring(0, 80);
      title = statusText || originalTitleRef.current;
    }

    // Pad the title to a fixed width to prevent taskbar icon resizing.
    const paddedTitle = title.padEnd(80, ' ');

    // Only update the title if it's different from the last value we set
    if (lastTitleRef.current !== paddedTitle) {
      lastTitleRef.current = paddedTitle;
      stdout.write(`\x1b]2;${paddedTitle}\x07`);
    }
    // Note: We don't need to reset the window title on exit because Gemini CLI is already doing that elsewhere
  }, [
    streamingState,
    thought,
    settings.merged.ui?.showStatusInTitle,
    settings.merged.ui?.hideWindowTitle,
    stdout,
  ]);

  useEffect(() => {
    const handleUserFeedback = (payload: UserFeedbackPayload) => {
      let type: MessageType;
      switch (payload.severity) {
        case 'error':
          type = MessageType.ERROR;
          break;
        case 'warning':
          type = MessageType.WARNING;
          break;
        case 'info':
          type = MessageType.INFO;
          break;
        default:
          throw new Error(
            `Unexpected severity for user feedback: ${payload.severity}`,
          );
      }

      historyManager.addItem(
        {
          type,
          text: payload.message,
        },
        Date.now(),
      );

      // If there is an attached error object, log it to the debug drawer.
      if (payload.error) {
        debugLogger.warn(
          `[Feedback Details for "${payload.message}"]`,
          payload.error,
        );
      }
    };

    coreEvents.on(CoreEvent.UserFeedback, handleUserFeedback);

    // Flush any messages that happened during startup before this component
    // mounted.
    coreEvents.drainBacklogs();

    return () => {
      coreEvents.off(CoreEvent.UserFeedback, handleUserFeedback);
    };
  }, [historyManager]);

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

  const dialogsVisible =
    shouldShowIdePrompt ||
    isFolderTrustDialogOpen ||
    !!shellConfirmationRequest ||
    !!confirmationRequest ||
    !!customDialog ||
    confirmUpdateExtensionRequests.length > 0 ||
    !!loopDetectionConfirmationRequest ||
    isThemeDialogOpen ||
    isSettingsDialogOpen ||
    isModelDialogOpen ||
    isPermissionsDialogOpen ||
    isAuthenticating ||
    isAuthDialogOpen ||
    isEditorDialogOpen ||
    isLanguageDialogOpen ||
    showPrivacyNotice ||
    showIdeRestartPrompt ||
    !!proQuotaRequest ||
    isSessionBrowserOpen ||
    isAuthDialogOpen ||
    authState === AuthState.AwaitingApiKeyInput;

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array - only register once

  // Terminal capture for interactive screens
  // The capture hook is always running (registered in TerminalCaptureContext on mount)
  // We just need to tell it when dialogs are visible so it broadcasts the content
  const terminalCapture = useTerminalCapture();
  useKeypressContext(); // Required for keypress context initialization

  // Start/stop terminal capture broadcasting when interactive screens change
  // Uses dialogsVisible as the single source of truth for detecting any open dialog
  // This ensures terminal capture works for ALL dialogs automatically (DRY principle)
  // Note: No prewarming needed - the hook captures output before this effect runs
  useEffect(() => {
    if (dialogsVisible) {
      terminalCapture.setInteractiveScreenActive(true);
    } else {
      const timer = setTimeout(() => {
        terminalCapture.setInteractiveScreenActive(false);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [dialogsVisible, terminalCapture]);

  // Handle keyboard input from web interface
  useEffect(() => {
    if (!webInterface?.service) return;

    const handleTerminalInput = (keyData: {
      name?: string;
      sequence?: string;
      ctrl?: boolean;
      meta?: boolean;
      shift?: boolean;
      alt?: boolean;
    }) => {
      // Only emit when interactive screens are open (terminal capture is active)
      if (dialogsVisible && keyData.sequence) {
        // Emit as 'data' event - Ink's KeypressProvider in PassThrough mode listens for 'data', not 'keypress'
        process.stdin.emit('data', keyData.sequence);
      }
    };

    // Listen for terminal input events from web interface
    webInterface.service.on('terminal_input', handleTerminalInput);

    return () => {
      webInterface?.service?.off('terminal_input', handleTerminalInput);
    };
  }, [webInterface?.service, dialogsVisible]);

  // Web interface broadcasting - footer, loading state, commands, MCP servers, console messages, CLI action required, startup message, and tool confirmations
  const footerContext = useFooter();
  useEffect(() => {
    if (
      footerContext?.footerData &&
      webInterface?.service &&
      webInterface.isRunning
    ) {
      webInterface.service.broadcastFooterData(footerContext.footerData);
    }
  }, [
    footerContext?.footerData,
    webInterface?.service,
    webInterface?.isRunning,
  ]);

  useLoadingState(); // Required for loading state context initialization
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastLoadingState({
        isLoading: streamingState === StreamingState.Responding || isProcessing,
        streamingState,
        elapsedTime,
        currentLoadingPhrase,
        thought:
          typeof thought === 'string' ? thought : thought?.subject || null,
        thoughtObject:
          typeof thought === 'object' && thought !== null ? thought : null,
      });
    }
  }, [
    webInterface?.service,
    webInterface?.isRunning,
    streamingState,
    elapsedTime,
    currentLoadingPhrase,
    isProcessing,
    thought,
  ]);

  // Broadcast slash commands
  useEffect(() => {
    if (slashCommands && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastSlashCommands(slashCommands);
    }
  }, [slashCommands, webInterface?.service, webInterface?.isRunning]);

  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      const mcpClientManager = config.getMcpClientManager();
      const mcpServers = mcpClientManager?.getMcpServers() || {};

      // Get blocked servers from MCP client manager
      const blockedServers = mcpClientManager?.getBlockedMcpServers() || [];

      // Get actual tools from tool registry and group by server name
      const toolRegistry = config.getToolRegistry();
      const allTools = toolRegistry?.getAllTools() || [];
      const mcpTools = allTools.filter(
        (tool): tool is DiscoveredMCPTool => tool instanceof DiscoveredMCPTool,
      );

      // Group tools by server name
      const serverTools = new Map<string, DiscoveredMCPTool[]>();
      const serverStatuses = new Map<string, string>();

      // Initialize maps for all servers
      Object.keys(mcpServers).forEach((name) => {
        serverTools.set(name, []);
        // Get actual server status
        const status = getMCPServerStatus(name);
        let statusStr: string;
        switch (status) {
          case MCPServerStatus.CONNECTED:
            statusStr = 'connected';
            break;
          case MCPServerStatus.CONNECTING:
            statusStr = 'connecting';
            break;
          case MCPServerStatus.DISCONNECTED:
            statusStr = 'disconnected';
            break;
          case MCPServerStatus.DISCONNECTING:
            statusStr = 'disconnecting';
            break;
          default:
            statusStr = 'unknown';
        }
        serverStatuses.set(name, statusStr);
      });

      // Group tools by their server name
      mcpTools.forEach((tool) => {
        const tools = serverTools.get(tool.serverName) || [];
        tools.push(tool);
        serverTools.set(tool.serverName, tools);
      });

      webInterface.service.broadcastMCPServers(
        mcpServers,
        blockedServers,
        serverTools,
        serverStatuses,
      );
    }
  }, [
    config,
    webInterface?.service,
    webInterface?.isRunning,
    mcpClientUpdateCounter,
  ]);

  // Broadcast console messages
  useEffect(() => {
    if (
      filteredConsoleMessages &&
      webInterface?.service &&
      webInterface.isRunning
    ) {
      webInterface.service.broadcastConsoleMessages(filteredConsoleMessages);
    }
  }, [filteredConsoleMessages, webInterface?.service, webInterface?.isRunning]);

  // Broadcast CLI action required messages for different dialogs
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      let message = '';
      const title = 'CLI Action Required';
      let reason = 'general';

      if (shouldShowIdePrompt) {
        message =
          'IDE integration prompt is displayed. Please respond to connect your editor to Auditaria CLI in the terminal.';
        reason = 'ide_integration';
      } else if (isAuthenticating || isAuthDialogOpen) {
        const authMessage = isAuthenticating
          ? 'Authentication is in progress. Please check the CLI terminal.'
          : 'Authentication is required. Please complete the authentication process in the CLI terminal.';
        message = authMessage;
        reason = 'authentication';
      } else if (isThemeDialogOpen) {
        message =
          'Theme selection is open. Please choose a theme in the CLI terminal.';
        reason = 'theme_selection';
      } else if (isEditorDialogOpen) {
        message =
          'Editor settings are open. Please configure your editor in the CLI terminal.';
        reason = 'editor_settings';
      } else if (isLanguageDialogOpen) {
        message =
          'Language selection is open. Please choose a language in the CLI terminal.';
        reason = 'language_selection';
      } else if (isSettingsDialogOpen) {
        message =
          'Settings dialog is open. Please configure settings in the CLI terminal.';
        reason = 'settings';
      } else if (isModelDialogOpen) {
        message =
          'Model selection is open. Please choose a model in the CLI terminal.';
        reason = 'model_selection';
      } else if (isFolderTrustDialogOpen) {
        message =
          'Folder trust dialog is open. Please respond in the CLI terminal.';
        reason = 'folder_trust';
      } else if (showPrivacyNotice) {
        message =
          'Privacy notice is displayed. Please review in the CLI terminal.';
        reason = 'privacy_notice';
      } else if (proQuotaRequest) {
        message =
          'Quota exceeded dialog is open. Please choose an option in the CLI terminal.';
        reason = 'quota_exceeded';
      } else if (shellConfirmationRequest) {
        message =
          'Shell command confirmation required. Please respond in the CLI terminal.';
        reason = 'shell_confirmation';
      } else if (confirmationRequest) {
        message = 'Confirmation required. Please respond in the CLI terminal.';
        reason = 'confirmation';
      } else if (loopDetectionConfirmationRequest) {
        message =
          'Loop detection confirmation required. Please choose whether to keep or disable loop detection in the CLI terminal.';
        reason = 'loop_detection';
      }

      if (message) {
        webInterface.service.broadcastCliActionRequired(
          true,
          reason,
          title,
          message,
        );
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
    isModelDialogOpen,
    isFolderTrustDialogOpen,
    showPrivacyNotice,
    proQuotaRequest,
    shellConfirmationRequest,
    confirmationRequest,
    loopDetectionConfirmationRequest,
  ]);

  // Broadcast startup message once
  useEffect(() => {
    if (
      webInterface?.service &&
      webInterface.isRunning &&
      initializationResult.geminiMdFileCount
    ) {
      // Show breakdown by file type in startup message
      const loadedFilePaths = config.getGeminiMdFilePaths();
      let filesDescription = `${initializationResult.geminiMdFileCount} context file(s)`;
      if (loadedFilePaths && loadedFilePaths.length > 0) {
        const fileTypeCounts: Record<string, number> = {};
        for (const filePath of loadedFilePaths) {
          const fileName = basename(filePath);
          fileTypeCounts[fileName] = (fileTypeCounts[fileName] || 0) + 1;
        }
        const parts = Object.entries(fileTypeCounts).map(
          ([name, count]) => `${count} ${name}`,
        );
        filesDescription = parts.join(', ');
      }
      const startupMessage = `Auditaria CLI is ready. Loaded ${filesDescription}.`;
      // Use a generic broadcast since there's no specific setStartupMessage method
      webInterface.service.broadcastMessage({
        id: Date.now(),
        type: 'info',
        text: startupMessage,
      } as HistoryItem);
    }
  }, [
    webInterface?.service,
    webInterface?.isRunning,
    initializationResult.geminiMdFileCount,
    config,
  ]);

  // Tool confirmation broadcasting and response handling
  const toolConfirmationContext = useToolConfirmation();

  // Register confirmation response handler from web interface
  useEffect(() => {
    if (toolConfirmationContext && webInterface?.service) {
      webInterface.service.setConfirmationResponseHandler(
        (callId, outcome, payload) => {
          toolConfirmationContext.handleConfirmationResponse(
            callId,
            outcome,
            payload,
          );
        },
      );
    }
  }, [toolConfirmationContext, webInterface?.service]);

  // Broadcast pending confirmations
  useEffect(() => {
    const pendingConfirmation =
      toolConfirmationContext?.pendingConfirmations?.[0];
    if (
      pendingConfirmation &&
      webInterface?.service &&
      webInterface.isRunning
    ) {
      webInterface.service.broadcastToolConfirmation(pendingConfirmation);
    }
  }, [
    toolConfirmationContext?.pendingConfirmations,
    webInterface?.service,
    webInterface?.isRunning,
  ]);

  // Broadcast confirmation removal when confirmations are resolved
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      // When a confirmation is removed from the queue, broadcast the removal
      const activeConfirmations =
        toolConfirmationContext?.pendingConfirmations || [];
      const trackedConfirmations = [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...((webInterface.service as any).activeToolConfirmations?.keys() ||
          []),
      ];

      // Find confirmations that were tracked but are no longer pending
      trackedConfirmations.forEach((callId) => {
        if (!activeConfirmations.some((c) => c.callId === callId)) {
          webInterface.service!.broadcastToolConfirmationRemoval(callId);
        }
      });
    }
  }, [
    toolConfirmationContext?.pendingConfirmations,
    webInterface?.service,
    webInterface?.isRunning,
  ]);

  // Broadcast history updates
  useEffect(() => {
    if (historyManager.history && webInterface?.service) {
      webInterface.service.setCurrentHistory(historyManager.history);
    }
  }, [historyManager.history, webInterface?.service]);

  // Broadcast pending items
  const pendingItem =
    pendingHistoryItems.length > 0
      ? (pendingHistoryItems[0] as HistoryItem)
      : null;
  useEffect(() => {
    if (webInterface?.service) {
      webInterface.service.broadcastPendingItem(pendingItem);
    }
  }, [pendingItem, webInterface?.service]);
  // WEB_INTERFACE_END

  const [geminiMdFileCount, setGeminiMdFileCount] = useState<number>(
    config.getGeminiMdFileCount(),
  );
  useEffect(() => {
    const handleMemoryChanged = (result: MemoryChangedPayload) => {
      setGeminiMdFileCount(result.fileCount);
    };
    coreEvents.on(CoreEvent.MemoryChanged, handleMemoryChanged);
    return () => {
      coreEvents.off(CoreEvent.MemoryChanged, handleMemoryChanged);
    };
  }, []);

  useEffect(() => {
    let isMounted = true;

    const fetchBannerTexts = async () => {
      const [defaultBanner, warningBanner] = await Promise.all([
        config.getBannerTextNoCapacityIssues(),
        config.getBannerTextCapacityIssues(),
      ]);

      if (isMounted) {
        setDefaultBannerText(defaultBanner);
        setWarningBannerText(warningBanner);
        setBannerVisible(true);
        refreshStatic();
        const authType = config.getContentGeneratorConfig()?.authType;
        if (
          authType === AuthType.USE_GEMINI ||
          authType === AuthType.USE_VERTEX_AI
        ) {
          setDefaultBannerText(
            'Gemini 3 is now available.\nTo use Gemini 3, enable "Preview features" in /settings\nLearn more at https://goo.gle/enable-preview-features',
          );
        }
      }
    };
    fetchBannerTexts();

    return () => {
      isMounted = false;
    };
  }, [config, refreshStatic]);

  const uiState: UIState = useMemo(
    () => ({
      history: historyManager.history,
      historyManager,
      isThemeDialogOpen,
      themeError,
      isAuthenticating,
      isConfigInitialized,
      authError,
      isAuthDialogOpen,
      isAwaitingApiKeyInput: authState === AuthState.AwaitingApiKeyInput,
      apiKeyDefaultValue,
      editorError,
      isEditorDialogOpen,
      languageError,
      isLanguageDialogOpen,
      showPrivacyNotice,
      corgiMode,
      debugMessage,
      quittingMessages,
      isSettingsDialogOpen,
      isSessionBrowserOpen,
      isModelDialogOpen,
      isPermissionsDialogOpen,
      permissionsDialogProps,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      shellConfirmationRequest,
      confirmationRequest,
      confirmUpdateExtensionRequests,
      loopDetectionConfirmationRequest,
      geminiMdFileCount,
      streamingState,
      initError,
      pendingGeminiHistoryItems,
      thought,
      shellModeActive,
      userMessages: inputHistory,
      buffer,
      inputWidth,
      suggestionsWidth,
      isInputActive,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen: isFolderTrustDialogOpen ?? false,
      isTrustedFolder,
      constrainHeight,
      showErrorDetails,
      showFullTodos,
      filteredConsoleMessages,
      ideContextState,
      renderMarkdown,
      ctrlCPressedOnce: ctrlCPressCount >= 1,
      ctrlDPressedOnce: ctrlDPressCount >= 1,
      showEscapePrompt,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      messageQueue,
      queueErrorMessage,
      showAutoAcceptIndicator,
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
      rootUiRef,
      currentIDE,
      updateInfo,
      showIdeRestartPrompt,
      ideTrustRestartReason,
      isRestarting,
      extensionsUpdateState,
      activePtyId,
      embeddedShellFocused,
      showDebugProfiler,
      customDialog,
      copyModeEnabled,
      warningMessage,
      bannerData: {
        defaultText: defaultBannerText,
        warningText: warningBannerText,
      },
      bannerVisible,
    }),
    [
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
      isSessionBrowserOpen,
      isModelDialogOpen,
      isPermissionsDialogOpen,
      permissionsDialogProps,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      shellConfirmationRequest,
      confirmationRequest,
      confirmUpdateExtensionRequests,
      loopDetectionConfirmationRequest,
      geminiMdFileCount,
      streamingState,
      initError,
      pendingGeminiHistoryItems,
      thought,
      shellModeActive,
      inputHistory,
      buffer,
      inputWidth,
      suggestionsWidth,
      isInputActive,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen,
      isTrustedFolder,
      constrainHeight,
      showErrorDetails,
      showFullTodos,
      filteredConsoleMessages,
      ideContextState,
      renderMarkdown,
      ctrlCPressCount,
      ctrlDPressCount,
      showEscapePrompt,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      messageQueue,
      queueErrorMessage,
      showAutoAcceptIndicator,
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
      rootUiRef,
      currentIDE,
      updateInfo,
      showIdeRestartPrompt,
      ideTrustRestartReason,
      isRestarting,
      currentModel,
      extensionsUpdateState,
      activePtyId,
      historyManager,
      embeddedShellFocused,
      showDebugProfiler,
      customDialog,
      apiKeyDefaultValue,
      authState,
      copyModeEnabled,
      warningMessage,
      defaultBannerText,
      warningBannerText,
      bannerVisible,
    ],
  );

  const exitPrivacyNotice = useCallback(
    () => setShowPrivacyNotice(false),
    [setShowPrivacyNotice],
  );

  const uiActions: UIActions = useMemo(
    () => ({
      handleThemeSelect,
      closeThemeDialog,
      handleThemeHighlight,
      handleAuthSelect,
      setAuthState,
      onAuthError,
      handleEditorSelect,
      exitEditorDialog,
      handleLanguageSelect,
      exitPrivacyNotice,
      closeSettingsDialog,
      closeModelDialog,
      openPermissionsDialog,
      closePermissionsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleFolderTrustSelect,
      setConstrainHeight,
      onEscapePromptChange: handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      handleClearScreen,
      handleProQuotaChoice,
      openSessionBrowser,
      closeSessionBrowser,
      handleResumeSession,
      handleDeleteSession,
      setQueueErrorMessage,
      popAllMessages,
      handleApiKeySubmit,
      handleApiKeyCancel,
      setBannerVisible,
      setEmbeddedShellFocused,
    }),
    [
      handleThemeSelect,
      closeThemeDialog,
      handleThemeHighlight,
      handleAuthSelect,
      setAuthState,
      onAuthError,
      handleEditorSelect,
      exitEditorDialog,
      handleLanguageSelect,
      exitPrivacyNotice,
      closeSettingsDialog,
      closeModelDialog,
      openPermissionsDialog,
      closePermissionsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleFolderTrustSelect,
      setConstrainHeight,
      handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      handleClearScreen,
      handleProQuotaChoice,
      openSessionBrowser,
      closeSessionBrowser,
      handleResumeSession,
      handleDeleteSession,
      setQueueErrorMessage,
      popAllMessages,
      handleApiKeySubmit,
      handleApiKeyCancel,
      setBannerVisible,
      setEmbeddedShellFocused,
    ],
  );

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
            <ShellFocusContext.Provider value={isFocused}>
              <App />
            </ShellFocusContext.Provider>
          </AppContext.Provider>
        </ConfigContext.Provider>
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
};
