/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { type Config } from '@thacio/auditaria-cli-core';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config }) => {
  const geminiMdFileCount = config.getGeminiMdFileCount();
  return (
    <Box flexDirection="column">
      <Text color={theme.text.primary}>{t('tips.title', 'Tips for getting started:')}</Text>
      <Text color={theme.text.primary}>
        1. {t('tips.tip1', 'Ask questions, edit files, or run commands.')}
      </Text>
      <Text color={theme.text.primary}>
        2. {t('tips.tip2', 'Be specific for the best results.')}
      </Text>
      {geminiMdFileCount === 0 && (
        <Text color={theme.text.primary}>
          3. {t('tips.tip3_with_gemini', 'Create {filename} files to customize your interactions with Gemini.', { filename: 'GEMINI.md' })}
        </Text>
      )}
      <Text color={theme.text.primary}>
        {geminiMdFileCount === 0 ? '4.' : '3.'} {t('tips.tip4', '{command} for more information.', { command: '/help' })}
      </Text>
    </Box>
  );
};
