/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  Box,
  DOMElement,
  measureElement,
  Static,
  Text,
  useStdin,
  useStdout,
  useInput,
  type Key as InkKeyType,
} from 'ink';
import { StreamingState, type HistoryItem, MessageType } from './types.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useThemeCommand } from './hooks/useThemeCommand.js';
import { useAuthCommand } from './hooks/useAuthCommand.js';
import { useEditorSettings } from './hooks/useEditorSettings.js';
import { useLanguageSettings } from './hooks/useLanguageSettings.js';
import { useSlashCommandProcessor } from './hooks/slashCommandProcessor.js';
import { useAutoAcceptIndicator } from './hooks/useAutoAcceptIndicator.js';
import { useConsoleMessages } from './hooks/useConsoleMessages.js';
import { Header } from './components/Header.js';
import { LoadingIndicator } from './components/LoadingIndicator.js';
import { AutoAcceptIndicator } from './components/AutoAcceptIndicator.js';
import { ShellModeIndicator } from './components/ShellModeIndicator.js';
import { InputPrompt } from './components/InputPrompt.js';
import { Footer } from './components/Footer.js';
import { ThemeDialog } from './components/ThemeDialog.js';
import { AuthDialog } from './components/AuthDialog.js';
import { AuthInProgress } from './components/AuthInProgress.js';
import { EditorSettingsDialog } from './components/EditorSettingsDialog.js';
import { LanguageSelectionDialog } from './components/LanguageSelectionDialog.js';
import { ShellConfirmationDialog } from './components/ShellConfirmationDialog.js';
import { Colors } from './colors.js';
import { loadHierarchicalGeminiMemory } from '../config/config.js';
import { LoadedSettings, SettingScope } from '../config/settings.js';
import { Tips } from './components/Tips.js';
import { ConsolePatcher } from './utils/ConsolePatcher.js';
import { registerCleanup } from '../utils/cleanup.js';
import { DetailedMessagesDisplay } from './components/DetailedMessagesDisplay.js';
import { HistoryItemDisplay } from './components/HistoryItemDisplay.js';
import { ContextSummaryDisplay } from './components/ContextSummaryDisplay.js';
import { IDEContextDetailDisplay } from './components/IDEContextDetailDisplay.js';
import { useHistory } from './hooks/useHistoryManager.js';
import process from 'node:process';
import {
  getErrorMessage,
  type Config,
  getAllGeminiMdFilenames,
  ApprovalMode,
  isEditorAvailable,
  EditorType,
  FlashFallbackEvent,
  logFlashFallback,
  AuthType,
  type IdeContext,
  ideContext,
  // WEB_INTERFACE_START: Additional imports for MCP server broadcasting
  DiscoveredMCPTool,
  getMCPServerStatus,
  getAllMCPServerStatuses,
  MCPServerStatus,
  // WEB_INTERFACE_END
} from '@thacio/auditaria-cli-core';
import {
  IdeIntegrationNudge,
  IdeIntegrationNudgeResult,
} from './IdeIntegrationNudge.js';
import { validateAuthMethod } from '../config/auth.js';
import { useLogger } from './hooks/useLogger.js';
import { StreamingContext } from './contexts/StreamingContext.js';
import {
  SessionStatsProvider,
  useSessionStats,
} from './contexts/SessionContext.js';
import { useGitBranchName } from './hooks/useGitBranchName.js';
import { useFocus } from './hooks/useFocus.js';
import { useBracketedPaste } from './hooks/useBracketedPaste.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useVimMode, VimModeProvider } from './contexts/VimModeContext.js';
import { useVim } from './hooks/vim.js';
import * as fs from 'fs';
import { UpdateNotification } from './components/UpdateNotification.js';
import {
  isProQuotaExceededError,
  isGenericQuotaExceededError,
  UserTierId,
} from '@thacio/auditaria-cli-core';
import { UpdateObject } from './utils/updateCheck.js';
import ansiEscapes from 'ansi-escapes';
// WEB_INTERFACE_START: Web interface context imports
import { WebInterfaceProvider, useWebInterface } from './contexts/WebInterfaceContext.js';
import { SubmitQueryProvider, useSubmitQueryRegistration } from './contexts/SubmitQueryContext.js';
import { FooterProvider, useFooter } from './contexts/FooterContext.js';
import { LoadingStateProvider, useLoadingState } from './contexts/LoadingStateContext.js';
import { ToolConfirmationProvider, useToolConfirmation, PendingToolConfirmation } from './contexts/ToolConfirmationContext.js';
// WEB_INTERFACE_END
import { OverflowProvider } from './contexts/OverflowContext.js';
import { ShowMoreLines } from './components/ShowMoreLines.js';
import { PrivacyNotice } from './privacy/PrivacyNotice.js';
import { setUpdateHandler } from '../utils/handleAutoUpdate.js';
import { appEvents, AppEvent } from '../utils/events.js';

const CTRL_EXIT_PROMPT_DURATION_MS = 1000;

interface AppProps {
  config: Config;
  settings: LoadedSettings;
  startupWarnings?: string[];
  version: string;
  // WEB_INTERFACE_START: Web interface props
  webEnabled?: boolean;
  webOpenBrowser?: boolean;
  // WEB_INTERFACE_END
}

export const AppWrapper = (props: AppProps) => (
  <SessionStatsProvider>
    <VimModeProvider settings={props.settings}>

    {/* WEB_INTERFACE_START: Web interface provider wrappers */}
    <SubmitQueryProvider>
      <WebInterfaceProvider enabled={props.webEnabled} openBrowser={props.webOpenBrowser}>
        <FooterProvider>
          <LoadingStateProvider>
            <ToolConfirmationProvider>
              {/* WEB_INTERFACE_END */}
      <App {...props} />
              {/* WEB_INTERFACE_START: Close web interface providers */}
            </ToolConfirmationProvider>
          </LoadingStateProvider>
        </FooterProvider>
      </WebInterfaceProvider>
    </SubmitQueryProvider>
    {/* WEB_INTERFACE_END */}
    </VimModeProvider>
  </SessionStatsProvider>
);

