/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, type RenderOptions } from 'ink';
import { AppContainer } from './ui/AppContainer.js';
import { loadCliConfig, parseArguments } from './config/config.js';
import * as cliConfig from './config/config.js';
import { readStdin } from './utils/readStdin.js';
import { basename } from 'node:path';
import v8 from 'node:v8';
import os from 'node:os';
import dns from 'node:dns';
import { start_sandbox } from './utils/sandbox.js';
import type { DnsResolutionOrder, LoadedSettings } from './config/settings.js';
import {
  loadSettings,
  migrateDeprecatedSettings,
  SettingScope,
} from './config/settings.js';
import { themeManager } from './ui/themes/theme-manager.js';
import { getStartupWarnings } from './utils/startupWarnings.js';
import { getUserStartupWarnings } from './utils/userStartupWarnings.js';
import { ConsolePatcher } from './ui/utils/ConsolePatcher.js';
import { runNonInteractive } from './nonInteractiveCli.js';
import {
  cleanupCheckpoints,
  registerCleanup,
  runExitCleanup,
} from './utils/cleanup.js';
import { getCliVersion } from './utils/version.js';
import type { Config, SupportedLanguage } from '@thacio/auditaria-cli-core';
import {
  sessionId,
  logUserPrompt,
  AuthType,
  initI18n,
  getOauthClient,
  t,
  UserPromptEvent,
  debugLogger,
  recordSlowRender,
} from '@thacio/auditaria-cli-core';
import {
  initializeApp,
  type InitializationResult,
} from './core/initializer.js';
import { validateAuthMethod } from './config/auth.js';
import { setMaxSizedBoxDebugging } from './ui/components/shared/MaxSizedBox.js';
import { runZedIntegration } from './zed-integration/zedIntegration.js';
import { cleanupExpiredSessions } from './utils/sessionCleanup.js';
import { validateNonInteractiveAuth } from './validateNonInterActiveAuth.js';
import { detectAndEnableKittyProtocol } from './ui/utils/kittyProtocolDetector.js';
import { checkForUpdates } from './ui/utils/updateCheck.js';
import { handleAutoUpdate } from './utils/handleAutoUpdate.js';
import { appEvents, AppEvent } from './utils/events.js';
import { computeWindowTitle } from './utils/windowTitle.js';
import { SettingsContext } from './ui/contexts/SettingsContext.js';

import { SessionStatsProvider } from './ui/contexts/SessionContext.js';
import { VimModeProvider } from './ui/contexts/VimModeContext.js';
import { KeypressProvider } from './ui/contexts/KeypressContext.js';
import { useKittyKeyboardProtocol } from './ui/hooks/useKittyKeyboardProtocol.js';
import {
  relaunchAppInChildProcess,
  relaunchOnExitCode,
} from './utils/relaunch.js';
import { loadSandboxConfig } from './config/sandboxConfig.js';
import { ExtensionManager } from './config/extension-manager.js';
import { createPolicyUpdater } from './config/policy.js';
import { requestConsentNonInteractive } from './config/extensions/consent.js';
// WEB_INTERFACE_START: Import web interface providers
import { SubmitQueryProvider } from './ui/contexts/SubmitQueryContext.js';
import { WebInterfaceProvider } from './ui/contexts/WebInterfaceContext.js';
import { FooterProvider } from './ui/contexts/FooterContext.js';
import { LoadingStateProvider } from './ui/contexts/LoadingStateContext.js';
import { ToolConfirmationProvider } from './ui/contexts/ToolConfirmationContext.js';
import { TerminalCaptureWrapper } from './ui/components/TerminalCaptureWrapper.js';
// WEB_INTERFACE_END

const SLOW_RENDER_MS = 200;

