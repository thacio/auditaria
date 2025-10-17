/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '@thacio/auditaria-cli-core';

export const RawMarkdownIndicator: React.FC = () => {
  const modKey = process.platform === 'darwin' ? 'option+m' : 'alt+m';
  return (
    <Box>
      <Text>
        {t('raw_markdown_mode.enabled', 'raw markdown mode')}
        <Text color={theme.text.secondary}>
          {t('raw_markdown_mode.toggle_hint', ' ({key} to toggle) ', { key: modKey })}
        </Text>
      </Text>
    </Box>
  );
};