const App = ({ config, settings, startupWarnings = [], version, /* WEB_INTERFACE_START */ webEnabled, webOpenBrowser /* WEB_INTERFACE_END */ }: AppProps) => {
  const isFocused = useFocus();
  useBracketedPaste();
  const [updateInfo, setUpdateInfo] = useState<UpdateObject | null>(null);
  const { stdout } = useStdout();
  const nightly = version.includes('nightly');
  const { history, addItem, clearItems, loadHistory } = useHistory();

  const [idePromptAnswered, setIdePromptAnswered] = useState(false);
  const currentIDE = config.getIdeClient().getCurrentIde();
  const shouldShowIdePrompt =
    config.getIdeModeFeature() &&
    currentIDE &&
    !config.getIdeMode() &&
    !settings.merged.hasSeenIdeIntegrationNudge &&
    !idePromptAnswered;

  useEffect(() => {
    const cleanup = setUpdateHandler(addItem, setUpdateInfo);
    return cleanup;
  }, [addItem]);

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

  const { stats: sessionStats } = useSessionStats();
  const [staticNeedsRefresh, setStaticNeedsRefresh] = useState(false);
  const [staticKey, setStaticKey] = useState(0);
  const refreshStatic = useCallback(() => {
    stdout.write(ansiEscapes.clearTerminal);
    setStaticKey((prev) => prev + 1);
  }, [setStaticKey, stdout]);

  const [geminiMdFileCount, setGeminiMdFileCount] = useState<number>(0);
  const [debugMessage, setDebugMessage] = useState<string>('');
  const [showHelp, setShowHelp] = useState<boolean>(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [languageError, setLanguageError] = useState<string | null>(null);
  const [footerHeight, setFooterHeight] = useState<number>(0);
  const [corgiMode, setCorgiMode] = useState(false);
  const [currentModel, setCurrentModel] = useState(config.getModel());
  const [shellModeActive, setShellModeActive] = useState(false);
  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showToolDescriptions, setShowToolDescriptions] =
    useState<boolean>(false);
  const [showIDEContextDetail, setShowIDEContextDetail] =
    useState<boolean>(false);
  const [ctrlCPressedOnce, setCtrlCPressedOnce] = useState(false);
  const [quittingMessages, setQuittingMessages] = useState<
    HistoryItem[] | null
  >(null);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [ctrlDPressedOnce, setCtrlDPressedOnce] = useState(false);
  const ctrlDTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [showPrivacyNotice, setShowPrivacyNotice] = useState<boolean>(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [userTier, setUserTier] = useState<UserTierId | undefined>(undefined);
  const [ideContextState, setIdeContextState] = useState<
    IdeContext | undefined
  >();
  const [isProcessing, setIsProcessing] = useState<boolean>(false);

  useEffect(() => {
    const unsubscribe = ideContext.subscribeToIdeContext(setIdeContextState);
    // Set the initial value
    setIdeContextState(ideContext.getIdeContext());
    return unsubscribe;
  }, []);

  useEffect(() => {
    const openDebugConsole = () => {
      setShowErrorDetails(true);
      setConstrainHeight(false); // Make sure the user sees the full message.
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

  const openPrivacyNotice = useCallback(() => {
    setShowPrivacyNotice(true);
  }, []);
  const initialPromptSubmitted = useRef(false);

  const errorCount = useMemo(
    () =>
      consoleMessages
        .filter((msg) => msg.type === 'error')
        .reduce((total, msg) => total + msg.count, 0),
    [consoleMessages],
  );

  const {
    isThemeDialogOpen,
    openThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  } = useThemeCommand(settings, setThemeError, addItem);

  const {
    isAuthDialogOpen,
    openAuthDialog,
    handleAuthSelect,
    isAuthenticating,
    cancelAuthentication,
  } = useAuthCommand(settings, setAuthError, config);

  useEffect(() => {
    if (settings.merged.selectedAuthType && !settings.merged.useExternalAuth) {
      const error = validateAuthMethod(settings.merged.selectedAuthType);
      if (error) {
        setAuthError(error);
        openAuthDialog();
      }
    }
  }, [
    settings.merged.selectedAuthType,
    settings.merged.useExternalAuth,
    openAuthDialog,
    setAuthError,
  ]);

  // Sync user tier from config when authentication changes
  useEffect(() => {
    // Only sync when not currently authenticating
    if (!isAuthenticating) {
      setUserTier(config.getGeminiClient()?.getUserTier());
    }
  }, [config, isAuthenticating]);

  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, addItem);

  const {
    isLanguageDialogOpen,
    openLanguageDialog,
    handleLanguageSelect,
    isFirstTimeSetup,
  } = useLanguageSettings(settings, setLanguageError, addItem, refreshStatic);

  const toggleCorgiMode = useCallback(() => {
    setCorgiMode((prev) => !prev);
  }, []);

  const performMemoryRefresh = useCallback(async () => {
    addItem(
      {
        type: MessageType.INFO,
        text: t('app.memory_refreshing', 'Refreshing hierarchical memory (GEMINI.md or other context files)...'),
      },
      Date.now(),
    );
    try {
      const { memoryContent, fileCount } = await loadHierarchicalGeminiMemory(
        process.cwd(),
        settings.merged.loadMemoryFromIncludeDirectories
          ? config.getWorkspaceContext().getDirectories()
          : [],
        config.getDebugMode(),
        config.getFileService(),
        settings.merged,
        config.getExtensionContextFilePaths(),
        settings.merged.memoryImportFormat || 'tree', // Use setting or default to 'tree'
        config.getFileFilteringOptions(),
      );

      config.setUserMemory(memoryContent);
      config.setGeminiMdFileCount(fileCount);
      setGeminiMdFileCount(fileCount);

      addItem(
        {
          type: MessageType.INFO,
          text: memoryContent.length > 0 
            ? t('app.memory_refreshed_success', 'Memory refreshed successfully. Loaded {chars} characters from {count} file(s).', { chars: memoryContent.length, count: fileCount })
            : t('app.memory_refreshed_no_content', 'Memory refreshed successfully. No memory content found.'),
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        console.log(
          `[DEBUG] Refreshed memory content in config: ${memoryContent.substring(0, 200)}...`,
        );
      }
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      addItem(
        {
          type: MessageType.ERROR,
          text: t('app.memory_refresh_error', 'Error refreshing memory: {error}', { error: errorMessage }),
        },
        Date.now(),
      );
      console.error('Error refreshing memory:', error);
    }
  }, [config, addItem, settings.merged]);

  // Watch for model changes (e.g., from Flash fallback)
  useEffect(() => {
    const checkModelChange = () => {
      const configModel = config.getModel();
      if (configModel !== currentModel) {
        setCurrentModel(configModel);
      }
    };

    // Check immediately and then periodically
    checkModelChange();
    const interval = setInterval(checkModelChange, 1000); // Check every second

    return () => clearInterval(interval);
  }, [config, currentModel]);

  // Set up Flash fallback handler
  useEffect(() => {
    const flashFallbackHandler = async (
      currentModel: string,
      fallbackModel: string,
      error?: unknown,
    ): Promise<boolean> => {
      let message: string;

      if (
        config.getContentGeneratorConfig().authType ===
        AuthType.LOGIN_WITH_GOOGLE
      ) {
        // Use actual user tier if available; otherwise, default to FREE tier behavior (safe default)
        const isPaidTier =
          userTier === UserTierId.LEGACY || userTier === UserTierId.STANDARD;

        // Check if this is a Pro quota exceeded error
        if (error && isProQuotaExceededError(error)) {
          if (isPaidTier) {
            message = t('app.quota_exceeded_pro_paid', '⚡ You have reached your daily {model} quota limit.\n⚡ Automatically switching from {model} to {fallback} for the remainder of this session.\n⚡ To continue accessing the {model} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey', { model: currentModel, fallback: fallbackModel });
          } else {
            message = t('app.quota_exceeded_pro_free', '⚡ You have reached your daily {model} quota limit.\n⚡ Automatically switching from {model} to {fallback} for the remainder of this session.\n⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist\n⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key\n⚡ You can switch authentication methods by typing /auth', { model: currentModel, fallback: fallbackModel });
          }
        } else if (error && isGenericQuotaExceededError(error)) {
          if (isPaidTier) {
            message = t('app.quota_exceeded_generic_paid', '⚡ You have reached your daily quota limit.\n⚡ Automatically switching from {model} to {fallback} for the remainder of this session.\n⚡ To continue accessing the {model} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey', { model: currentModel, fallback: fallbackModel });
          } else {
            message = t('app.quota_exceeded_generic_free', '⚡ You have reached your daily quota limit.\n⚡ Automatically switching from {model} to {fallback} for the remainder of this session.\n⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist\n⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key\n⚡ You can switch authentication methods by typing /auth', { model: currentModel, fallback: fallbackModel });
          }
        } else {
          if (isPaidTier) {
            // Default fallback message for other cases (like consecutive 429s)
            message = t('app.fallback_default_paid', '⚡ Automatically switching from {model} to {fallback} for faster responses for the remainder of this session.\n⚡ Possible reasons for this are that you have received multiple consecutive capacity errors or you have reached your daily {model} quota limit\n⚡ To continue accessing the {model} model today, consider using /auth to switch to using a paid API key from AI Studio at https://aistudio.google.com/apikey', { model: currentModel, fallback: fallbackModel });
          } else {
            // Default fallback message for other cases (like consecutive 429s)
            message = t('app.fallback_default_free', '⚡ Automatically switching from {model} to {fallback} for faster responses for the remainder of this session.\n⚡ Possible reasons for this are that you have received multiple consecutive capacity errors or you have reached your daily {model} quota limit\n⚡ To increase your limits, upgrade to a Gemini Code Assist Standard or Enterprise plan with higher limits at https://goo.gle/set-up-gemini-code-assist\n⚡ Or you can utilize a Gemini API Key. See: https://goo.gle/gemini-cli-docs-auth#gemini-api-key\n⚡ You can switch authentication methods by typing /auth', { model: currentModel, fallback: fallbackModel });
          }
        }

        // Add message to UI history
        addItem(
          {
            type: MessageType.INFO,
            text: message,
          },
          Date.now(),
        );

        // Set the flag to prevent tool continuation
        setModelSwitchedFromQuotaError(true);
        // Set global quota error flag to prevent Flash model calls
        config.setQuotaErrorOccurred(true);
      }

      // Switch model for future use but return false to stop current retry
      config.setModel(fallbackModel);
      config.setFallbackMode(true);
      logFlashFallback(
        config,
        new FlashFallbackEvent(config.getContentGeneratorConfig().authType!),
      );
      return false; // Don't continue with current prompt
    };

    config.setFlashFallbackHandler(flashFallbackHandler);
  }, [config, addItem, userTier]);

  // Terminal and UI setup
  const { rows: terminalHeight, columns: terminalWidth } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const isInitialMount = useRef(true);

  const widthFraction = 0.9;
  const inputWidth = Math.max(
    20,
    Math.floor(terminalWidth * widthFraction) - 3,
  );
  const suggestionsWidth = Math.max(60, Math.floor(terminalWidth * 0.8));

  // Utility callbacks
  const isValidPath = useCallback((filePath: string): boolean => {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_e) {
      return false;
    }
  }, []);

  const getPreferredEditor = useCallback(() => {
    const editorType = settings.merged.preferredEditor;
    const isValidEditor = isEditorAvailable(editorType);
    if (!isValidEditor) {
      openEditorDialog();
      return;
    }
    return editorType as EditorType;
  }, [settings, openEditorDialog]);

  const onAuthError = useCallback(() => {
    setAuthError(t('app.reauth_required', 'reauth required'));
    openAuthDialog();
  }, [openAuthDialog, setAuthError]);

  // Core hooks and processors
  const {
    vimEnabled: vimModeEnabled,
    vimMode,
    toggleVimEnabled,
  } = useVimMode();

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
    shellConfirmationRequest,
  } = useSlashCommandProcessor(
    config,
    settings,
    addItem,
    clearItems,
    loadHistory,
    refreshStatic,
    setDebugMessage,
    openThemeDialog,
    openAuthDialog,
    openEditorDialog,
    openLanguageDialog,
    toggleCorgiMode,
    setQuittingMessages,
    openPrivacyNotice,
    toggleVimEnabled,
    setIsProcessing,
    setGeminiMdFileCount,
  );

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath,
    shellModeActive,
  });

  const [userMessages, setUserMessages] = useState<string[]>([]);

  const handleUserCancel = useCallback(() => {
    const lastUserMessage = userMessages.at(-1);
    if (lastUserMessage) {
      buffer.setText(lastUserMessage);
    }
  }, [buffer, userMessages]);

  const {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems: pendingGeminiHistoryItems,
    thought,
    triggerAbort,
  } = useGeminiStream(
    config.getGeminiClient(),
    history,
    addItem,
    config,
    setDebugMessage,
    handleSlashCommand,
    shellModeActive,
    getPreferredEditor,
    onAuthError,
    performMemoryRefresh,
    modelSwitchedFromQuotaError,
    setModelSwitchedFromQuotaError,
    refreshStatic,
    handleUserCancel,
  );

  // Input handling
  const handleFinalSubmit = useCallback(
    (submittedValue: string) => {
      const trimmedValue = submittedValue.trim();
      if (trimmedValue.length > 0) {
        submitQuery(trimmedValue);
      }
    },
    [submitQuery],
  );

  const handleIdePromptComplete = useCallback(
    (result: IdeIntegrationNudgeResult) => {
      if (result === 'yes') {
        handleSlashCommand('/ide install');
        settings.setValue(
          SettingScope.User,
          'hasSeenIdeIntegrationNudge',
          true,
        );
      } else if (result === 'dismiss') {
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

  const { handleInput: vimHandleInput } = useVim(buffer, handleFinalSubmit);
  const pendingHistoryItems = [...pendingSlashCommandHistoryItems];
  pendingHistoryItems.push(...pendingGeminiHistoryItems);

  const { elapsedTime, currentLoadingPhrase } =
    useLoadingIndicator(streamingState);
  const showAutoAcceptIndicator = useAutoAcceptIndicator({ config });

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
        // Directly invoke the central command handler.
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

  useInput((input: string, key: InkKeyType) => {
    let enteringConstrainHeightMode = false;
    if (!constrainHeight) {
      // Automatically re-enter constrain height mode if the user types
      // anything. When constrainHeight==false, the user will experience
      // significant flickering so it is best to disable it immediately when
      // the user starts interacting with the app.
      enteringConstrainHeightMode = true;
      setConstrainHeight(true);
    }

    if (key.ctrl && input === 'o') {
      setShowErrorDetails((prev) => !prev);
    } else if (key.ctrl && input === 't') {
      const newValue = !showToolDescriptions;
      setShowToolDescriptions(newValue);

      const mcpServers = config.getMcpServers();
      if (Object.keys(mcpServers || {}).length > 0) {
        handleSlashCommand(newValue ? '/mcp desc' : '/mcp nodesc');
      }
    } else if (
      key.ctrl &&
      input === 'e' &&
      config.getIdeMode() &&
      ideContextState
    ) {
      setShowIDEContextDetail((prev) => !prev);
    } else if (key.ctrl && (input === 'c' || input === 'C')) {
      if (isAuthenticating) {
        // Let AuthInProgress component handle the input.
        return;
      }
      handleExit(ctrlCPressedOnce, setCtrlCPressedOnce, ctrlCTimerRef);
    } else if (key.ctrl && (input === 'd' || input === 'D')) {
      if (buffer.text.length > 0) {
        // Do nothing if there is text in the input.
        return;
      }
      handleExit(ctrlDPressedOnce, setCtrlDPressedOnce, ctrlDTimerRef);
    } else if (key.ctrl && input === 's' && !enteringConstrainHeightMode) {
      setConstrainHeight(false);
    }
  });

  useEffect(() => {
    if (config) {
      setGeminiMdFileCount(config.getGeminiMdFileCount());
    }
  }, [config, config.getGeminiMdFileCount]);

  // WEB_INTERFACE_START: Web interface integration - submitQuery registration and abort handler
  // Store current submitQuery in ref for web interface
  const submitQueryRef = useRef(submitQuery);
  useEffect(() => {
    submitQueryRef.current = submitQuery;
  }, [submitQuery]);

  // Create a completely stable function that will never change
  const stableWebSubmitQuery = useCallback((query: string) => {
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
  const webInterface = useWebInterface();
  useEffect(() => {
    if (webInterface?.service && triggerAbort) {
      webInterface.service.setAbortHandler(triggerAbort);
    }
  }, [webInterface?.service, triggerAbort]);
  // WEB_INTERFACE_END

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

  // WEB_INTERFACE_START: Web interface broadcasting - footer, loading state, commands, MCP servers, console messages, CLI action required, startup message, and tool confirmations
  // Broadcast footer data to web interface (moved from FooterContext to avoid circular deps)
  const footerContext = useFooter();
  useEffect(() => {
    if (footerContext?.footerData && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastFooterData(footerContext.footerData);
    }
  }, [footerContext?.footerData]); // Only depend on footerData, not webInterface

  // Broadcast loading state to web interface (moved from LoadingStateContext to avoid circular deps)
  const loadingStateContext = useLoadingState();
  useEffect(() => {
    if (loadingStateContext?.loadingState && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastLoadingState(loadingStateContext.loadingState);
    }
  }, [loadingStateContext?.loadingState]); // Only depend on loadingState, not webInterface

  // Broadcast slash commands to web interface when commands are loaded or web interface connects
  useEffect(() => {
    if (slashCommands && slashCommands.length > 0 && webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastSlashCommands(slashCommands);
    }
  }, [slashCommands?.length, webInterface?.isRunning]); // Only depend on length and running status

  // Broadcast MCP servers to web interface when web interface connects
  useEffect(() => {
    const broadcastMCPData = async () => {
      if (webInterface?.service && webInterface.isRunning) {
        const mcpServers = config.getMcpServers() || {};
        const blockedMcpServers = config.getBlockedMcpServers() || [];
        
        // Get actual server statuses from the MCP client
        const actualServerStatuses = getAllMCPServerStatuses();
        const serverStatuses = new Map<string, string>();
        
        // Convert MCPServerStatus enum values to strings
        for (const [serverName, status] of actualServerStatuses) {
          serverStatuses.set(serverName, status as string);
        }
        
        // Get actual tools from the tool registry
        const serverTools = new Map<string, DiscoveredMCPTool[]>();
        try {
          const toolRegistry = await config.getToolRegistry();
          for (const serverName of Object.keys(mcpServers)) {
            const tools = toolRegistry.getToolsByServer(serverName);
            // Filter to only DiscoveredMCPTool instances
            const mcpTools = tools.filter(tool => tool instanceof DiscoveredMCPTool) as DiscoveredMCPTool[];
            serverTools.set(serverName, mcpTools);
          }
        } catch (error) {
          console.error('Error getting tool registry:', error);
        }
        
        webInterface.service.broadcastMCPServers(
          mcpServers,
          blockedMcpServers,
          serverTools,
          serverStatuses
        );
      }
    };
    
    broadcastMCPData();
  }, [webInterface?.isRunning]); // Broadcast when web interface is ready

  // Broadcast console messages to web interface when they change
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      // Apply same filtering logic as CLI debug console
      const messagesToBroadcast = config.getDebugMode() 
        ? consoleMessages 
        : consoleMessages.filter((msg) => msg.type !== 'debug');
      
      webInterface.service.broadcastConsoleMessages(messagesToBroadcast);
    }
  }, [consoleMessages, webInterface?.isRunning, config]); // Depend on console messages and debug mode

  // Broadcast CLI action required state when interactive screens are shown
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      let reason = '';
      let message = '';
      
      // Check for any active dialog/screen
      if (isAuthDialogOpen || isAuthenticating) {
        reason = 'authentication';
        message = isAuthenticating 
          ? t('web.cli_action.auth_in_progress', 'Authentication is in progress. Please check the CLI terminal.')
          : t('web.cli_action.auth_required', 'Authentication is required. Please complete the authentication process in the CLI terminal.');
      } else if (isThemeDialogOpen) {
        reason = 'theme_selection';
        message = t('web.cli_action.theme_selection', 'Theme selection is open. Please choose a theme in the CLI terminal.');
      } else if (isEditorDialogOpen) {
        reason = 'editor_settings';
        message = t('web.cli_action.editor_settings', 'Editor settings are open. Please configure your editor in the CLI terminal.');
      } else if (isLanguageDialogOpen) {
        reason = 'language_selection';
        message = t('web.cli_action.language_selection', 'Language selection is open. Please choose a language in the CLI terminal.');
      } else if (showPrivacyNotice) {
        reason = 'privacy_notice';
        message = t('web.cli_action.privacy_notice', 'Privacy notice is displayed. Please review it in the CLI terminal.');
      }
      
      const isActionRequired = !!reason;
      
      if (isActionRequired) {
        const title = t('web.cli_action.title', 'CLI Action Required');
        webInterface.service.broadcastCliActionRequired(true, reason, title, message);
      } else {
        // Clear the action required state when all dialogs are closed
        webInterface.service.broadcastCliActionRequired(false);
      }
    }
  }, [
    isAuthDialogOpen, 
    isAuthenticating, 
    isThemeDialogOpen,
    isEditorDialogOpen,
    isLanguageDialogOpen,
    showPrivacyNotice,
    webInterface?.isRunning
  ]); // Monitor all interactive screen states

  // Web interface startup message for --web flag
  const webStartupShownRef = useRef(false);
  useEffect(() => {
    if (webEnabled && webInterface?.isRunning && webInterface?.port && !webStartupShownRef.current) {
      webStartupShownRef.current = true;
      addItem(
        {
          type: 'info',
          text: t('commands.web.available_at', '🌐 Web interface available at http://localhost:{port}', { port: webInterface.port.toString() }),
        },
        Date.now(),
      );
    }
  }, [webEnabled, webInterface?.isRunning, webInterface?.port, addItem]);

  // Handle tool confirmations for web interface (moved from ToolConfirmationContext to avoid circular deps)
  const toolConfirmationContext = useToolConfirmation();
  useEffect(() => {
    if (toolConfirmationContext && webInterface?.service) {
      // Set up the confirmation response handler
      webInterface.service?.setConfirmationResponseHandler(
        toolConfirmationContext.handleConfirmationResponse
      );
    }
  }, [toolConfirmationContext, webInterface?.service]);

  // Broadcast new tool confirmations to web interface
  const prevConfirmationsRef = useRef<PendingToolConfirmation[]>([]);
  useEffect(() => {
    if (toolConfirmationContext?.pendingConfirmations && webInterface?.service && webInterface.isRunning) {
      const prevConfirmations = prevConfirmationsRef.current || [];
      const currentConfirmations = toolConfirmationContext.pendingConfirmations;
      
      // Only broadcast new confirmations that weren't in the previous list
      const newConfirmations = currentConfirmations.filter(current => 
        !prevConfirmations.some(prev => prev.callId === current.callId)
      );
      
      newConfirmations.forEach(confirmation => {
        webInterface.service?.broadcastToolConfirmation(confirmation);
      });
      
      // Also broadcast removals for confirmations that were removed
      const removedConfirmations = prevConfirmations.filter(prev => 
        !currentConfirmations.some(current => current.callId === prev.callId)
      );
      
      removedConfirmations.forEach(removedConfirmation => {
        webInterface.service?.broadcastToolConfirmationRemoval(removedConfirmation.callId);
      });
      
      prevConfirmationsRef.current = currentConfirmations;
    }
  }, [toolConfirmationContext?.pendingConfirmations]); // Only depend on pendingConfirmations
  // WEB_INTERFACE_END
  const logger = useLogger();

  useEffect(() => {
    const fetchUserMessages = async () => {
      const pastMessagesRaw = (await logger?.getPreviousUserMessages()) || []; // Newest first

      const currentSessionUserMessages = history
        .filter(
          (item): item is HistoryItem & { type: 'user'; text: string } =>
            item.type === 'user' &&
            typeof item.text === 'string' &&
            item.text.trim() !== '',
        )
        .map((item) => item.text)
        .reverse(); // Newest first, to match pastMessagesRaw sorting

      // Combine, with current session messages being more recent
      const combinedMessages = [
        ...currentSessionUserMessages,
        ...pastMessagesRaw,
      ];

      // Deduplicate consecutive identical messages from the combined list (still newest first)
      const deduplicatedMessages: string[] = [];
      if (combinedMessages.length > 0) {
        deduplicatedMessages.push(combinedMessages[0]); // Add the newest one unconditionally
        for (let i = 1; i < combinedMessages.length; i++) {
          if (combinedMessages[i] !== combinedMessages[i - 1]) {
            deduplicatedMessages.push(combinedMessages[i]);
          }
        }
      }
      // Reverse to oldest first for useInputHistory
      setUserMessages(deduplicatedMessages.reverse());
    };
    fetchUserMessages();
  }, [history, logger]);

  const isInputActive =
    streamingState === StreamingState.Idle && !initError && !isProcessing;

  const handleClearScreen = useCallback(() => {
    clearItems();
    clearConsoleMessagesState();
    console.clear();
    refreshStatic();
  }, [clearItems, clearConsoleMessagesState, refreshStatic]);

  const mainControlsRef = useRef<DOMElement>(null);
  const pendingHistoryItemRef = useRef<DOMElement>(null);

  useEffect(() => {
    if (mainControlsRef.current) {
      const fullFooterMeasurement = measureElement(mainControlsRef.current);
      setFooterHeight(fullFooterMeasurement.height);
    }
  }, [terminalHeight, consoleMessages, showErrorDetails]);

  const staticExtraHeight = /* margins and padding */ 3;
  const availableTerminalHeight = useMemo(
    () => terminalHeight - footerHeight - staticExtraHeight,
    [terminalHeight, footerHeight],
  );

  useEffect(() => {
    // skip refreshing Static during first mount
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // debounce so it doesn't fire up too often during resize
    const handler = setTimeout(() => {
      setStaticNeedsRefresh(false);
      refreshStatic();
    }, 300);

    return () => {
      clearTimeout(handler);
    };
  }, [terminalWidth, terminalHeight, refreshStatic]);

  useEffect(() => {
    if (streamingState === StreamingState.Idle && staticNeedsRefresh) {
      setStaticNeedsRefresh(false);
      refreshStatic();
    }
  }, [streamingState, refreshStatic, staticNeedsRefresh]);

  const filteredConsoleMessages = useMemo(() => {
    if (config.getDebugMode()) {
      return consoleMessages;
    }
    return consoleMessages.filter((msg) => msg.type !== 'debug');
  }, [consoleMessages, config]);

  const branchName = useGitBranchName(config.getTargetDir());

  const contextFileNames = useMemo(() => {
    const fromSettings = settings.merged.contextFileName;
    if (fromSettings) {
      return Array.isArray(fromSettings) ? fromSettings : [fromSettings];
    }
    return getAllGeminiMdFilenames();
  }, [settings.merged.contextFileName]);

  const initialPrompt = useMemo(() => config.getQuestion(), [config]);
  const geminiClient = config.getGeminiClient();

  useEffect(() => {
    if (
      initialPrompt &&
      !initialPromptSubmitted.current &&
      !isAuthenticating &&
      !isAuthDialogOpen &&
      !isThemeDialogOpen &&
      !isEditorDialogOpen &&
      !showPrivacyNotice &&
      geminiClient?.isInitialized?.()
    ) {
      submitQuery(initialPrompt);
      initialPromptSubmitted.current = true;
    }
  }, [
    initialPrompt,
    submitQuery,
    isAuthenticating,
    isAuthDialogOpen,
    isThemeDialogOpen,
    isEditorDialogOpen,
    showPrivacyNotice,
    geminiClient,
  ]);

  if (quittingMessages) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {quittingMessages.map((item) => (
          <HistoryItemDisplay
            key={item.id}
            availableTerminalHeight={
              constrainHeight ? availableTerminalHeight : undefined
            }
            terminalWidth={terminalWidth}
            item={item}
            isPending={false}
            config={config}
          />
        ))}
      </Box>
    );
  }

  const mainAreaWidth = Math.floor(terminalWidth * 0.9);
  const debugConsoleMaxHeight = Math.floor(Math.max(terminalHeight * 0.2, 5));
  // Arbitrary threshold to ensure that items in the static area are large
  // enough but not too large to make the terminal hard to use.
  const staticAreaMaxItemHeight = Math.max(terminalHeight * 4, 100);
  const placeholder = vimModeEnabled
    ? "  Press 'i' for INSERT mode and 'Esc' for NORMAL mode."
    : '  Type your message or @path/to/file';

  return (
    <StreamingContext.Provider value={streamingState}>
      <Box flexDirection="column" width="90%">
        {/*
         * The Static component is an Ink intrinsic in which there can only be 1 per application.
         * Because of this restriction we're hacking it slightly by having a 'header' item here to
         * ensure that it's statically rendered.
         *
         * Background on the Static Item: Anything in the Static component is written a single time
         * to the console. Think of it like doing a console.log and then never using ANSI codes to
         * clear that content ever again. Effectively it has a moving frame that every time new static
         * content is set it'll flush content to the terminal and move the area which it's "clearing"
         * down a notch. Without Static the area which gets erased and redrawn continuously grows.
         */}
        <Static
          key={staticKey}
          items={[
            <Box flexDirection="column" key="header">
              {!settings.merged.hideBanner && (
                <Header
                  terminalWidth={terminalWidth}
                  version={version}
                  nightly={nightly}
                />
              )}
              {!settings.merged.hideTips && <Tips config={config} />}
            </Box>,
            ...history.map((h) => (
              <HistoryItemDisplay
                terminalWidth={mainAreaWidth}
                availableTerminalHeight={staticAreaMaxItemHeight}
                key={h.id}
                item={h}
                isPending={false}
                config={config}
                commands={slashCommands}
              />
            )),
          ]}
        >
          {(item) => item}
        </Static>
        <OverflowProvider>
          <Box ref={pendingHistoryItemRef} flexDirection="column">
            {pendingHistoryItems.map((item, i) => (
              <HistoryItemDisplay
                key={i}
                availableTerminalHeight={
                  constrainHeight ? availableTerminalHeight : undefined
                }
                terminalWidth={mainAreaWidth}
                // TODO(taehykim): It seems like references to ids aren't necessary in
                // HistoryItemDisplay. Refactor later. Use a fake id for now.
                item={{ ...item, id: 0 }}
                isPending={true}
                config={config}
                isFocused={!isEditorDialogOpen}
              />
            ))}
            <ShowMoreLines constrainHeight={constrainHeight} />
          </Box>
        </OverflowProvider>

        <Box flexDirection="column" ref={mainControlsRef}>
          {/* Move UpdateNotification to render update notification above input area */}
          {updateInfo && <UpdateNotification message={updateInfo.message} />}
          {startupWarnings.length > 0 && (
            <Box
              borderStyle="round"
              borderColor={Colors.AccentYellow}
              paddingX={1}
              marginY={1}
              flexDirection="column"
            >
              {startupWarnings.map((warning, index) => (
                <Text key={index} color={Colors.AccentYellow}>
                  {warning}
                </Text>
              ))}
            </Box>
          )}

          {shouldShowIdePrompt ? (
            <IdeIntegrationNudge
              question={t('ide_integration_nudge.question', 'Do you want to connect your VS Code editor to Auditaria CLI?')}
              description={t('ide_integration_nudge.description', "If you select Yes, we'll install an extension that allows the CLI to access your open files and display diffs directly in VS Code.")}
              onComplete={handleIdePromptComplete}
            />
          ) : isLanguageDialogOpen ? (
            <Box flexDirection="column">
              {languageError && (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{languageError}</Text>
                </Box>
              )}
              <LanguageSelectionDialog
                onSelect={handleLanguageSelect}
                settings={settings}
                isFirstTimeSetup={isFirstTimeSetup}
              />
            </Box>
          ) : shellConfirmationRequest ? (
            <ShellConfirmationDialog request={shellConfirmationRequest} />
          ) : isThemeDialogOpen ? (
            <Box flexDirection="column">
              {themeError && (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{themeError}</Text>
                </Box>
              )}
              <ThemeDialog
                onSelect={handleThemeSelect}
                onHighlight={handleThemeHighlight}
                settings={settings}
                availableTerminalHeight={
                  constrainHeight
                    ? terminalHeight - staticExtraHeight
                    : undefined
                }
                terminalWidth={mainAreaWidth}
              />
            </Box>
          ) : isAuthenticating ? (
            <>
              <AuthInProgress
                onTimeout={() => {
                  setAuthError(t('app.auth_timeout', 'Authentication timed out. Please try again.'));
                  cancelAuthentication();
                  openAuthDialog();
                }}
              />
              {showErrorDetails && (
                <OverflowProvider>
                  <Box flexDirection="column">
                    <DetailedMessagesDisplay
                      messages={filteredConsoleMessages}
                      maxHeight={
                        constrainHeight ? debugConsoleMaxHeight : undefined
                      }
                      width={inputWidth}
                    />
                    <ShowMoreLines constrainHeight={constrainHeight} />
                  </Box>
                </OverflowProvider>
              )}
            </>
          ) : isAuthDialogOpen ? (
            <Box flexDirection="column">
              <AuthDialog
                onSelect={handleAuthSelect}
                settings={settings}
                initialErrorMessage={authError}
              />
            </Box>
          ) : isEditorDialogOpen ? (
            <Box flexDirection="column">
              {editorError && (
                <Box marginBottom={1}>
                  <Text color={Colors.AccentRed}>{editorError}</Text>
                </Box>
              )}
              <EditorSettingsDialog
                onSelect={handleEditorSelect}
                settings={settings}
                onExit={exitEditorDialog}
              />
            </Box>
          ) : showPrivacyNotice ? (
            <PrivacyNotice
              onExit={() => setShowPrivacyNotice(false)}
              config={config}
            />
          ) : (
            <>
              <LoadingIndicator
                thought={
                  streamingState === StreamingState.WaitingForConfirmation ||
                  config.getAccessibility()?.disableLoadingPhrases
                    ? undefined
                    : thought
                }
                currentLoadingPhrase={
                  config.getAccessibility()?.disableLoadingPhrases
                    ? undefined
                    : currentLoadingPhrase
                }
                elapsedTime={elapsedTime}
              />

              <Box
                marginTop={1}
                display="flex"
                justifyContent="space-between"
                width="100%"
              >
                <Box>
                  {process.env.GEMINI_SYSTEM_MD && (
                    <Text color={Colors.AccentRed}>|⌐■_■| </Text>
                  )}
                  {ctrlCPressedOnce ? (
                    <Text color={Colors.AccentYellow}>
                      {t('app.press_ctrl_c_exit', 'Press Ctrl+C again to exit.')}
                    </Text>
                  ) : ctrlDPressedOnce ? (
                    <Text color={Colors.AccentYellow}>
                      {t('app.press_ctrl_d_exit', 'Press Ctrl+D again to exit.')}
                    </Text>
                  ) : (
                    <ContextSummaryDisplay
                      ideContext={ideContextState}
                      geminiMdFileCount={geminiMdFileCount}
                      contextFileNames={contextFileNames}
                      mcpServers={config.getMcpServers()}
                      blockedMcpServers={config.getBlockedMcpServers()}
                      showToolDescriptions={showToolDescriptions}
                    />
                  )}
                </Box>
                <Box>
                  {showAutoAcceptIndicator !== ApprovalMode.DEFAULT &&
                    !shellModeActive && (
                      <AutoAcceptIndicator
                        approvalMode={showAutoAcceptIndicator}
                      />
                    )}
                  {shellModeActive && <ShellModeIndicator />}
                </Box>
              </Box>
              {showIDEContextDetail && (
                <IDEContextDetailDisplay
                  ideContext={ideContextState}
                  detectedIdeDisplay={config
                    .getIdeClient()
                    .getDetectedIdeDisplayName()}
                />
              )}
              {showErrorDetails && (
                <OverflowProvider>
                  <Box flexDirection="column">
                    <DetailedMessagesDisplay
                      messages={filteredConsoleMessages}
                      maxHeight={
                        constrainHeight ? debugConsoleMaxHeight : undefined
                      }
                      width={inputWidth}
                    />
                    <ShowMoreLines constrainHeight={constrainHeight} />
                  </Box>
                </OverflowProvider>
              )}

              {isInputActive && (
                <InputPrompt
                  buffer={buffer}
                  inputWidth={inputWidth}
                  suggestionsWidth={suggestionsWidth}
                  onSubmit={handleFinalSubmit}
                  userMessages={userMessages}
                  onClearScreen={handleClearScreen}
                  config={config}
                  slashCommands={slashCommands}
                  commandContext={commandContext}
                  shellModeActive={shellModeActive}
                  setShellModeActive={setShellModeActive}
                  focus={isFocused}
                />
              )}
            </>
          )}

          {initError && streamingState !== StreamingState.Responding && (
            <Box
              borderStyle="round"
              borderColor={Colors.AccentRed}
              paddingX={1}
              marginBottom={1}
            >
              {history.find(
                (item) =>
                  item.type === 'error' && item.text?.includes(initError),
              )?.text ? (
                <Text color={Colors.AccentRed}>
                  {
                    history.find(
                      (item) =>
                        item.type === 'error' && item.text?.includes(initError),
                    )?.text
                  }
                </Text>
              ) : (
                <>
                  <Text color={Colors.AccentRed}>
                    {t('app.initialization_error', 'Initialization Error: {error}', { error: initError })}
                  </Text>
                  <Text color={Colors.AccentRed}>
                    {' '}
                    {t('app.check_api_config', 'Please check API key and configuration.')}
                  </Text>
                </>
              )}
            </Box>
          )}
          <Footer
            model={currentModel}
            targetDir={config.getTargetDir()}
            debugMode={config.getDebugMode()}
            branchName={branchName}
            debugMessage={debugMessage}
            corgiMode={corgiMode}
            errorCount={errorCount}
            showErrorDetails={showErrorDetails}
            showMemoryUsage={
              config.getDebugMode() || config.getShowMemoryUsage()
            }
            promptTokenCount={sessionStats.lastPromptTokenCount}
            nightly={nightly}
          />
        </Box>
      </Box>
    </StreamingContext.Provider>
  );
};