export function validateDnsResolutionOrder(
  order: string | undefined,
): DnsResolutionOrder {
  const defaultValue: DnsResolutionOrder = 'ipv4first';
  if (order === undefined) {
    return defaultValue;
  }
  if (order === 'ipv4first' || order === 'verbatim') {
    return order;
  }
  // We don't want to throw here, just warn and use the default.
  debugLogger.warn(
    `Invalid value for dnsResolutionOrder in settings: "${order}". Using default "${defaultValue}".`,
  );
  return defaultValue;
}

function getNodeMemoryArgs(isDebugMode: boolean): string[] {
  const totalMemoryMB = os.totalmem() / (1024 * 1024);
  const heapStats = v8.getHeapStatistics();
  const currentMaxOldSpaceSizeMb = Math.floor(
    heapStats.heap_size_limit / 1024 / 1024,
  );

  // Set target to 50% of total memory
  const targetMaxOldSpaceSizeInMB = Math.floor(totalMemoryMB * 0.5);
  if (isDebugMode) {
    debugLogger.debug(
      `Current heap size ${currentMaxOldSpaceSizeMb.toFixed(2)} MB`,
    );
  }

  if (process.env['GEMINI_CLI_NO_RELAUNCH']) {
    return [];
  }

  if (targetMaxOldSpaceSizeInMB > currentMaxOldSpaceSizeMb) {
    if (isDebugMode) {
      debugLogger.debug(
        `Need to relaunch with more memory: ${targetMaxOldSpaceSizeInMB.toFixed(2)} MB`,
      );
    }
    return [`--max-old-space-size=${targetMaxOldSpaceSizeInMB}`];
  }

  return [];
}

function detectLanguage(): SupportedLanguage {
  // For testing, check if Portuguese is explicitly set
  if (process.env.AUDITARIA_LANG === 'pt') {
    return 'pt';
  }

  // Check system locale environment variables
  const locale =
    process.env.LANG || process.env.LC_ALL || process.env.LANGUAGE || '';

  // Simple detection - if locale contains 'pt', use Portuguese
  if (locale.toLowerCase().includes('pt')) {
    return 'pt';
  }

  // Default to Portuguese
  return 'en';
}

export function setupUnhandledRejectionHandler() {
  let unhandledRejectionOccurred = false;
  process.on('unhandledRejection', (reason, _promise) => {
    const stackTrace =
      reason instanceof Error && reason.stack
        ? `\nStack trace:\n${reason.stack}`
        : '';
    const errorMessage = t(
      'errors.unhandled_rejection',
      `=========================================
This is an unexpected error. Please file a bug report using the /bug tool.
CRITICAL: Unhandled Promise Rejection!
=========================================
Reason: {reason}{stack}`,
      { reason: String(reason), stack: stackTrace },
    );
    appEvents.emit(AppEvent.LogError, errorMessage);
    if (!unhandledRejectionOccurred) {
      unhandledRejectionOccurred = true;
      appEvents.emit(AppEvent.OpenDebugConsole);
    }
  });
}

