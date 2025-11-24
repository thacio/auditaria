/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ThoughtSummary } from '@google/gemini-cli-core';
import type React from 'react';
import { useEffect } from 'react';
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
import { INTERACTIVE_SHELL_WAITING_PHRASE } from '../hooks/usePhraseCycler.js';

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

  // Update loading state for web interface
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
  }, [streamingState, currentLoadingPhrase, elapsedTime, thought]);
  // WEB_INTERFACE_END

  if (streamingState === StreamingState.Idle) {
    return null;
  }

  // Prioritize the interactive shell waiting phrase over the thought subject
  // because it conveys an actionable state for the user (waiting for input).
  const primaryText =
    currentLoadingPhrase === INTERACTIVE_SHELL_WAITING_PHRASE
      ? currentLoadingPhrase
      : thought?.subject || currentLoadingPhrase;

  const cancelAndTimerContent =
    streamingState !== StreamingState.WaitingForConfirmation
      ? `(esc to cancel, ${elapsedTime < 60 ? `${elapsedTime}s` : formatDuration(elapsedTime * 1000)})`
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
            <>
              <Box flexShrink={0} width={1} />
              <Text color={theme.text.secondary}>{cancelAndTimerContent}</Text>
            </>
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