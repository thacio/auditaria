/**
 * @license
 * Copyright 2026 Google LLC
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
import {
  type DOMElement,
  measureElement,
  useApp,
  useStdout,
  useStdin,
  type AppProps,
} from 'ink';
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
  type HistoryItemWithoutId,
  type HistoryItemToolGroup,
  AuthState,
  StreamingState,
  MessageType,
  type ConfirmationRequest,
  type PermissionConfirmationRequest,
  type QuotaStats,
} from './types.js';
import { checkPermissions } from './hooks/atCommandProcessor.js';
import { ToolActionsProvider } from './contexts/ToolActionsContext.js';
import {
  type StartupWarning,
  type EditorType,
  type Config,
  type IdeInfo,
  type IdeContext,
  type UserTierId,
  type UserFeedbackPayload,
  type AgentDefinition,
  type ApprovalMode,
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
  flattenMemory,
  type MemoryChangedPayload,
  writeToStdout,
  disableMouseEvents,
  enterAlternateScreen,
  enableMouseEvents,
  disableLineWrapping,
  shouldEnterAlternateScreen,
  startupProfiler,
  SessionStartSource,
  SessionEndReason,
  generateSummary,
  type ConsentRequestPayload,
  type AgentsDiscoveredPayload,
  ChangeAuthRequestedError,
  CoreToolCallStatus,
  type CodexReasoningEffort, // AUDITARIA_PROVIDER and WEB
  getSupportedCodexReasoningEfforts, // AUDITARIA_PROVIDER and WEB
  clampCodexReasoningEffortForModel, // AUDITARIA_PROVIDER and WEB
  generateSteeringAckMessage,
  buildUserSteeringHintPrompt,
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
import { calculateMainAreaWidth } from './utils/ui-sizing.js';
import ansiEscapes from 'ansi-escapes';
import { basename } from 'node:path';
import { computeTerminalTitle } from '../utils/windowTitle.js';
import { useTextBuffer } from './components/shared/text-buffer.js';
import { useLogger } from './hooks/useLogger.js';
import { useGeminiStream } from './hooks/useGeminiStream.js';
import { type BackgroundShell } from './hooks/shellCommandProcessor.js';
import { useVim } from './hooks/vim.js';
import { type LoadableSettingScope, SettingScope } from '../config/settings.js';
import { type InitializationResult } from '../core/initializer.js';
import { useFocus } from './hooks/useFocus.js';
import { useKeypress, type Key } from './hooks/useKeypress.js';
import {
  KeypressPriority,
  useKeypressContext,
} from './contexts/KeypressContext.js';
import { keyMatchers, Command } from './keyMatchers.js';
import { useLoadingIndicator } from './hooks/useLoadingIndicator.js';
import { useShellInactivityStatus } from './hooks/useShellInactivityStatus.js';
import { useFolderTrust } from './hooks/useFolderTrust.js';
import { useIdeTrustListener } from './hooks/useIdeTrustListener.js';
import { type IdeIntegrationNudgeResult } from './IdeIntegrationNudge.js';
import { appEvents, AppEvent, TransientMessageType } from '../utils/events.js';
import { type UpdateObject } from './utils/updateCheck.js';
import { setUpdateHandler } from '../utils/handleAutoUpdate.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';
import { RELAUNCH_EXIT_CODE } from '../utils/processUtils.js';
import type { SessionInfo } from '../utils/sessionUtils.js';
import { useMessageQueue } from './hooks/useMessageQueue.js';
import { useMcpStatus } from './hooks/useMcpStatus.js';
import {
  CLAUDE_PREFIX,
  CODEX_PREFIX,
  CLAUDE_SUBMENU_OPTIONS,
  CODEX_SUBMENU_OPTIONS,
  DEFAULT_CODEX_REASONING_EFFORT,
  CODEX_REASONING_OPTIONS,
  getGeminiWebOptions,
  isCodexReasoningEffort,
} from './modelCatalog.js';
import { useApprovalModeIndicator } from './hooks/useApprovalModeIndicator.js';
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
import { useSessionRetentionCheck } from './hooks/useSessionRetentionCheck.js';
import { isWorkspaceTrusted } from '../config/trustedFolders.js';
import { useAlternateBuffer } from './hooks/useAlternateBuffer.js';
import { useSettings } from './contexts/SettingsContext.js';
import { terminalCapabilityManager } from './utils/terminalCapabilityManager.js';
import { useInputHistoryStore } from './hooks/useInputHistoryStore.js';
import { useBanner } from './hooks/useBanner.js';
import { useHookDisplayState } from './hooks/useHookDisplayState.js';
import { useBackgroundShellManager } from './hooks/useBackgroundShellManager.js';
import {
  WARNING_PROMPT_DURATION_MS,
  QUEUE_ERROR_DISPLAY_DURATION_MS,
} from './constants.js';
import { LoginWithGoogleRestartDialog } from './auth/LoginWithGoogleRestartDialog.js';
import { NewAgentsChoice } from './components/NewAgentsNotification.js';
import { isSlashCommand } from './utils/commandUtils.js';
import { useTerminalTheme } from './hooks/useTerminalTheme.js';
import { useTimedMessage } from './hooks/useTimedMessage.js';
import { shouldDismissShortcutsHelpOnHotkey } from './utils/shortcutsHelp.js';
import { useSuspend } from './hooks/useSuspend.js';
import { useRunEventNotifications } from './hooks/useRunEventNotifications.js';
import { isNotificationsEnabled } from '../utils/terminalNotifications.js';

function isToolExecuting(pendingHistoryItems: HistoryItemWithoutId[]) {
  return pendingHistoryItems.some((item) => {
    if (item && item.type === 'tool_group') {
      return item.tools.some(
        (tool) => CoreToolCallStatus.Executing === tool.status,
      );
    }
    return false;
  });
}

function isToolAwaitingConfirmation(
  pendingHistoryItems: HistoryItemWithoutId[],
) {
  return pendingHistoryItems
    .filter((item): item is HistoryItemToolGroup => item.type === 'tool_group')
    .some((item) =>
      item.tools.some(
        (tool) => CoreToolCallStatus.AwaitingApproval === tool.status,
      ),
    );
}

interface AppContainerProps {
  config: Config;
  startupWarnings?: StartupWarning[];
  version: string;
  initializationResult: InitializationResult;
  resumedSessionData?: ResumedSessionData;
  webEnabled?: boolean;
}

import { useRepeatedKeyPress } from './hooks/useRepeatedKeyPress.js';
import {
  useVisibilityToggle,
  APPROVAL_MODE_REVEAL_DURATION_MS,
} from './hooks/useVisibilityToggle.js';

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
  const {
    config,
    initializationResult,
    resumedSessionData,
    webEnabled = false,
  } = props;
  const settings = useSettings();
  const notificationsEnabled = isNotificationsEnabled(settings);

  const historyManager = useHistory({
    chatRecordingService: config.getGeminiClient()?.getChatRecordingService(),
  });

  useMemoryMonitor(historyManager);
  const isAlternateBuffer = useAlternateBuffer();
  const [corgiMode, setCorgiMode] = useState(false);
  const [forceRerenderKey, setForceRerenderKey] = useState(0);
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
  const toggleBackgroundShellRef = useRef<() => void>(() => {});
  const isBackgroundShellVisibleRef = useRef<boolean>(false);
  const backgroundShellsRef = useRef<Map<number, BackgroundShell>>(new Map());
  const webAvailabilityMessageShownRef = useRef(false);

  const [adminSettingsChanged, setAdminSettingsChanged] = useState(false);

  const [shellModeActive, setShellModeActive] = useState(false);
  const [modelSwitchedFromQuotaError, setModelSwitchedFromQuotaError] =
    useState<boolean>(false);
  const [historyRemountKey, setHistoryRemountKey] = useState(0);
  const [mcpClientUpdateCounter, setMcpClientUpdateCounter] = useState(0); // WEB_INTERFACE_START: Track MCP client updates for web sync
  const [settingsNonce, setSettingsNonce] = useState(0);
  const activeHooks = useHookDisplayState();
  const [updateInfo, setUpdateInfo] = useState<UpdateObject | null>(null);
  const [isTrustedFolder, setIsTrustedFolder] = useState<boolean | undefined>(
    () => isWorkspaceTrusted(settings.merged).isTrusted,
  );

  const [queueErrorMessage, setQueueErrorMessage] = useState<string | null>(
    null,
  );

  const [newAgents, setNewAgents] = useState<AgentDefinition[] | null>(null);

  const [defaultBannerText, setDefaultBannerText] = useState('');
  const [warningBannerText, setWarningBannerText] = useState('');
  const [bannerVisible, setBannerVisible] = useState(true);

  const bannerData = useMemo(
    () => ({
      defaultText: defaultBannerText,
      warningText: warningBannerText,
    }),
    [defaultBannerText, warningBannerText],
  );

  const { bannerText } = useBanner(bannerData);

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
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

  const [isAgentConfigDialogOpen, setIsAgentConfigDialogOpen] = useState(false);
  const [selectedAgentName, setSelectedAgentName] = useState<
    string | undefined
  >();
  const [selectedAgentDisplayName, setSelectedAgentDisplayName] = useState<
    string | undefined
  >();
  const [selectedAgentDefinition, setSelectedAgentDefinition] = useState<
    AgentDefinition | undefined
  >();

  const openAgentConfigDialog = useCallback(
    (name: string, displayName: string, definition: AgentDefinition) => {
      setSelectedAgentName(name);
      setSelectedAgentDisplayName(displayName);
      setSelectedAgentDefinition(definition);
      setIsAgentConfigDialogOpen(true);
    },
    [],
  );

  const closeAgentConfigDialog = useCallback(() => {
    setIsAgentConfigDialogOpen(false);
    setSelectedAgentName(undefined);
    setSelectedAgentDisplayName(undefined);
    setSelectedAgentDefinition(undefined);
  }, []);

  const toggleDebugProfiler = useCallback(
    () => setShowDebugProfiler((prev) => !prev),
    [],
  );

  const [currentModel, setCurrentModel] = useState(config.getDisplayModel()); // AUDITARIA_PROVIDER
  const [modelChangeNonce, setModelChangeNonce] = useState(0); // AUDITARIA_ WEB_INTERFACE: force footer model menu refresh on provider option changes

  const [userTier, setUserTier] = useState<UserTierId | undefined>(undefined);
  const [quotaStats, setQuotaStats] = useState<QuotaStats | undefined>(() => {
    const remaining = config.getQuotaRemaining();
    const limit = config.getQuotaLimit();
    const resetTime = config.getQuotaResetTime();
    return remaining !== undefined ||
      limit !== undefined ||
      resetTime !== undefined
      ? { remaining, limit, resetTime }
      : undefined;
  });

  const [isConfigInitialized, setConfigInitialized] = useState(false);

  const logger = useLogger(config.storage);
  const { inputHistory, addInput, initializeFromLogger } =
    useInputHistoryStore();

  // Terminal and layout hooks
  const { columns: terminalWidth, rows: terminalHeight } = useTerminalSize();
  const { stdin, setRawMode } = useStdin();
  const { stdout } = useStdout();
  const app: AppProps = useApp();

  // Additional hooks moved from App.tsx
  const { stats: sessionStats } = useSessionStats();
  const branchName = useGitBranchName(config.getTargetDir());

  const toolConfirmationContext = useToolConfirmation(); // AUDITARIA: Tool confirmation context (moved earlier to support terminal capture)

  // Layout measurements
  const mainControlsRef = useRef<DOMElement>(null);
  // For performance profiling only
  const rootUiRef = useRef<DOMElement>(null);
  const lastTitleRef = useRef<string | null>(null);
  const staticExtraHeight = 3;

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    (async () => {
      // Note: the program will not work if this fails so let errors be
      // handled by the global catch.
      if (!config.isInitialized()) {
        await config.initialize();
      }
      setConfigInitialized(true);
      startupProfiler.flush(config);

      const sessionStartSource = resumedSessionData
        ? SessionStartSource.Resume
        : SessionStartSource.Startup;
      const result = await config
        .getHookSystem()
        ?.fireSessionStartEvent(sessionStartSource);

      if (result) {
        if (result.systemMessage) {
          historyManager.addItem(
            {
              type: MessageType.INFO,
              text: result.systemMessage,
            },
            Date.now(),
          );
        }

        const additionalContext = result.getAdditionalContext();
        const geminiClient = config.getGeminiClient();
        if (additionalContext && geminiClient) {
          await geminiClient.addHistory({
            role: 'user',
            parts: [
              { text: `<hook_context>${additionalContext}</hook_context>` },
            ],
          });
        }
      }

      // Fire-and-forget: generate summary for previous session in background
      generateSummary(config).catch((e) => {
        debugLogger.warn('Background summary generation failed:', e);
      });
    })();
    registerCleanup(async () => {
      // Turn off mouse scroll.
      disableMouseEvents();

      // Kill all background shells
      for (const pid of backgroundShellsRef.current.keys()) {
        ShellExecutionService.kill(pid);
      }

      const ideClient = await IdeClient.getInstance();
      await ideClient.disconnect();

      // Fire SessionEnd hook on cleanup (only if hooks are enabled)
      await config?.getHookSystem()?.fireSessionEndEvent(SessionEndReason.Exit);
    });
    // Disable the dependencies check here. historyManager gets flagged
    // but we don't want to react to changes to it because each new history
    // item, including the ones from the start session hook will cause a
    // re-render and an error when we try to reload config.
    //
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, resumedSessionData]);

  useEffect(
    () => setUpdateHandler(historyManager.addItem, setUpdateInfo),
    [historyManager.addItem],
  );

  // Subscribe to fallback mode and model changes from core
  useEffect(() => {
    const handleModelChanged = () => {
      // AUDITARIA_CLAUDE_PROVIDER: Use getDisplayModel() to show Claude/Gemini correctly
      setCurrentModel(config.getDisplayModel());
      setModelChangeNonce((prev) => prev + 1); // AUDITARIA_ WEB_INTERFACE
    };

    const handleQuotaChanged = (payload: {
      remaining: number | undefined;
      limit: number | undefined;
      resetTime?: string;
    }) => {
      setQuotaStats({
        remaining: payload.remaining,
        limit: payload.limit,
        resetTime: payload.resetTime,
      });
    };

    coreEvents.on(CoreEvent.ModelChanged, handleModelChanged);
    coreEvents.on(CoreEvent.QuotaChanged, handleQuotaChanged);
    return () => {
      coreEvents.off(CoreEvent.ModelChanged, handleModelChanged);
      coreEvents.off(CoreEvent.QuotaChanged, handleQuotaChanged);
    };
  }, [config]);

  useEffect(() => {
    const handleSettingsChanged = () => {
      setSettingsNonce((prev) => prev + 1);
    };

    const handleAdminSettingsChanged = () => {
      setAdminSettingsChanged(true);
    };

    const handleAgentsDiscovered = (payload: AgentsDiscoveredPayload) => {
      setNewAgents(payload.agents);
    };

    coreEvents.on(CoreEvent.SettingsChanged, handleSettingsChanged);
    coreEvents.on(CoreEvent.AdminSettingsChanged, handleAdminSettingsChanged);
    coreEvents.on(CoreEvent.AgentsDiscovered, handleAgentsDiscovered);
    return () => {
      coreEvents.off(CoreEvent.SettingsChanged, handleSettingsChanged);
      coreEvents.off(
        CoreEvent.AdminSettingsChanged,
        handleAdminSettingsChanged,
      );
      coreEvents.off(CoreEvent.AgentsDiscovered, handleAgentsDiscovered);
    };
  }, [settings]);

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

  const getPreferredEditor = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    () => settings.merged.general.preferredEditor as EditorType,
    [settings.merged.general.preferredEditor],
  );

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 10, width: inputWidth },
    stdin,
    setRawMode,
    escapePastedPaths: true,
    shellModeActive,
    getPreferredEditor,
  });
  const bufferRef = useRef(buffer);
  useEffect(() => {
    bufferRef.current = buffer;
  }, [buffer]);

  const stableSetText = useCallback((text: string) => {
    bufferRef.current.setText(text);
  }, []);

  // Initialize input history from logger (past sessions)
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    initializeFromLogger(logger);
  }, [logger, initializeFromLogger]);

  const refreshStatic = useCallback(() => {
    if (!isAlternateBuffer) {
      stdout.write(ansiEscapes.clearTerminal);
    }
    setHistoryRemountKey((prev) => prev + 1);
  }, [setHistoryRemountKey, isAlternateBuffer, stdout]);

  const shouldUseAlternateScreen = shouldEnterAlternateScreen(
    isAlternateBuffer,
    config.getScreenReader(),
  );

  const handleEditorClose = useCallback(() => {
    if (shouldUseAlternateScreen) {
      // The editor may have exited alternate buffer mode so we need to
      // enter it again to be safe.
      enterAlternateScreen();
      enableMouseEvents();
      disableLineWrapping();
      app.rerender();
    }
    terminalCapabilityManager.enableSupportedModes();
    refreshStatic();
  }, [refreshStatic, shouldUseAlternateScreen, app]);

  const [editorError, setEditorError] = useState<string | null>(null);
  const {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  } = useEditorSettings(settings, setEditorError, historyManager.addItem);

  useEffect(() => {
    coreEvents.on(CoreEvent.ExternalEditorClosed, handleEditorClose);
    coreEvents.on(CoreEvent.RequestEditorSelection, openEditorDialog);
    return () => {
      coreEvents.off(CoreEvent.ExternalEditorClosed, handleEditorClose);
      coreEvents.off(CoreEvent.RequestEditorSelection, openEditorDialog);
    };
  }, [handleEditorClose, openEditorDialog]);

  useEffect(() => {
    if (
      !(settings.merged.ui.hideBanner || config.getScreenReader()) &&
      bannerVisible &&
      bannerText
    ) {
      // The header should show a banner but the Header is rendered in static
      // so we must trigger a static refresh for it to be visible.
      refreshStatic();
    }
  }, [bannerVisible, bannerText, settings, config, refreshStatic]);

  const { isSettingsDialogOpen, openSettingsDialog, closeSettingsDialog } =
    useSettingsCommand();

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
    refreshStatic,
  );
  // Poll for terminal background color changes to auto-switch theme
  useTerminalTheme(handleThemeSelect, config, refreshStatic);
  const {
    authState,
    setAuthState,
    authError,
    onAuthError,
    apiKeyDefaultValue,
    reloadApiKey,
  } = useAuthCommand(settings, config, initializationResult.authError);
  const [authContext, setAuthContext] = useState<{ requiresRestart?: boolean }>(
    {},
  );

  useEffect(() => {
    if (authState === AuthState.Authenticated && authContext.requiresRestart) {
      setAuthState(AuthState.AwaitingGoogleLoginRestart);
      setAuthContext({});
    }
  }, [authState, authContext, setAuthState]);

  const {
    proQuotaRequest,
    handleProQuotaChoice,
    validationRequest,
    handleValidationChoice,
  } = useQuotaAndFallback({
    config,
    historyManager,
    userTier,
    setModelSwitchedFromQuotaError,
    onShowAuthSelection: () => setAuthState(AuthState.Updating),
  });

  // Derive auth state variables for backward compatibility with UIStateContext
  const isAuthDialogOpen = authState === AuthState.Updating;
  const isAuthenticating = authState === AuthState.Unauthenticated;

  // Session browser and resume functionality
  const isGeminiClientInitialized = config.getGeminiClient()?.isInitialized();

  const { loadHistoryForResume, isResuming } = useSessionResume({
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
        if (authType === AuthType.LOGIN_WITH_GOOGLE) {
          setAuthContext({ requiresRestart: true });
        } else {
          setAuthContext({});
        }
        await clearCachedCredentialFile();
        settings.setValue(scope, 'security.auth.selectedType', authType);

        try {
          config.setRemoteAdminSettings(undefined);
          await config.refreshAuth(authType);
          setAuthState(AuthState.Authenticated);
        } catch (e) {
          if (e instanceof ChangeAuthRequestedError) {
            return;
          }
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
    [settings, config, setAuthState, onAuthError, setAuthContext],
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
      settings.merged.security.auth.enforcedType &&
      settings.merged.security.auth.selectedType &&
      settings.merged.security.auth.enforcedType !==
        settings.merged.security.auth.selectedType
    ) {
      onAuthError(
        `Authentication is enforced to be ${settings.merged.security.auth.enforcedType}, but you are currently using ${settings.merged.security.auth.selectedType}.`,
      );
    } else if (
      settings.merged.security.auth.selectedType &&
      !settings.merged.security.auth.useExternal
    ) {
      // We skip validation for Gemini API key here because it might be stored
      // in the keychain, which we can't check synchronously.
      // The useAuth hook handles validation for this case.
      if (settings.merged.security.auth.selectedType === AuthType.USE_GEMINI) {
        return;
      }

      const error = validateAuthMethod(
        settings.merged.security.auth.selectedType,
      );
      if (error) {
        onAuthError(error);
      }
    }
  }, [
    settings.merged.security.auth.selectedType,
    settings.merged.security.auth.enforcedType,
    settings.merged.security.auth.useExternal,
    onAuthError,
  ]);

  const [languageError, setLanguageError] = useState<string | null>(null);
  const { isLanguageDialogOpen, openLanguageDialog, handleLanguageSelect } =
    useLanguageCommand(
      settings,
      setLanguageError,
      historyManager.addItem,
      refreshStatic,
    );
  const { isModelDialogOpen, openModelDialog, closeModelDialog } =
    useModelCommand();

  const { toggleVimEnabled } = useVimMode();

  const setIsBackgroundShellListOpenRef = useRef<(open: boolean) => void>(
    () => {},
  );
  const [shortcutsHelpVisible, setShortcutsHelpVisible] = useState(false);

  const {
    cleanUiDetailsVisible,
    setCleanUiDetailsVisible,
    toggleCleanUiDetailsVisible,
    revealCleanUiDetailsTemporarily,
  } = useVisibilityToggle();

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
      openAgentConfigDialog,
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
      toggleBackgroundShell: () => {
        toggleBackgroundShellRef.current();
        if (!isBackgroundShellVisibleRef.current) {
          setEmbeddedShellFocused(true);
          if (backgroundShellsRef.current.size > 1) {
            setIsBackgroundShellListOpenRef.current(true);
          } else {
            setIsBackgroundShellListOpenRef.current(false);
          }
        }
      },
      toggleShortcutsHelp: () => setShortcutsHelpVisible((visible) => !visible),
      setText: stableSetText,
    }),
    [
      setAuthState,
      openThemeDialog,
      openEditorDialog,
      openLanguageDialog,
      openSettingsDialog,
      openSessionBrowser,
      openModelDialog,
      openAgentConfigDialog,
      setQuittingMessages,
      setDebugMessage,
      setShowPrivacyNotice,
      setCorgiMode,
      dispatchExtensionStateUpdate,
      openPermissionsDialog,
      addConfirmUpdateExtensionRequest,
      toggleDebugProfiler,
      setShortcutsHelpVisible,
      stableSetText,
    ],
  );

  const {
    handleSlashCommand,
    slashCommands,
    pendingHistoryItems: pendingSlashCommandHistoryItems,
    commandContext,
    confirmationRequest: commandConfirmationRequest,
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

  const [authConsentRequest, setAuthConsentRequest] =
    useState<ConfirmationRequest | null>(null);
  const [permissionConfirmationRequest, setPermissionConfirmationRequest] =
    useState<PermissionConfirmationRequest | null>(null);

  useEffect(() => {
    const handleConsentRequest = (payload: ConsentRequestPayload) => {
      setAuthConsentRequest({
        prompt: payload.prompt,
        onConfirm: (confirmed: boolean) => {
          setAuthConsentRequest(null);
          payload.onConfirm(confirmed);
        },
      });
    };

    coreEvents.on(CoreEvent.ConsentRequest, handleConsentRequest);
    return () => {
      coreEvents.off(CoreEvent.ConsentRequest, handleConsentRequest);
    };
  }, []);

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

      const flattenedMemory = flattenMemory(memoryContent);

      historyManager.addItem(
        {
          type: MessageType.INFO,
          text: `Memory refreshed successfully. ${
            flattenedMemory.length > 0
              ? `Loaded ${flattenedMemory.length} characters from ${fileCount} file(s).`
              : 'No memory content found.'
          }`,
        },
        Date.now(),
      );
      if (config.getDebugMode()) {
        debugLogger.log(
          `[DEBUG] Refreshed memory content in config: ${flattenedMemory.substring(
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

  const pendingHintsRef = useRef<string[]>([]);
  const [pendingHintCount, setPendingHintCount] = useState(0);

  const consumePendingHints = useCallback(() => {
    if (pendingHintsRef.current.length === 0) {
      return null;
    }
    const hint = pendingHintsRef.current.join('\n');
    pendingHintsRef.current = [];
    setPendingHintCount(0);
    return hint;
  }, []);

  useEffect(() => {
    const hintListener = (hint: string) => {
      pendingHintsRef.current.push(hint);
      setPendingHintCount((prev) => prev + 1);
    };
    config.userHintService.onUserHint(hintListener);
    return () => {
      config.userHintService.offUserHint(hintListener);
    };
  }, [config]);

  const {
    streamingState,
    submitQuery,
    initError,
    pendingHistoryItems: pendingGeminiHistoryItems,
    thought,
    cancelOngoingRequest,
    pendingToolCalls,
    handleApprovalModeChange,
    activePtyId,
    loopDetectionConfirmationRequest,
    lastOutputTime,
    backgroundShellCount,
    isBackgroundShellVisible,
    toggleBackgroundShell,
    backgroundCurrentShell,
    backgroundShells,
    dismissBackgroundShell,
    retryStatus,
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
    consumePendingHints,
  );

  toggleBackgroundShellRef.current = toggleBackgroundShell;
  isBackgroundShellVisibleRef.current = isBackgroundShellVisible;
  backgroundShellsRef.current = backgroundShells;

  const {
    activeBackgroundShellPid,
    setIsBackgroundShellListOpen,
    isBackgroundShellListOpen,
    setActiveBackgroundShellPid,
    backgroundShellHeight,
  } = useBackgroundShellManager({
    backgroundShells,
    backgroundShellCount,
    isBackgroundShellVisible,
    activePtyId,
    embeddedShellFocused,
    setEmbeddedShellFocused,
    terminalHeight,
  });

  setIsBackgroundShellListOpenRef.current = setIsBackgroundShellListOpen;

  const lastOutputTimeRef = useRef(0);

  useEffect(() => {
    lastOutputTimeRef.current = lastOutputTime;
  }, [lastOutputTime]);

  const { shouldShowFocusHint, inactivityStatus } = useShellInactivityStatus({
    activePtyId,
    lastOutputTime,
    streamingState,
    pendingToolCalls,
    embeddedShellFocused,
    isInteractiveShellEnabled: config.isInteractiveShellEnabled(),
  });

  const shouldShowActionRequiredTitle = inactivityStatus === 'action_required';
  const shouldShowSilentWorkingTitle = inactivityStatus === 'silent_working';

  const handleApprovalModeChangeWithUiReveal = useCallback(
    (mode: ApprovalMode) => {
      void handleApprovalModeChange(mode);
      if (!cleanUiDetailsVisible) {
        revealCleanUiDetailsTemporarily(APPROVAL_MODE_REVEAL_DURATION_MS);
      }
    },
    [
      handleApprovalModeChange,
      cleanUiDetailsVisible,
      revealCleanUiDetailsTemporarily,
    ],
  );

  const { isMcpReady } = useMcpStatus(config);

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
    isMcpReady,
  });

  cancelHandlerRef.current = useCallback(
    (shouldRestorePrompt: boolean = true) => {
      const pendingHistoryItems = [
        ...pendingSlashCommandHistoryItems,
        ...pendingGeminiHistoryItems,
      ];
      if (isToolAwaitingConfirmation(pendingHistoryItems)) {
        return; // Don't clear - user may be composing a follow-up message
      }
      if (isToolExecuting(pendingHistoryItems)) {
        buffer.setText(''); // Clear for Ctrl+C cancellation
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

  const handleHintSubmit = useCallback(
    (hint: string) => {
      const trimmed = hint.trim();
      if (!trimmed) {
        return;
      }
      config.userHintService.addUserHint(trimmed);
      // Render hints with a distinct style.
      historyManager.addItem({
        type: 'hint',
        text: trimmed,
      });
    },
    [config, historyManager],
  );

  const handleFinalSubmit = useCallback(
    async (submittedValue: string) => {
      const isSlash = isSlashCommand(submittedValue.trim());
      const isIdle = streamingState === StreamingState.Idle;
      const isAgentRunning =
        streamingState === StreamingState.Responding ||
        isToolExecuting([
          ...pendingSlashCommandHistoryItems,
          ...pendingGeminiHistoryItems,
        ]);

      if (config.isModelSteeringEnabled() && isAgentRunning && !isSlash) {
        handleHintSubmit(submittedValue);
        addInput(submittedValue);
        return;
      }

      if (isSlash || (isIdle && isMcpReady)) {
        if (!isSlash) {
          const permissions = await checkPermissions(submittedValue, config);
          if (permissions.length > 0) {
            setPermissionConfirmationRequest({
              files: permissions,
              onComplete: (result) => {
                setPermissionConfirmationRequest(null);
                if (result.allowed) {
                  permissions.forEach((p) =>
                    config.getWorkspaceContext().addReadOnlyPath(p),
                  );
                }
                void submitQuery(submittedValue);
              },
            });
            addInput(submittedValue);
            return;
          }
        }
        void submitQuery(submittedValue);
      } else {
        // Check messageQueue.length === 0 to only notify on the first queued item
        if (isIdle && !isMcpReady && messageQueue.length === 0) {
          coreEvents.emitFeedback(
            'info',
            'Waiting for MCP servers to initialize... Slash commands are still available and prompts will be queued.',
          );
        }
        addMessage(submittedValue);
      }
      addInput(submittedValue); // Track input for up-arrow history
    },
    [
      addMessage,
      addInput,
      submitQuery,
      isMcpReady,
      streamingState,
      messageQueue.length,
      pendingSlashCommandHistoryItems,
      pendingGeminiHistoryItems,
      config,
      handleHintSubmit,
    ],
  );

  const handleClearScreen = useCallback(() => {
    historyManager.clearItems();
    clearConsoleMessagesState();
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
    isConfigInitialized &&
    !initError &&
    !isProcessing &&
    !isResuming &&
    !!slashCommands &&
    (streamingState === StreamingState.Idle ||
      streamingState === StreamingState.Responding) &&
    !proQuotaRequest;

  const [controlsHeight, setControlsHeight] = useState(0);

  useLayoutEffect(() => {
    if (mainControlsRef.current) {
      const fullFooterMeasurement = measureElement(mainControlsRef.current);
      const roundedHeight = Math.round(fullFooterMeasurement.height);
      if (roundedHeight > 0 && roundedHeight !== controlsHeight) {
        setControlsHeight(roundedHeight);
      }
    }
  }, [buffer, terminalWidth, terminalHeight, controlsHeight]);

  // Compute available terminal height based on controls measurement
  const availableTerminalHeight = Math.max(
    0,
    terminalHeight -
      controlsHeight -
      staticExtraHeight -
      2 -
      backgroundShellHeight,
  );

  config.setShellExecutionConfig({
    terminalWidth: Math.floor(terminalWidth * SHELL_WIDTH_FRACTION),
    terminalHeight: Math.max(
      Math.floor(availableTerminalHeight - SHELL_HEIGHT_PADDING),
      1,
    ),
    pager: settings.merged.tools.shell.pager,
    showColor: settings.merged.tools.shell.showColor,
    sanitizationConfig: config.sanitizationConfig,
  });

  const { isFocused, hasReceivedFocusEvent } = useFocus();

  const contextFileNames = useMemo(() => {
    // AUDITARIA_FEATURE_START: Context file names computation - use actual loaded file paths
    // Get actual loaded file paths from config
    const loadedFilePaths = config.getGeminiMdFilePaths();
    if (loadedFilePaths && loadedFilePaths.length > 0) {
      // Extract basenames from actual loaded paths
      return loadedFilePaths.map((filePath) => basename(filePath));
    }
    // AUDITARIA_FEATURE_END: Fallback to configured names if no files loaded yet
    const fromSettings = settings.merged.context.fileName;
    return fromSettings
      ? Array.isArray(fromSettings)
        ? fromSettings
        : [fromSettings]
      : getAllGeminiMdFilenames();
  }, [config, settings.merged.context.fileName]); // AUDITARIA_FEATURE: added config dep

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
      void handleFinalSubmit(initialPrompt);
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
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    getIde();
  }, []);
  const shouldShowIdePrompt = Boolean(
    currentIDE &&
      !config.getIdeMode() &&
      !settings.merged.ide.hasSeenNudge &&
      !idePromptAnswered,
  );

  const [showErrorDetails, setShowErrorDetails] = useState<boolean>(false);
  const [showFullTodos, setShowFullTodos] = useState<boolean>(false);
  const [renderMarkdown, setRenderMarkdown] = useState<boolean>(true);

  const handleExitRepeat = useCallback(
    (count: number) => {
      if (count > 2) {
        recordExitFail(config);
      }
      if (count > 1) {
        void handleSlashCommand('/quit', undefined, undefined, false);
      }
    },
    [config, handleSlashCommand],
  );

  const { pressCount: ctrlCPressCount, handlePress: handleCtrlCPress } =
    useRepeatedKeyPress({
      windowMs: WARNING_PROMPT_DURATION_MS,
      onRepeat: handleExitRepeat,
    });

  const { pressCount: ctrlDPressCount, handlePress: handleCtrlDPress } =
    useRepeatedKeyPress({
      windowMs: WARNING_PROMPT_DURATION_MS,
      onRepeat: handleExitRepeat,
    });
  const [constrainHeight, setConstrainHeight] = useState<boolean>(true);
  const [ideContextState, setIdeContextState] = useState<
    IdeContext | undefined
  >();
  const [showEscapePrompt, setShowEscapePrompt] = useState(false);
  const [showIdeRestartPrompt, setShowIdeRestartPrompt] = useState(false);

  const [transientMessage, showTransientMessage] = useTimedMessage<{
    text: string;
    type: TransientMessageType;
  }>(WARNING_PROMPT_DURATION_MS);

  const {
    isFolderTrustDialogOpen,
    discoveryResults: folderDiscoveryResults,
    handleFolderTrustSelect,
    isRestarting,
  } = useFolderTrust(settings, setIsTrustedFolder, historyManager.addItem);

  const policyUpdateConfirmationRequest =
    config.getPolicyUpdateConfirmationRequest();
  const [isPolicyUpdateDialogOpen, setIsPolicyUpdateDialogOpen] = useState(
    !!policyUpdateConfirmationRequest,
  );
  const {
    needsRestart: ideNeedsRestart,
    restartReason: ideTrustRestartReason,
  } = useIdeTrustListener();
  const isInitialMount = useRef(true);

  useIncludeDirsTrust(config, isTrustedFolder, historyManager, setCustomDialog);

  const handleAutoEnableRetention = useCallback(() => {
    const userSettings = settings.forScope(SettingScope.User).settings;
    const currentRetention = userSettings.general?.sessionRetention ?? {};

    settings.setValue(SettingScope.User, 'general.sessionRetention', {
      ...currentRetention,
      enabled: true,
      maxAge: '30d',
      warningAcknowledged: true,
    });
  }, [settings]);

  const {
    shouldShowWarning: shouldShowRetentionWarning,
    checkComplete: retentionCheckComplete,
    sessionsToDeleteCount,
  } = useSessionRetentionCheck(
    config,
    settings.merged,
    handleAutoEnableRetention,
  );

  const tabFocusTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const handleTransientMessage = (payload: {
      message: string;
      type: TransientMessageType;
    }) => {
      showTransientMessage({ text: payload.message, type: payload.type });
    };

    const handleSelectionWarning = () => {
      showTransientMessage({
        text: 'Press Ctrl-S to enter selection mode to copy text.',
        type: TransientMessageType.Warning,
      });
    };
    const handlePasteTimeout = () => {
      showTransientMessage({
        text: 'Paste Timed out. Possibly due to slow connection.',
        type: TransientMessageType.Warning,
      });
    };

    appEvents.on(AppEvent.TransientMessage, handleTransientMessage);
    appEvents.on(AppEvent.SelectionWarning, handleSelectionWarning);
    appEvents.on(AppEvent.PasteTimeout, handlePasteTimeout);

    return () => {
      appEvents.off(AppEvent.TransientMessage, handleTransientMessage);
      appEvents.off(AppEvent.SelectionWarning, handleSelectionWarning);
      appEvents.off(AppEvent.PasteTimeout, handlePasteTimeout);
      if (tabFocusTimeoutRef.current) {
        clearTimeout(tabFocusTimeoutRef.current);
      }
    };
  }, [showTransientMessage]);

  const handleWarning = useCallback(
    (message: string) => {
      showTransientMessage({
        text: message,
        type: TransientMessageType.Warning,
      });
    },
    [showTransientMessage],
  );

  const { handleSuspend } = useSuspend({
    handleWarning,
    setRawMode,
    refreshStatic,
    setForceRerenderKey,
    shouldUseAlternateScreen,
  });

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
    coreEvents.on(CoreEvent.McpClientUpdate, handleMcpClientUpdate);

    return () => {
      coreEvents.off(CoreEvent.McpClientUpdate, handleMcpClientUpdate);
    };
  }, []);
  // WEB_INTERFACE_END

  const handleEscapePromptChange = useCallback((showPrompt: boolean) => {
    setShowEscapePrompt(showPrompt);
  }, []);

  const handleIdePromptComplete = useCallback(
    (result: IdeIntegrationNudgeResult) => {
      if (result.userSelection === 'yes') {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleSlashCommand('/ide install');
        settings.setValue(SettingScope.User, 'ide.hasSeenNudge', true);
      } else if (result.userSelection === 'dismiss') {
        settings.setValue(SettingScope.User, 'ide.hasSeenNudge', true);
      }
      setIdePromptAnswered(true);
    },
    [handleSlashCommand, settings],
  );

  const { elapsedTime, currentLoadingPhrase } = useLoadingIndicator({
    streamingState,
    shouldShowFocusHint,
    retryStatus,
    loadingPhrasesMode: settings.merged.ui.loadingPhrases,
    customWittyPhrases: settings.merged.ui.customWittyPhrases,
  });

  const handleGlobalKeypress = useCallback(
    (key: Key): boolean => {
      // Debug log keystrokes if enabled
      if (settings.merged.general.debugKeystrokeLogging) {
        debugLogger.log('[DEBUG] Keystroke:', JSON.stringify(key));
      }

      if (shortcutsHelpVisible && shouldDismissShortcutsHelpOnHotkey(key)) {
        setShortcutsHelpVisible(false);
      }

      if (isAlternateBuffer && keyMatchers[Command.TOGGLE_COPY_MODE](key)) {
        setCopyModeEnabled(true);
        disableMouseEvents();
        return true;
      }

      if (keyMatchers[Command.QUIT](key)) {
        // If the user presses Ctrl+C, we want to cancel any ongoing requests.
        // This should happen regardless of the count.
        cancelOngoingRequest?.();

        handleCtrlCPress();
        return true;
      } else if (keyMatchers[Command.EXIT](key)) {
        handleCtrlDPress();
        return true;
      } else if (keyMatchers[Command.SUSPEND_APP](key)) {
        handleSuspend();
      } else if (
        keyMatchers[Command.TOGGLE_COPY_MODE](key) &&
        !isAlternateBuffer
      ) {
        showTransientMessage({
          text: 'Use Ctrl+O to expand and collapse blocks of content.',
          type: TransientMessageType.Warning,
        });
        return true;
      }

      let enteringConstrainHeightMode = false;
      if (!constrainHeight) {
        enteringConstrainHeightMode = true;
        setConstrainHeight(true);
      }

      if (keyMatchers[Command.SHOW_ERROR_DETAILS](key)) {
        if (settings.merged.general.devtools) {
          void (async () => {
            const { toggleDevToolsPanel } = await import(
              '../utils/devtoolsService.js'
            );
            await toggleDevToolsPanel(
              config,
              showErrorDetails,
              () => setShowErrorDetails((prev) => !prev),
              () => setShowErrorDetails(true),
            );
          })();
        } else {
          setShowErrorDetails((prev) => !prev);
        }
        return true;
      } else if (keyMatchers[Command.SHOW_FULL_TODOS](key)) {
        setShowFullTodos((prev) => !prev);
        return true;
      } else if (keyMatchers[Command.TOGGLE_MARKDOWN](key)) {
        setRenderMarkdown((prev) => {
          const newValue = !prev;
          // Force re-render of static content
          refreshStatic();
          return newValue;
        });
        return true;
      } else if (
        keyMatchers[Command.SHOW_IDE_CONTEXT_DETAIL](key) &&
        config.getIdeMode() &&
        ideContextState
      ) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        handleSlashCommand('/ide status');
        return true;
      } else if (
        keyMatchers[Command.SHOW_MORE_LINES](key) &&
        !enteringConstrainHeightMode
      ) {
        setConstrainHeight(false);
        return true;
      } else if (
        (keyMatchers[Command.FOCUS_SHELL_INPUT](key) ||
          keyMatchers[Command.UNFOCUS_BACKGROUND_SHELL_LIST](key)) &&
        (activePtyId || (isBackgroundShellVisible && backgroundShells.size > 0))
      ) {
        if (embeddedShellFocused) {
          const capturedTime = lastOutputTimeRef.current;
          if (tabFocusTimeoutRef.current)
            clearTimeout(tabFocusTimeoutRef.current);
          tabFocusTimeoutRef.current = setTimeout(() => {
            if (lastOutputTimeRef.current === capturedTime) {
              setEmbeddedShellFocused(false);
            } else {
              showTransientMessage({
                text: 'Use Shift+Tab to unfocus',
                type: TransientMessageType.Warning,
              });
            }
          }, 150);
          return false;
        }

        const isIdle = Date.now() - lastOutputTimeRef.current >= 100;

        if (isIdle && !activePtyId && !isBackgroundShellVisible) {
          if (tabFocusTimeoutRef.current)
            clearTimeout(tabFocusTimeoutRef.current);
          toggleBackgroundShell();
          setEmbeddedShellFocused(true);
          if (backgroundShells.size > 1) setIsBackgroundShellListOpen(true);
          return true;
        }

        setEmbeddedShellFocused(true);
        return true;
      } else if (
        keyMatchers[Command.UNFOCUS_SHELL_INPUT](key) ||
        keyMatchers[Command.UNFOCUS_BACKGROUND_SHELL](key)
      ) {
        if (embeddedShellFocused) {
          setEmbeddedShellFocused(false);
          return true;
        }
        return false;
      } else if (keyMatchers[Command.TOGGLE_BACKGROUND_SHELL](key)) {
        if (activePtyId) {
          backgroundCurrentShell();
          // After backgrounding, we explicitly do NOT show or focus the background UI.
        } else {
          toggleBackgroundShell();
          // Toggle focus based on intent: if we were hiding, unfocus; if showing, focus.
          if (!isBackgroundShellVisible && backgroundShells.size > 0) {
            setEmbeddedShellFocused(true);
            if (backgroundShells.size > 1) {
              setIsBackgroundShellListOpen(true);
            }
          } else {
            setEmbeddedShellFocused(false);
          }
        }
        return true;
      } else if (keyMatchers[Command.TOGGLE_BACKGROUND_SHELL_LIST](key)) {
        if (backgroundShells.size > 0 && isBackgroundShellVisible) {
          if (!embeddedShellFocused) {
            setEmbeddedShellFocused(true);
          }
          setIsBackgroundShellListOpen(true);
        }
        return true;
      }
      return false;
    },
    [
      constrainHeight,
      setConstrainHeight,
      setShowErrorDetails,
      config,
      ideContextState,
      handleCtrlCPress,
      handleCtrlDPress,
      handleSlashCommand,
      cancelOngoingRequest,
      activePtyId,
      handleSuspend,
      embeddedShellFocused,
      settings.merged.general.debugKeystrokeLogging,
      refreshStatic,
      setCopyModeEnabled,
      tabFocusTimeoutRef,
      isAlternateBuffer,
      shortcutsHelpVisible,
      backgroundCurrentShell,
      toggleBackgroundShell,
      backgroundShells,
      isBackgroundShellVisible,
      setIsBackgroundShellListOpen,
      lastOutputTimeRef,
      showTransientMessage,
      settings.merged.general.devtools,
      showErrorDetails,
    ],
  );

  useKeypress(handleGlobalKeypress, { isActive: true, priority: true });

  useKeypress(
    () => {
      setCopyModeEnabled(false);
      enableMouseEvents();
      return true;
    },
    {
      isActive: copyModeEnabled,
      // We need to receive keypresses first so they do not bubble to other
      // handlers.
      priority: KeypressPriority.Critical,
    },
  );

  useEffect(() => {
    // Respect hideWindowTitle settings
    if (settings.merged.ui.hideWindowTitle) return;

    const paddedTitle = computeTerminalTitle({
      streamingState,
      thoughtSubject: thought?.subject,
      isConfirming:
        !!commandConfirmationRequest || shouldShowActionRequiredTitle,
      isSilentWorking: shouldShowSilentWorkingTitle,
      folderName: basename(config.getTargetDir()),
      showThoughts: !!settings.merged.ui.showStatusInTitle,
      useDynamicTitle: settings.merged.ui.dynamicWindowTitle,
    });

    // Only update the title if it's different from the last value we set
    if (lastTitleRef.current !== paddedTitle) {
      lastTitleRef.current = paddedTitle;
      stdout.write(`\x1b]0;${paddedTitle}\x07`);
    }
    // Note: We don't need to reset the window title on exit because Gemini CLI is already doing that elsewhere
  }, [
    streamingState,
    thought,
    commandConfirmationRequest,
    shouldShowActionRequiredTitle,
    shouldShowSilentWorkingTitle,
    settings.merged.ui.showStatusInTitle,
    settings.merged.ui.dynamicWindowTitle,
    settings.merged.ui.hideWindowTitle,
    config,
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

  const hasToolConfirmation =
    (toolConfirmationContext?.pendingConfirmations?.length ?? 0) > 0; // AUDITARIA: Tool confirmations trigger terminal capture for web interface

  const dialogsVisible =
    hasToolConfirmation || // AUDITARIA: Enables terminal capture for tool confirmations
    (shouldShowRetentionWarning && retentionCheckComplete) ||
    shouldShowIdePrompt ||
    isFolderTrustDialogOpen ||
    isPolicyUpdateDialogOpen ||
    adminSettingsChanged ||
    !!commandConfirmationRequest ||
    !!authConsentRequest ||
    !!permissionConfirmationRequest ||
    !!customDialog ||
    confirmUpdateExtensionRequests.length > 0 ||
    !!loopDetectionConfirmationRequest ||
    isThemeDialogOpen ||
    isSettingsDialogOpen ||
    isModelDialogOpen ||
    isAgentConfigDialogOpen ||
    isPermissionsDialogOpen ||
    isAuthenticating ||
    isAuthDialogOpen ||
    isEditorDialogOpen ||
    isLanguageDialogOpen ||
    showPrivacyNotice ||
    showIdeRestartPrompt ||
    !!proQuotaRequest ||
    !!validationRequest ||
    isSessionBrowserOpen ||
    authState === AuthState.AwaitingApiKeyInput ||
    !!newAgents;

  const pendingHistoryItems = useMemo(
    () => [...pendingSlashCommandHistoryItems, ...pendingGeminiHistoryItems],
    [pendingSlashCommandHistoryItems, pendingGeminiHistoryItems],
  );

  // WEB_INTERFACE_START: Web interface integration - submitQuery registration and abort handler
  const webInterface = useWebInterface();

  // WEB_INTERFACE_START: Web model selector data + handler
  const webModelMenuData = useMemo(() => {
    const hasPreviewModels = config.getHasAccessToPreviewModel();
    const selectedDisplayModel = config.getDisplayModel();
    const selectedGeminiModel = config.getModel();

    const providerConfig = config.getProviderConfig();
    const rawCodexEffort =
      providerConfig?.type === 'codex-cli'
        ? providerConfig.options?.['reasoningEffort']
        : undefined;
    const baseCodexEffort = isCodexReasoningEffort(rawCodexEffort)
      ? rawCodexEffort
      : DEFAULT_CODEX_REASONING_EFFORT;

    const availability = config.getProviderAvailability(); // AUDITARIA_PROVIDER_AVAILABILITY: Get provider availability status

    const groups = [
      {
        id: 'gemini',
        label: 'Gemini',
        available: true, // AUDITARIA_PROVIDER_AVAILABILITY: Gemini is always available
        options: getGeminiWebOptions(hasPreviewModels),
      },
      {
        id: 'claude',
        label: 'Claude',
        available: availability.claude, // AUDITARIA_PROVIDER_AVAILABILITY
        installMessage: availability.claude
          ? undefined
          : 'To use Claude Code, install it from https://docs.anthropic.com/en/docs/claude-code, then run `claude` to authenticate.', // AUDITARIA_PROVIDER_AVAILABILITY
        options: CLAUDE_SUBMENU_OPTIONS.map((option) => ({
          selection: option.value,
          label: `Claude (${option.title})`,
          description: option.description,
        })),
      },
      {
        id: 'codex',
        label: 'Codex',
        available: availability.codex, // AUDITARIA_PROVIDER_AVAILABILITY
        installMessage: availability.codex
          ? undefined
          : 'To use OpenAI Codex, install it from https://www.npmjs.com/package/@openai/codex, then run `codex` to authenticate.', // AUDITARIA_PROVIDER_AVAILABILITY
        options: CODEX_SUBMENU_OPTIONS.map((option) => ({
          selection: option.value,
          label: `Codex (${option.title})`,
          description: option.description,
          supportedReasoningEfforts: getSupportedCodexReasoningEfforts(
            option.model,
          ),
        })),
      },
    ];

    let activeSelection =
      selectedGeminiModel === 'auto'
        ? 'gemini:auto-gemini-2.5'
        : `gemini:${selectedGeminiModel}`;
    if (selectedDisplayModel.startsWith('claude-code:')) {
      const variant = selectedDisplayModel.split(':')[1] || 'auto';
      activeSelection = `${CLAUDE_PREFIX}${variant}`;
    } else if (selectedDisplayModel.startsWith('codex-code:')) {
      const variant = selectedDisplayModel.split(':')[1] || 'auto';
      activeSelection = `${CODEX_PREFIX}${variant}`;
    }

    const availableSelections = new Set(
      groups.flatMap((group) =>
        (group.options ?? []).map((option) => option.selection),
      ),
    );
    if (!availableSelections.has(activeSelection)) {
      if (selectedDisplayModel.startsWith('claude-code:')) {
        activeSelection = `${CLAUDE_PREFIX}auto`;
      } else if (selectedDisplayModel.startsWith('codex-code:')) {
        activeSelection = `${CODEX_PREFIX}auto`;
      } else {
        activeSelection = 'gemini:auto-gemini-2.5';
      }
    }

    const activeCodexSelection = activeSelection.startsWith(CODEX_PREFIX)
      ? activeSelection
      : `${CODEX_PREFIX}auto`;
    const activeCodexModel = activeCodexSelection.slice(CODEX_PREFIX.length);
    const codexReasoningEffort = clampCodexReasoningEffortForModel(
      activeCodexModel === 'auto' ? undefined : activeCodexModel,
      baseCodexEffort,
    );

    return {
      groups,
      activeSelection,
      codexReasoning: {
        activeSelection: activeCodexSelection,
        currentEffort: codexReasoningEffort,
        options: CODEX_REASONING_OPTIONS,
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- currentModel and modelChangeNonce are intentional trigger deps
  }, [config, currentModel, modelChangeNonce]);

  const webModelSelections = useMemo(
    () =>
      new Set(
        webModelMenuData.groups.flatMap((group) =>
          (group.options ?? []).map((option) => option.selection),
        ),
      ),
    [webModelMenuData],
  );

  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastModelMenuData(webModelMenuData);
    }
  }, [webInterface?.service, webInterface?.isRunning, webModelMenuData]);

  useEffect(() => {
    if (!webInterface?.service) return;

    const handleModelChangeRequest = (payload: {
      selection?: string;
      reasoningEffort?: string;
    }) => {
      const selection = payload?.selection;
      if (!selection || typeof selection !== 'string') return;
      if (!webModelSelections.has(selection)) return;

      if (selection.startsWith('gemini:')) {
        const geminiModel = selection.slice('gemini:'.length);
        if (!geminiModel) return;
        config.clearProviderConfig(false); // AUDITARIA_PROVIDER_PERSISTENCE: persist model change
        config.setModel(geminiModel, false);
        return;
      }

      if (selection.startsWith(CLAUDE_PREFIX)) {
        const claudeModel = selection.slice(CLAUDE_PREFIX.length);
        config.setProviderConfig(
          {
            type: 'claude-cli',
            model: claudeModel === 'auto' ? undefined : claudeModel,
            cwd: config.getWorkingDir(),
          },
          false,
        ); // AUDITARIA_PROVIDER_PERSISTENCE: persist model change
        return;
      }

      if (selection.startsWith(CODEX_PREFIX)) {
        const codexModel = selection.slice(CODEX_PREFIX.length);
        const existingProviderConfig = config.getProviderConfig();
        const payloadReasoningEffort = payload?.reasoningEffort;
        const existingReasoningEffort =
          existingProviderConfig?.options?.['reasoningEffort'];
        const baseReasoningEffort: CodexReasoningEffort =
          isCodexReasoningEffort(payloadReasoningEffort)
            ? payloadReasoningEffort
            : isCodexReasoningEffort(existingReasoningEffort)
              ? existingReasoningEffort
              : DEFAULT_CODEX_REASONING_EFFORT;
        const clampedReasoningEffort = clampCodexReasoningEffortForModel(
          codexModel === 'auto' ? undefined : codexModel,
          baseReasoningEffort,
        );

        config.setProviderConfig(
          {
            type: 'codex-cli',
            model: codexModel === 'auto' ? undefined : codexModel,
            cwd: config.getWorkingDir(),
            options: {
              reasoningEffort: clampedReasoningEffort,
            },
          },
          false,
        ); // AUDITARIA_PROVIDER_PERSISTENCE: persist model change
      }
    };

    webInterface.service.on('model_change_request', handleModelChangeRequest);
    return () => {
      webInterface?.service?.off(
        'model_change_request',
        handleModelChangeRequest,
      );
    };
  }, [webInterface?.service, config, webModelSelections]);
  // WEB_INTERFACE_END

  // Store current submitQuery in ref for web interface
  const submitQueryRef = useRef(submitQuery);
  useEffect(() => {
    submitQueryRef.current = submitQuery;
  }, [submitQuery]);

  // Create a completely stable function that will never change
  const stableWebSubmitQuery = useCallback((query: PartListUnion) => {
    if (submitQueryRef.current) {
      void submitQueryRef.current(query);
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
  useEffect(() => {
    if (!webEnabled) {
      webAvailabilityMessageShownRef.current = false;
      return;
    }

    if (!webInterface?.isRunning || webInterface.port == null) {
      webAvailabilityMessageShownRef.current = false;
      return;
    }

    if (webAvailabilityMessageShownRef.current) {
      return;
    }

    historyManager.addItem(
      {
        type: MessageType.INFO,
        text: `Web interface available at http://localhost:${webInterface.port.toString()}`,
      },
      Date.now(),
    );
    webAvailabilityMessageShownRef.current = true;
  }, [webEnabled, webInterface?.isRunning, webInterface?.port, historyManager]);

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

  // AUDITARIA: Broadcast input history for web ArrowUp/Down navigation
  useEffect(() => {
    if (webInterface?.service && webInterface.isRunning) {
      webInterface.service.broadcastInputHistory(inputHistory);
    }
  }, [inputHistory, webInterface?.service, webInterface?.isRunning]);

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
          'IDE integration prompt is displayed. Please respond to connect your editor to Auditaria in the terminal.';
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
      } else if (commandConfirmationRequest) {
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
    commandConfirmationRequest,
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
      const startupMessage = `Auditaria is ready. Loaded ${filesDescription}.`;
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
  // (toolConfirmationContext is now defined earlier in the component for terminal capture support)

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

  // AUDITARIA: Set to false to revert to web-based tool confirmation dialog
  // When true, tool confirmations use terminal capture instead of custom web UI
  const DISABLE_WEB_TOOL_CONFIRMATION = true;

  // Broadcast pending confirmations
  useEffect(() => {
    if (DISABLE_WEB_TOOL_CONFIRMATION) return; // AUDITARIA: Use terminal capture instead
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
    DISABLE_WEB_TOOL_CONFIRMATION,
    toolConfirmationContext?.pendingConfirmations,
    webInterface?.service,
    webInterface?.isRunning,
  ]);

  // Broadcast confirmation removal when confirmations are resolved
  useEffect(() => {
    if (DISABLE_WEB_TOOL_CONFIRMATION) return;
    if (webInterface?.service && webInterface.isRunning) {
      // When a confirmation is removed from the queue, broadcast the removal
      const activeConfirmations =
        toolConfirmationContext?.pendingConfirmations || [];
      const trackedConfirmations = [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-type-assertion
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
    DISABLE_WEB_TOOL_CONFIRMATION,
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
  // WEB_INTERFACE_END
  // WEB_INTERFACE: Pending item broadcast removed — unified in useGeminiStream response_state

  const hasPendingToolConfirmation = useMemo(
    () => isToolAwaitingConfirmation(pendingHistoryItems),
    [pendingHistoryItems],
  );

  const hasConfirmUpdateExtensionRequests =
    confirmUpdateExtensionRequests.length > 0;
  const hasLoopDetectionConfirmationRequest =
    !!loopDetectionConfirmationRequest;

  const hasPendingActionRequired =
    hasPendingToolConfirmation ||
    !!commandConfirmationRequest ||
    !!authConsentRequest ||
    hasConfirmUpdateExtensionRequests ||
    hasLoopDetectionConfirmationRequest ||
    !!proQuotaRequest ||
    !!validationRequest ||
    !!customDialog;

  const allowPlanMode =
    config.isPlanEnabled() &&
    streamingState === StreamingState.Idle &&
    !hasPendingActionRequired;

  const showApprovalModeIndicator = useApprovalModeIndicator({
    config,
    addItem: historyManager.addItem,
    onApprovalModeChange: handleApprovalModeChangeWithUiReveal,
    isActive: !embeddedShellFocused,
    allowPlanMode,
  });

  useRunEventNotifications({
    notificationsEnabled,
    isFocused,
    hasReceivedFocusEvent,
    streamingState,
    hasPendingActionRequired,
    pendingHistoryItems,
    commandConfirmationRequest,
    authConsentRequest,
    permissionConfirmationRequest,
    hasConfirmUpdateExtensionRequests,
    hasLoopDetectionConfirmationRequest,
  });

  const isPassiveShortcutsHelpState =
    isInputActive &&
    streamingState === StreamingState.Idle &&
    !hasPendingActionRequired;

  useEffect(() => {
    if (shortcutsHelpVisible && !isPassiveShortcutsHelpState) {
      setShortcutsHelpVisible(false);
    }
  }, [
    shortcutsHelpVisible,
    isPassiveShortcutsHelpState,
    setShortcutsHelpVisible,
  ]);

  useEffect(() => {
    if (
      !isConfigInitialized ||
      !config.isModelSteeringEnabled() ||
      streamingState !== StreamingState.Idle ||
      !isMcpReady ||
      isToolAwaitingConfirmation(pendingHistoryItems)
    ) {
      return;
    }

    const pendingHint = consumePendingHints();
    if (!pendingHint) {
      return;
    }

    void generateSteeringAckMessage(
      config.getBaseLlmClient(),
      pendingHint,
    ).then((ackText) => {
      historyManager.addItem({
        type: 'info',
        text: ackText,
      });
    });
    void submitQuery([{ text: buildUserSteeringHintPrompt(pendingHint) }]);
  }, [
    config,
    historyManager,
    isConfigInitialized,
    isMcpReady,
    streamingState,
    submitQuery,
    consumePendingHints,
    pendingHistoryItems,
    pendingHintCount,
  ]);

  const allToolCalls = useMemo(
    () =>
      pendingHistoryItems
        .filter(
          (item): item is HistoryItemToolGroup => item.type === 'tool_group',
        )
        .flatMap((item) => item.tools),
    [pendingHistoryItems],
  );

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
        // TODO: temporarily disabling the banner, it will be re-added.
        '',
        config.getBannerTextCapacityIssues(),
      ]);

      if (isMounted) {
        setDefaultBannerText(defaultBanner);
        setWarningBannerText(warningBanner);
        setBannerVisible(true);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
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
      shouldShowRetentionWarning:
        shouldShowRetentionWarning && retentionCheckComplete,
      sessionsToDeleteCount: sessionsToDeleteCount ?? 0,
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
      isAgentConfigDialogOpen,
      selectedAgentName,
      selectedAgentDisplayName,
      selectedAgentDefinition,
      isPermissionsDialogOpen,
      permissionsDialogProps,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      commandConfirmationRequest,
      authConsentRequest,
      confirmUpdateExtensionRequests,
      loopDetectionConfirmationRequest,
      permissionConfirmationRequest,
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
      isResuming,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen: isFolderTrustDialogOpen ?? false,
      folderDiscoveryResults,
      isPolicyUpdateDialogOpen,
      policyUpdateConfirmationRequest,
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
      shortcutsHelpVisible,
      cleanUiDetailsVisible,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      activeHooks,
      messageQueue,
      queueErrorMessage,
      showApprovalModeIndicator,
      allowPlanMode,
      currentModel,
      quota: {
        userTier,
        stats: quotaStats,
        proQuotaRequest,
        validationRequest,
      },
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
      backgroundShellCount,
      isBackgroundShellVisible,
      embeddedShellFocused,
      showDebugProfiler,
      customDialog,
      copyModeEnabled,
      transientMessage,
      bannerData,
      bannerVisible,
      terminalBackgroundColor: config.getTerminalBackground(),
      settingsNonce,
      backgroundShells,
      activeBackgroundShellPid,
      backgroundShellHeight,
      isBackgroundShellListOpen,
      adminSettingsChanged,
      newAgents,
      hintMode:
        config.isModelSteeringEnabled() &&
        isToolExecuting([
          ...pendingSlashCommandHistoryItems,
          ...pendingGeminiHistoryItems,
        ]),
      hintBuffer: '',
    }),
    [
      isThemeDialogOpen,
      shouldShowRetentionWarning,
      retentionCheckComplete,
      sessionsToDeleteCount,
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
      isAgentConfigDialogOpen,
      selectedAgentName,
      selectedAgentDisplayName,
      selectedAgentDefinition,
      isPermissionsDialogOpen,
      permissionsDialogProps,
      slashCommands,
      pendingSlashCommandHistoryItems,
      commandContext,
      commandConfirmationRequest,
      authConsentRequest,
      confirmUpdateExtensionRequests,
      loopDetectionConfirmationRequest,
      permissionConfirmationRequest,
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
      isResuming,
      shouldShowIdePrompt,
      isFolderTrustDialogOpen,
      folderDiscoveryResults,
      isPolicyUpdateDialogOpen,
      policyUpdateConfirmationRequest,
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
      shortcutsHelpVisible,
      cleanUiDetailsVisible,
      isFocused,
      elapsedTime,
      currentLoadingPhrase,
      historyRemountKey,
      activeHooks,
      messageQueue,
      queueErrorMessage,
      showApprovalModeIndicator,
      allowPlanMode,
      userTier,
      quotaStats,
      proQuotaRequest,
      validationRequest,
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
      backgroundShellCount,
      isBackgroundShellVisible,
      historyManager,
      embeddedShellFocused,
      showDebugProfiler,
      customDialog,
      apiKeyDefaultValue,
      authState,
      copyModeEnabled,
      transientMessage,
      bannerData,
      bannerVisible,
      config,
      settingsNonce,
      backgroundShellHeight,
      isBackgroundShellListOpen,
      activeBackgroundShellPid,
      backgroundShells,
      adminSettingsChanged,
      newAgents,
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
      openAgentConfigDialog,
      closeAgentConfigDialog,
      openPermissionsDialog,
      closePermissionsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleFolderTrustSelect,
      setIsPolicyUpdateDialogOpen,
      setConstrainHeight,
      onEscapePromptChange: handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      handleClearScreen,
      handleProQuotaChoice,
      handleValidationChoice,
      openSessionBrowser,
      closeSessionBrowser,
      handleResumeSession,
      handleDeleteSession,
      setQueueErrorMessage,
      popAllMessages,
      handleApiKeySubmit,
      handleApiKeyCancel,
      setBannerVisible,
      setShortcutsHelpVisible,
      setCleanUiDetailsVisible,
      toggleCleanUiDetailsVisible,
      revealCleanUiDetailsTemporarily,
      handleWarning,
      setEmbeddedShellFocused,
      dismissBackgroundShell,
      setActiveBackgroundShellPid,
      setIsBackgroundShellListOpen,
      setAuthContext,
      onHintInput: () => {},
      onHintBackspace: () => {},
      onHintClear: () => {},
      onHintSubmit: () => {},
      handleRestart: async () => {
        if (process.send) {
          const remoteSettings = config.getRemoteAdminSettings();
          if (remoteSettings) {
            process.send({
              type: 'admin-settings-update',
              settings: remoteSettings,
            });
          }
        }
        await runExitCleanup();
        process.exit(RELAUNCH_EXIT_CODE);
      },
      handleNewAgentsSelect: async (choice: NewAgentsChoice) => {
        if (newAgents && choice === NewAgentsChoice.ACKNOWLEDGE) {
          const registry = config.getAgentRegistry();
          try {
            await Promise.all(
              newAgents.map((agent) => registry.acknowledgeAgent(agent)),
            );
          } catch (error) {
            debugLogger.error('Failed to acknowledge agents:', error);
            historyManager.addItem(
              {
                type: MessageType.ERROR,
                text: `Failed to acknowledge agents: ${getErrorMessage(error)}`,
              },
              Date.now(),
            );
          }
        }
        setNewAgents(null);
      },
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
      openAgentConfigDialog,
      closeAgentConfigDialog,
      openPermissionsDialog,
      closePermissionsDialog,
      setShellModeActive,
      vimHandleInput,
      handleIdePromptComplete,
      handleFolderTrustSelect,
      setIsPolicyUpdateDialogOpen,
      setConstrainHeight,
      handleEscapePromptChange,
      refreshStatic,
      handleFinalSubmit,
      handleClearScreen,
      handleProQuotaChoice,
      handleValidationChoice,
      openSessionBrowser,
      closeSessionBrowser,
      handleResumeSession,
      handleDeleteSession,
      setQueueErrorMessage,
      popAllMessages,
      handleApiKeySubmit,
      handleApiKeyCancel,
      setBannerVisible,
      setShortcutsHelpVisible,
      setCleanUiDetailsVisible,
      toggleCleanUiDetailsVisible,
      revealCleanUiDetailsTemporarily,
      handleWarning,
      setEmbeddedShellFocused,
      dismissBackgroundShell,
      setActiveBackgroundShellPid,
      setIsBackgroundShellListOpen,
      setAuthContext,
      newAgents,
      config,
      historyManager,
    ],
  );

  if (authState === AuthState.AwaitingGoogleLoginRestart) {
    return (
      <LoginWithGoogleRestartDialog
        onDismiss={() => {
          setAuthContext({});
          setAuthState(AuthState.Updating);
        }}
        config={config}
      />
    );
  }

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
            <ToolActionsProvider config={config} toolCalls={allToolCalls}>
              <ShellFocusContext.Provider value={isFocused}>
                <App key={`app-${forceRerenderKey}`} />
              </ShellFocusContext.Provider>
            </ToolActionsProvider>
          </AppContext.Provider>
        </ConfigContext.Provider>
      </UIActionsContext.Provider>
    </UIStateContext.Provider>
  );
};