export async function startInteractiveUI(
  config: Config,
  settings: LoadedSettings,
  startupWarnings: string[],
  workspaceRoot: string = process.cwd(),
  initializationResult: InitializationResult,
  // WEB_INTERFACE_START: Add web interface parameters
  webEnabled?: boolean,
  webOpenBrowser?: boolean,
  webPort?: number,
  // WEB_INTERFACE_END
) {
  // When not in screen reader mode, disable line wrapping.
  // We rely on Ink to manage all line wrapping by forcing all content to be
  // narrower than the terminal width so there is no need for the terminal to
  // also attempt line wrapping.
  // Disabling line wrapping reduces Ink rendering artifacts particularly when
  // the terminal is resized on terminals that full respect this escape code
  // such as Ghostty. Some terminals such as Iterm2 only respect line wrapping
  // when using the alternate buffer, which Gemini CLI does not use because we
  // do not yet have support for scrolling in that mode.
  if (!config.getScreenReader()) {
    process.stdout.write('\x1b[?7l');

    registerCleanup(() => {
      // Re-enable line wrapping on exit.
      process.stdout.write('\x1b[?7h');
    });
  }

  const version = await getCliVersion();
  setWindowTitle(basename(workspaceRoot), settings);

  // Create wrapper component to use hooks inside render
  const AppWrapper = () => {
    const kittyProtocolStatus = useKittyKeyboardProtocol();
    return (
      <SettingsContext.Provider value={settings}>
        <KeypressProvider
          kittyProtocolEnabled={kittyProtocolStatus.enabled}
          config={config}
          debugKeystrokeLogging={settings.merged.general?.debugKeystrokeLogging}
        >
          <SessionStatsProvider>
            <VimModeProvider settings={settings}>
              {/* WEB_INTERFACE_START: Wrap with all necessary providers */}
              <SubmitQueryProvider>
                <WebInterfaceProvider
                  enabled={webEnabled}
                  openBrowser={webOpenBrowser}
                  port={webPort}
                >
                  <FooterProvider>
                    <LoadingStateProvider>
                      <ToolConfirmationProvider>
                        <TerminalCaptureWrapper>
                          <AppContainer
                            config={config}
                            settings={settings}
                            startupWarnings={startupWarnings}
                            version={version}
                            initializationResult={initializationResult}
                            // Pass web interface flags (already handled in WebInterfaceProvider)
                          />
                        </TerminalCaptureWrapper>
                      </ToolConfirmationProvider>
                    </LoadingStateProvider>
                  </FooterProvider>
                </WebInterfaceProvider>
              </SubmitQueryProvider>
              {/* WEB_INTERFACE_END */}
            </VimModeProvider>
          </SessionStatsProvider>
        </KeypressProvider>
      </SettingsContext.Provider>
    );
  };

  const instance = render(
    process.env['DEBUG'] ? (
      <React.StrictMode>
        <AppWrapper />
      </React.StrictMode>
    ) : (
      <AppWrapper />
    ),
    {
      exitOnCtrlC: false,
      isScreenReaderEnabled: config.getScreenReader(),
      onRender: ({ renderTime }: { renderTime: number }) => {
        if (renderTime > SLOW_RENDER_MS) {
          recordSlowRender(config, renderTime);
        }
      },
    } as RenderOptions,
  );

  checkForUpdates(settings)
    .then((info) => {
      handleAutoUpdate(info, settings, config.getProjectRoot());
    })
    .catch((err) => {
      // Silently ignore update check errors.
      if (config.getDebugMode()) {
        debugLogger.warn('Update check failed:', err);
      }
    });

  registerCleanup(() => instance.unmount());
}

