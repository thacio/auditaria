/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { Colors } from '../colors.js';
import { t, tokenLimit } from '@google/gemini-cli-core';

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
}: {
  promptTokenCount: number;
  model: string;
}) => {
  const percentage = promptTokenCount / tokenLimit(model);

  return (
    <Text color={Colors.Gray}>
      {t('footer.context_left', '({percentage}% context left)', { percentage: ((1 - percentage) * 100).toFixed(0) })}
    </Text>
  );
};
