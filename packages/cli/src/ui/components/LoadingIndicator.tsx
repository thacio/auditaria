/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import { ThoughtSummary } from '@thacio/auditaria-cli-core';
import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { GeminiRespondingSpinner } from './GeminiRespondingSpinner.js';
import { formatDuration } from '../utils/formatters.js';
import { useLoadingState } from '../contexts/LoadingStateContext.js';

interface LoadingIndicatorProps {
  currentLoadingPhrase?: string;
  elapsedTime: number;
  rightContent?: React.ReactNode;
  thought?: ThoughtSummary | null;
}

export const LoadingIndicator: React.FC<LoadingIndicatorProps> = ({
  currentLoadingPhrase,
  elapsedTime,
  rightContent,
  thought,
}) => {
  const streamingState = useStreamingContext();
  const loadingStateContext = useLoadingState();

  // Update loading state for web interface (removed loadingStateContext from dependencies)
  useEffect(() => {
    if (loadingStateContext) {
      const loadingStateData = {
        isLoading: streamingState !== StreamingState.Idle,
        streamingState,
        currentLoadingPhrase,
        elapsedTime,
        thought: thought?.subject || null,
        thoughtObject: thought,
      };
      
      loadingStateContext.updateLoadingState(loadingStateData);
    }
  }, [streamingState, currentLoadingPhrase, elapsedTime, thought]); // Removed loadingStateContext to prevent infinite loop

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  const primaryText = thought?.subject || currentLoadingPhrase;

  return (
    <Box marginTop={1} paddingLeft={0} flexDirection="column">
      {/* Main loading line */}
      <Box>
        <Box marginRight={1}>
          <GeminiRespondingSpinner
            nonRespondingDisplay={
              streamingState === StreamingState.WaitingForConfirmation
                ? '⠏'
                : ''
            }
          />
        </Box>
        {primaryText && <Text color={Colors.AccentPurple}>{primaryText}</Text>}
        <Text color={Colors.Gray}>
          {streamingState === StreamingState.WaitingForConfirmation
            ? ''
            : t('loading_indicator.esc_to_cancel', ' (esc to cancel, {time})', {
                time: elapsedTime < 60 ? t('loading_indicator.seconds', '{elapsed}s', { elapsed: elapsedTime }) : formatDuration(elapsedTime * 1000)
              })}
        </Text>
        <Box flexGrow={1}>{/* Spacer */}</Box>
        {rightContent && <Box>{rightContent}</Box>}
      </Box>
    </Box>
  );
};