export async function main() {
  setupUnhandledRejectionHandler();
  const settings = loadSettings();
  migrateDeprecatedSettings(
    settings,
    // Temporary extension manager only used during this non-interactive UI phase.
    new ExtensionManager({
      workspaceDir: process.cwd(),
      settings: settings.merged,
      enabledExtensionOverrides: [],
      requestConsent: requestConsentNonInteractive,
      requestSetting: null,
    }),
  );

  // Initialize i18n system with settings-based language or fallback to detection
  const language = settings.merged.ui?.language || detectLanguage();
  await initI18n(language);
  await cleanupCheckpoints();

  const argv = await parseArguments(settings.merged);

  // Check for invalid input combinations early to prevent crashes
  if (argv.promptInteractive && !process.stdin.isTTY) {
    debugLogger.error(
      t(
        'cli.errors.prompt_interactive_stdin',
        'Error: The --prompt-interactive flag cannot be used when input is piped from stdin.',
      ),
    );
    process.exit(1);
  }

  const isDebugMode = cliConfig.isDebugMode(argv);
  const consolePatcher = new ConsolePatcher({
    stderr: true,
    debugMode: isDebugMode,
  });
  consolePatcher.patch();
  registerCleanup(consolePatcher.cleanup);

  dns.setDefaultResultOrder(
    validateDnsResolutionOrder(settings.merged.advanced?.dnsResolutionOrder),
  );

  // Set a default auth type if one isn't set.
  if (!settings.merged.security?.auth?.selectedType) {
    if (process.env['CLOUD_SHELL'] === 'true') {
      settings.setValue(
        SettingScope.User,
        'selectedAuthType',
        AuthType.CLOUD_SHELL,
      );
    }
  }

  // Load custom themes from settings
  themeManager.loadCustomThemes(settings.merged.ui?.customThemes);

  if (settings.merged.ui?.theme) {
    if (!themeManager.setActiveTheme(settings.merged.ui?.theme)) {
      // If the theme is not found during initial load, log a warning and continue.
      // The useThemeCommand hook in AppContainer.tsx will handle opening the dialog.
      debugLogger.warn(
        `Warning: Theme "${settings.merged.ui?.theme}" not found.`,
      );
    }
  }

  // hop into sandbox if we are outside and sandboxing is enabled
  if (!process.env['SANDBOX']) {
    const memoryArgs = settings.merged.advanced?.autoConfigureMemory
      ? getNodeMemoryArgs(isDebugMode)
      : [];
    const sandboxConfig = await loadSandboxConfig(settings.merged, argv);
    // We intentionally omit the list of extensions here because extensions
    // should not impact auth or setting up the sandbox.
    // TODO(jacobr): refactor loadCliConfig so there is a minimal version
    // that only initializes enough config to enable refreshAuth or find
    // another way to decouple refreshAuth from requiring a config.

    if (sandboxConfig) {
      const partialConfig = await loadCliConfig(
        settings.merged,
        sessionId,
        argv,
      );

      if (
        settings.merged.security?.auth?.selectedType &&
        !settings.merged.security?.auth?.useExternal
      ) {
        // Validate authentication here because the sandbox will interfere with the Oauth2 web redirect.
        try {
          const err = validateAuthMethod(
            settings.merged.security.auth.selectedType,
          );
          if (err) {
            throw new Error(err);
          }

          await partialConfig.refreshAuth(
            settings.merged.security.auth.selectedType,
          );
        } catch (err) {
          debugLogger.error('Error authenticating:', err);
          process.exit(1);
        }
      }
      let stdinData = '';
      if (!process.stdin.isTTY) {
        stdinData = await readStdin();
      }

      // This function is a copy of the one from sandbox.ts
      // It is moved here to decouple sandbox.ts from the CLI's argument structure.
      const injectStdinIntoArgs = (
        args: string[],
        stdinData?: string,
      ): string[] => {
        const finalArgs = [...args];
        if (stdinData) {
          const promptIndex = finalArgs.findIndex(
            (arg) => arg === '--prompt' || arg === '-p',
          );
          if (promptIndex > -1 && finalArgs.length > promptIndex + 1) {
            // If there's a prompt argument, prepend stdin to it
            finalArgs[promptIndex + 1] =
              `${stdinData}\n\n${finalArgs[promptIndex + 1]}`;
          } else {
            // If there's no prompt argument, add stdin as the prompt
            finalArgs.push('--prompt', stdinData);
          }
        }
        return finalArgs;
      };

      const sandboxArgs = injectStdinIntoArgs(process.argv, stdinData);

      await relaunchOnExitCode(() =>
        start_sandbox(sandboxConfig, memoryArgs, partialConfig, sandboxArgs),
      );
      process.exit(0);
    } else {
      // Relaunch app so we always have a child process that can be internally
      // restarted if needed.
      await relaunchAppInChildProcess(memoryArgs, []);
    }
  }

  // We are now past the logic handling potentially launching a child process
  // to run Gemini CLI. It is now safe to perform expensive initialization that
  // may have side effects.
  {
    const config = await loadCliConfig(settings.merged, sessionId, argv);

    const policyEngine = config.getPolicyEngine();
    const messageBus = config.getMessageBus();
    createPolicyUpdater(policyEngine, messageBus);

    // Cleanup sessions after config initialization
    await cleanupExpiredSessions(config, settings.merged);

    if (config.getListExtensions()) {
      debugLogger.log('Installed extensions:');
      for (const extension of config.getExtensions()) {
        debugLogger.log(`- ${extension.name}`);
      }
      process.exit(0);
    }

    const wasRaw = process.stdin.isRaw;
    if (config.isInteractive() && !wasRaw && process.stdin.isTTY) {
      // Set this as early as possible to avoid spurious characters from
      // input showing up in the output.
      process.stdin.setRawMode(true);

      // This cleanup isn't strictly needed but may help in certain situations.
      process.on('SIGTERM', () => {
        process.stdin.setRawMode(wasRaw);
      });
      process.on('SIGINT', () => {
        process.stdin.setRawMode(wasRaw);
      });

      // Detect and enable Kitty keyboard protocol once at startup.
      await detectAndEnableKittyProtocol();
    }

    setMaxSizedBoxDebugging(isDebugMode);
    const initializationResult = await initializeApp(config, settings);

    if (
      settings.merged.security?.auth?.selectedType ===
        AuthType.LOGIN_WITH_GOOGLE &&
      config.isBrowserLaunchSuppressed()
    ) {
      // Do oauth before app renders to make copying the link possible.
      await getOauthClient(settings.merged.security.auth.selectedType, config);
    }

    if (config.getExperimentalZedIntegration()) {
      return runZedIntegration(config, settings, argv);
    }

    let input = config.getQuestion();
    const startupWarnings = [
      ...(await getStartupWarnings()),
      ...(await getUserStartupWarnings()),
    ];

    // Render UI, passing necessary config values. Check that there is no command line question.
    if (config.isInteractive()) {
      // WEB_INTERFACE_START: Extract web interface flags from argv
      const webEnabled = !!argv.web;
      const webOpenBrowser = argv.web !== 'no-browser';
      const webPort = argv.port;
      // WEB_INTERFACE_END

      await startInteractiveUI(
        config,
        settings,
        startupWarnings,
        process.cwd(),
        initializationResult,
        // WEB_INTERFACE_START: Pass web interface flags
        webEnabled,
        webOpenBrowser,
        webPort,
        // WEB_INTERFACE_END
      );
      return;
    }

    await config.initialize();

    // If not a TTY, read from stdin
    // This is for cases where the user pipes input directly into the command
    if (!process.stdin.isTTY) {
      const stdinData = await readStdin();
      if (stdinData) {
        input = `${stdinData}\n\n${input}`;
      }
    }
    if (!input) {
      debugLogger.error(
        t(
          'stdin.no_input_error',
          'No input provided via stdin. Input can be provided by piping data into auditaria or using the --prompt option.',
        ),
      );
      process.exit(1);
    }

    const prompt_id = Math.random().toString(16).slice(2);
    logUserPrompt(
      config,
      new UserPromptEvent(
        input.length,
        prompt_id,
        config.getContentGeneratorConfig()?.authType,
        input,
      ),
    );

    const nonInteractiveConfig = await validateNonInteractiveAuth(
      settings.merged.security?.auth?.selectedType,
      settings.merged.security?.auth?.useExternal,
      config,
      settings,
    );

    if (config.getDebugMode()) {
      debugLogger.log(t('stats.labels.session_id', 'Session ID:'), sessionId);
    }

    const hasDeprecatedPromptArg = process.argv.some((arg) =>
      arg.startsWith('--prompt'),
    );
    await runNonInteractive({
      config: nonInteractiveConfig,
      settings,
      input,
      prompt_id,
      hasDeprecatedPromptArg,
    });
    // Call cleanup before process.exit, which causes cleanup to not run
    await runExitCleanup();
    process.exit(0);
  }
}

function setWindowTitle(title: string, settings: LoadedSettings) {
  if (!settings.merged.ui?.hideWindowTitle) {
    const windowTitle = computeWindowTitle(title);
    process.stdout.write(`\x1b]2;${windowTitle}\x07`);

    process.on('exit', () => {
      process.stdout.write(`\x1b]2;\x07`);
    });
  }
}
