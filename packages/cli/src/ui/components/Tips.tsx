/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { type Config } from '@google/gemini-cli-core';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config }) => {
  const geminiMdFileCount = config.getGeminiMdFileCount();

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.text.primary}>Tips for getting started:</Text>
      {geminiMdFileCount === 0 && (
        <Text color={theme.text.primary}>
          1. Create <Text bold>GEMINI.md</Text> files to customize your
          interactions
        </Text>
      )}
      <Text color={theme.text.primary}>
        {geminiMdFileCount === 0 ? '2.' : '1.'}{' '}
        <Text color={theme.text.secondary}>/help</Text> for more information
      </Text>
      <Text color={theme.text.primary}>
        {geminiMdFileCount === 0 ? '3.' : '2.'} Ask coding questions, edit code
        or run commands
      </Text>
      <Text color={theme.text.primary}>
        {geminiMdFileCount === 0 ? '4.' : '3.'} Be specific for the best results
      </Text>
      {/* AUDITARIA_PROVIDER_ONLY: surface the no-Google-account / provider option */}
      <Text color={theme.text.primary}>
        {geminiMdFileCount === 0 ? '5.' : '4.'} No Google account? Run{' '}
        <Text color={theme.text.secondary}>/auth</Text> to use Claude Code,
        Codex, Copilot, or Antigravity, or{' '}
        <Text color={theme.text.secondary}>/model</Text> to switch provider
        anytime
      </Text>
    </Box>
  );
};
