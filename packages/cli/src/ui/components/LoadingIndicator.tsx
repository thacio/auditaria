/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ThoughtSummary } from '@thacio/auditaria-cli-core';
import { t } from '@thacio/auditaria-cli-core';

import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useStreamingContext } from '../contexts/StreamingContext.js';
import { StreamingState } from '../types.js';
import { GeminiRespondingSpinner } from './GeminiRespondingSpinner.js';
import { formatDuration } from '../utils/formatters.js';
// WEB_INTERFACE_START: Loading state context import for web interface integration
import { useLoadingState } from '../contexts/LoadingStateContext.js';
// WEB_INTERFACE_END
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

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
  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);
  
  // WEB_INTERFACE_START: Loading state context for broadcasting to web interface
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
  // WEB_INTERFACE_END

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  const primaryText = thought?.subject || currentLoadingPhrase;

  const cancelAndTimerContent =
    streamingState !== StreamingState.WaitingForConfirmation
      ? t('loading_indicator.esc_to_cancel', '(esc to cancel, {time})', {
          time: elapsedTime < 60 
            ? t('loading_indicator.seconds', '{elapsed}s', { elapsed: elapsedTime }) 
            : formatDuration(elapsedTime * 1000)
        })
      : null;

  return (
    <Box paddingLeft={0} flexDirection="column">
      {/* Main loading line */}
      <Box
        width="100%"
        flexDirection={isNarrow ? 'column' : 'row'}
        alignItems={isNarrow ? 'flex-start' : 'center'}
      >
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
          {primaryText && (
            <Text color={theme.text.accent} wrap="truncate-end">
              {primaryText}
            </Text>
          )}
          {!isNarrow && cancelAndTimerContent && (
            <Text color={theme.text.secondary}> {cancelAndTimerContent}</Text>
          )}
        </Box>
        {!isNarrow && <Box flexGrow={1}>{/* Spacer */}</Box>}
        {!isNarrow && rightContent && <Box>{rightContent}</Box>}
      </Box>
      {isNarrow && cancelAndTimerContent && (
        <Box>
          <Text color={theme.text.secondary}>{cancelAndTimerContent}</Text>
        </Box>
      )}
      {isNarrow && rightContent && <Box>{rightContent}</Box>}
    </Box>
  );
};