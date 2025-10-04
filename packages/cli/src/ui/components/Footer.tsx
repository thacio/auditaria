/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t ,
  shortenPath,
  tildeifyPath,
  tokenLimit,
} from '@thacio/auditaria-cli-core';

import type React from 'react';
import { useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';
import process from 'node:process';
import path from 'node:path';
import Gradient from 'ink-gradient';
import { MemoryUsageDisplay } from './MemoryUsageDisplay.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { DebugProfiler } from './DebugProfiler.js';
// WEB_INTERFACE_START: Footer context import for web interface integration
import { useFooter } from '../contexts/FooterContext.js';
// WEB_INTERFACE_END

import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

import { useUIState } from '../contexts/UIStateContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';

export const Footer: React.FC = () => {
  const uiState = useUIState();
  const config = useConfig();
  const settings = useSettings();
  const { vimEnabled, vimMode } = useVimMode();

  const {
    model,
    targetDir,
    debugMode,
    branchName,
    debugMessage,
    corgiMode,
    errorCount,
    showErrorDetails,
    promptTokenCount,
    nightly,
    isTrustedFolder,
  } = {
    model: config.getModel(),
    targetDir: config.getTargetDir(),
    debugMode: config.getDebugMode(),
    branchName: uiState.branchName,
    debugMessage: uiState.debugMessage,
    corgiMode: uiState.corgiMode,
    errorCount: uiState.errorCount,
    showErrorDetails: uiState.showErrorDetails,
    promptTokenCount: uiState.sessionStats.lastPromptTokenCount,
    nightly: uiState.nightly,
    isTrustedFolder: uiState.isTrustedFolder,
  };

  const showMemoryUsage =
    config.getDebugMode() || settings.merged.ui?.showMemoryUsage || false;
  const hideCWD = settings.merged.ui?.footer?.hideCWD || false;
  const hideSandboxStatus =
    settings.merged.ui?.footer?.hideSandboxStatus || false;
  const hideModelInfo = settings.merged.ui?.footer?.hideModelInfo || false;

  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);
  const limit = tokenLimit(model);
  const percentage = promptTokenCount / limit;

  // WEB_INTERFACE_START: Footer context for broadcasting data to web interface
  const footerContext = useFooter();

  // Update footer data for web interface (removed footerContext from dependencies)
  useEffect(() => {
    if (footerContext) {
      // Determine sandbox status
      let sandboxStatus = 'no sandbox';
      if (process.env['SANDBOX'] && process.env['SANDBOX'] !== 'sandbox-exec') {
        sandboxStatus = process.env['SANDBOX'].replace(/^gemini-(?:cli-)?/, '');
      } else if (process.env['SANDBOX'] === 'sandbox-exec') {
        sandboxStatus = 'macOS Seatbelt';
      }

      const footerData = {
        targetDir,
        branchName,
        model,
        contextPercentage: (1 - percentage) * 100, // Remaining context percentage
        sandboxStatus,
        errorCount,
        debugMode,
        debugMessage,
        corgiMode,
        showMemoryUsage: !!showMemoryUsage,
        nightly,
        showErrorDetails,
        vimMode,
      };

      footerContext.updateFooterData(footerData);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    model,
    targetDir,
    branchName,
    debugMode,
    debugMessage,
    errorCount,
    percentage,
    corgiMode,
    showMemoryUsage,
    nightly,
    showErrorDetails,
    vimMode,
    // Removed footerContext from dependencies to prevent infinite loop
  ]);
  // WEB_INTERFACE_END

  // Adjust path length based on terminal width
  const pathLength = Math.max(20, Math.floor(terminalWidth * 0.4));
  const displayPath = isNarrow
    ? path.basename(tildeifyPath(targetDir))
    : shortenPath(tildeifyPath(targetDir), pathLength);

  const justifyContent = hideCWD && hideModelInfo ? 'center' : 'space-between';
  const displayVimMode = vimEnabled ? vimMode : undefined;

  return (
    <Box
      justifyContent={justifyContent}
      width="100%"
      flexDirection={isNarrow ? 'column' : 'row'}
      alignItems={isNarrow ? 'flex-start' : 'center'}
    >
      {(debugMode || displayVimMode || !hideCWD) && (
        <Box>
          {debugMode && <DebugProfiler />}
          {displayVimMode && (
            <Text color={theme.text.secondary}>[{displayVimMode}] </Text>
          )}
          {!hideCWD &&
            (nightly ? (
              <Gradient colors={theme.ui.gradient}>
                <Text>
                  {displayPath}
                  {branchName && <Text> ({branchName}*)</Text>}
                </Text>
              </Gradient>
            ) : (
              <Text color={theme.text.link}>
                {displayPath}
                {branchName && (
                  <Text color={theme.text.secondary}> ({branchName}*)</Text>
                )}
              </Text>
            ))}
          {debugMode && (
            <Text color={theme.status.error}>
              {' ' + (debugMessage || '--debug')}
            </Text>
          )}
        </Box>
      )}

      {/* Middle Section: Centered Trust/Sandbox Info */}
      {!hideSandboxStatus && (
        <Box
          flexGrow={isNarrow || hideCWD || hideModelInfo ? 0 : 1}
          alignItems="center"
          justifyContent={isNarrow || hideCWD ? 'flex-start' : 'center'}
          display="flex"
          paddingX={isNarrow ? 0 : 1}
          paddingTop={isNarrow ? 1 : 0}
        >
          {isTrustedFolder === false ? (
            <Text color={theme.status.warning}>
              {t('footer.untrusted', 'untrusted')}
            </Text>
          ) : process.env['SANDBOX'] &&
            process.env['SANDBOX'] !== 'sandbox-exec' ? (
            <Text color="green">
              {process.env['SANDBOX'].replace(/^gemini-(?:cli-)?/, '')}
            </Text>
          ) : process.env['SANDBOX'] === 'sandbox-exec' ? (
            <Text color={theme.status.warning}>
              {t('footer.macos_seatbelt', 'macOS Seatbelt')}{' '}
              <Text color={theme.text.secondary}>
                ({process.env['SEATBELT_PROFILE']})
              </Text>
            </Text>
          ) : (
            <Text color={theme.status.error}>
              {t('footer.no_sandbox', 'no sandbox')}{' '}
              <Text color={theme.text.secondary}>
                {t('footer.see_docs', '(see /docs)')}
              </Text>
            </Text>
          )}
        </Box>
      )}

      {/* Right Section: Gemini Label and Console Summary */}
      {(!hideModelInfo ||
        showMemoryUsage ||
        corgiMode ||
        (!showErrorDetails && errorCount > 0)) && (
        <Box alignItems="center" paddingTop={isNarrow ? 1 : 0}>
          {!hideModelInfo && (
            <Box alignItems="center">
              <Text color={theme.text.accent}>
                {isNarrow ? '' : ' '}
                {model}{' '}
                <ContextUsageDisplay
                  promptTokenCount={promptTokenCount}
                  model={model}
                />
              </Text>
              {showMemoryUsage && <MemoryUsageDisplay />}
            </Box>
          )}
          <Box alignItems="center" paddingLeft={2}>
            {corgiMode && (
              <Text>
                {!hideModelInfo && <Text color={theme.ui.comment}>| </Text>}
                <Text color={theme.status.error}>▼</Text>
                <Text color={theme.text.primary}>(´</Text>
                <Text color={theme.status.error}>ᴥ</Text>
                <Text color={theme.text.primary}>`)</Text>
                <Text color={theme.status.error}>▼ </Text>
              </Text>
            )}
            {!showErrorDetails && errorCount > 0 && (
              <Box>
                {!hideModelInfo && <Text color={theme.ui.comment}>| </Text>}
                <ConsoleSummaryDisplay errorCount={errorCount} />
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
