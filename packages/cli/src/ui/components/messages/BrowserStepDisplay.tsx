/**
 * @license
 * Copyright 2025 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_FEATURE: Browser Agent Live Step Display (Phase 7)
// This component renders browser agent steps inline in the CLI

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';

/**
 * Status icons for browser steps
 */
const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  executing: '◐',
  completed: '●',
  error: '✗',
};

/**
 * Status colors for browser steps
 */
const STATUS_COLORS: Record<string, string> = {
  pending: theme.text.secondary,
  executing: theme.status.warning,
  completed: theme.status.success,
  error: theme.status.error,
};

/**
 * Information about a single browser step for display
 */
export interface BrowserStepInfo {
  stepNumber: number;
  action: string;
  reasoning?: string;
  result?: string;
  status: 'pending' | 'executing' | 'completed' | 'error';
}

/**
 * Browser step display data structure
 */
export interface BrowserStepDisplayData {
  browserSteps: BrowserStepInfo[];
  currentUrl?: string;
  status: 'running' | 'completed' | 'error' | 'cancelled';
  sessionId?: string;
  screenshotThumbnail?: string;
}

export interface BrowserStepDisplayProps {
  data: BrowserStepDisplayData;
  maxWidth?: number;
}

/**
 * Component to display browser agent steps inline
 */
export const BrowserStepDisplay: React.FC<BrowserStepDisplayProps> = ({
  data,
  maxWidth = 80,
}) => {
  const { browserSteps, currentUrl, status, sessionId } = data;

  // Truncate text to fit width
  const truncate = (text: string, maxLen: number): string => {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 3) + '...';
  };

  // Format action type for display
  const formatAction = (action: string): string => {
    // Capitalize and format common action types
    const actionMap: Record<string, string> = {
      click: 'Click',
      type: 'Type',
      navigate: 'Navigate',
      goto: 'Go to',
      scroll: 'Scroll',
      keypress: 'Key press',
      wait: 'Wait',
      screenshot: 'Screenshot',
      extract: 'Extract',
      observe: 'Observe',
    };
    return actionMap[action.toLowerCase()] || action;
  };

  return (
    <Box flexDirection="column" width={maxWidth}>
      {/* Header with session info */}
      {sessionId && (
        <Box marginBottom={1}>
          <Text color={theme.text.secondary}>
            Session: {sessionId}
            {currentUrl && ` • ${truncate(currentUrl, 50)}`}
          </Text>
        </Box>
      )}

      {/* Steps list */}
      <Box flexDirection="column">
        {browserSteps.map((step) => (
          <Box key={step.stepNumber} flexDirection="row">
            {/* Status icon */}
            <Text color={STATUS_COLORS[step.status] || theme.text.secondary}>
              {STATUS_ICONS[step.status] || '○'}{' '}
            </Text>

            {/* Step number */}
            <Text color={theme.text.secondary} dimColor>
              {step.stepNumber}.{' '}
            </Text>

            {/* Action type */}
            <Text color={theme.text.primary} bold>
              {formatAction(step.action)}
            </Text>

            {/* Reasoning (if available and not too long) */}
            {step.reasoning && (
              <Text color={theme.text.secondary}>
                {' - '}
                {truncate(step.reasoning, maxWidth - 20)}
              </Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Overall status indicator - only show when not running */}
      {status !== 'running' && (
        <Box>
        {status === 'completed' && (
          <Text color={theme.status.success}>
              ✓ Completed ({browserSteps.length} step{browserSteps.length !== 1 ? 's' : ''})
          </Text>
        )}
        {status === 'error' && (
            <Text color={theme.status.error}>✗ Error occurred</Text>
        )}
        {status === 'cancelled' && (
            <Text color={theme.text.secondary}>○ Cancelled</Text>
        )}
      </Box>
      )}
    </Box>
  );
};

/**
 * Try to parse a string as browser step display data
 * Returns the parsed data if valid, undefined otherwise
 */
export function tryParseBrowserStepDisplay(
  input: unknown,
): BrowserStepDisplayData | undefined {
  if (typeof input !== 'string') {
    // Check if it's already an object with browserSteps
    if (
      typeof input === 'object' &&
      input !== null &&
      'browserSteps' in input
    ) {
      return input as BrowserStepDisplayData;
    }
    return undefined;
  }

  // Try to parse as JSON
  if (!input.startsWith('{"browserSteps"')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(input);
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray(parsed.browserSteps)
    ) {
      return parsed as BrowserStepDisplayData;
    }
  } catch {
    // Not valid JSON
  }

  return undefined;
}
