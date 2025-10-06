/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t, tokenLimit } from '@thacio/auditaria-cli-core';

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
}: {
  promptTokenCount: number;
  model: string;
}) => {
  const percentage = promptTokenCount / tokenLimit(model);

  return (
    <Text color={theme.text.secondary}>
      ({((1 - percentage) * 100).toFixed(0)}
      {t('footer.context_left_full', '% context left', {})})
    </Text>
  );
};
