/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { shortenPath, tildeifyPath, tokenLimit } from '@thacio/auditaria-cli-core';
import { ConsoleSummaryDisplay } from './ConsoleSummaryDisplay.js';
import process from 'node:process';
import Gradient from 'ink-gradient';
import { MemoryUsageDisplay } from './MemoryUsageDisplay.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { DebugProfiler } from './DebugProfiler.js';
// WEB_INTERFACE_START: Footer context import for web interface integration
import { useFooter } from '../contexts/FooterContext.js';
// WEB_INTERFACE_END

interface FooterProps {
  model: string;
  targetDir: string;
  branchName?: string;
  debugMode: boolean;
  debugMessage: string;
  corgiMode: boolean;
  errorCount: number;
  showErrorDetails: boolean;
  showMemoryUsage?: boolean;
  promptTokenCount: number;
  nightly: boolean;
  vimMode?: string;
}

export const Footer: React.FC<FooterProps> = ({
  model,
  targetDir,
  branchName,
  debugMode,
  debugMessage,
  corgiMode,
  errorCount,
  showErrorDetails,
  showMemoryUsage,
  promptTokenCount,
  nightly,
  vimMode,
}) => {
  const limit = tokenLimit(model);
  const percentage = promptTokenCount / limit;
  
  // WEB_INTERFACE_START: Footer context for broadcasting data to web interface
  const footerContext = useFooter();

  // Update footer data for web interface (removed footerContext from dependencies)
  useEffect(() => {
    if (footerContext) {
      // Determine sandbox status
      let sandboxStatus = 'no sandbox';
      if (process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec') {
        sandboxStatus = process.env.SANDBOX.replace(/^gemini-(?:cli-)?/, '');
      } else if (process.env.SANDBOX === 'sandbox-exec') {
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
    vimMode
    // Removed footerContext from dependencies to prevent infinite loop
  ]);
  // WEB_INTERFACE_END

  return (
  <Box justifyContent="space-between" width="100%">
    <Box>
      {debugMode && <DebugProfiler />}
      {vimMode && <Text color={Colors.Gray}>[{vimMode}] </Text>}
      {nightly ? (
        <Gradient colors={Colors.GradientColors}>
          <Text>
            {shortenPath(tildeifyPath(targetDir), 70)}
            {branchName && <Text> ({branchName}*)</Text>}
          </Text>
        </Gradient>
      ) : (
        <Text color={Colors.LightBlue}>
          {shortenPath(tildeifyPath(targetDir), 70)}
          {branchName && <Text color={Colors.Gray}> ({branchName}*)</Text>}
        </Text>
      )}
      {debugMode && (
        <Text color={Colors.AccentRed}>
          {' ' + (debugMessage || t('footer.debug_mode', '--debug'))}
        </Text>
      )}
    </Box>

    {/* Middle Section: Centered Sandbox Info */}
    <Box
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
      display="flex"
    >
      {process.env.SANDBOX && process.env.SANDBOX !== 'sandbox-exec' ? (
        <Text color="green">
          {process.env.SANDBOX.replace(/^gemini-(?:cli-)?/, '')}
        </Text>
      ) : process.env.SANDBOX === 'sandbox-exec' ? (
        <Text color={Colors.AccentYellow}>
          {t('footer.macos_seatbelt', 'macOS Seatbelt')}{' '}
          <Text color={Colors.Gray}>({process.env.SEATBELT_PROFILE})</Text>
        </Text>
      ) : (
        <Text color={Colors.AccentRed}>
          {t('footer.no_sandbox', 'no sandbox')} <Text color={Colors.Gray}>{t('footer.see_docs', '(see /docs)')}</Text>
        </Text>
      )}
    </Box>

    {/* Right Section: Gemini Label and Console Summary */}
    <Box alignItems="center">
      <Text color={Colors.AccentBlue}>
        {' '}
        {model}{' '}
        <ContextUsageDisplay
          promptTokenCount={promptTokenCount}
          model={model}
        />
      </Text>
      {corgiMode && (
        <Text>
          <Text color={Colors.Gray}>| </Text>
          <Text color={Colors.AccentRed}>▼</Text>
          <Text color={Colors.Foreground}>(´</Text>
          <Text color={Colors.AccentRed}>ᴥ</Text>
          <Text color={Colors.Foreground}>`)</Text>
          <Text color={Colors.AccentRed}>▼ </Text>
        </Text>
      )}
      {!showErrorDetails && errorCount > 0 && (
        <Box>
          <Text color={Colors.Gray}>| </Text>
          <ConsoleSummaryDisplay errorCount={errorCount} />
        </Box>
      )}
      {showMemoryUsage && <MemoryUsageDisplay />}
    </Box>
  </Box>
  );
};