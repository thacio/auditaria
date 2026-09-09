/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_REWIND_FEATURE: Session picker shared by native provider resume commands

import type React from 'react';
import { Box, Text } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { BaseSelectionList } from './shared/BaseSelectionList.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';
import { Command } from '../key/keyMatchers.js';
import { formatTimeAgo } from '../utils/formatters.js';
import type { ExternalSessionInfo } from '@google/gemini-cli-core';
import { useMemo } from 'react';

interface ExternalSessionPickerProps {
  providerName: string;
  sessions: ExternalSessionInfo[];
  onSelect: (session: ExternalSessionInfo) => void;
  onExit: () => void;
}

const MAX_PROMPT_LENGTH = 120;

export const ExternalSessionPicker: React.FC<ExternalSessionPickerProps> = ({
  providerName,
  sessions,
  onSelect,
  onExit,
}) => {
  const keyMatchers = useKeyMatchers();
  const { terminalWidth } = useUIState();

  const items = useMemo(
    () => sessions.map((s) => ({ key: s.sessionId, value: s })),
    [sessions],
  );

  useKeypress(
    (key) => {
      if (keyMatchers[Command.ESCAPE](key)) {
        onExit();
        return true;
      }
      return false;
    },
    { isActive: true },
  );

  return (
    <Box
      borderStyle="round"
      borderColor={theme.border.default}
      flexDirection="column"
      width={terminalWidth}
      paddingX={1}
      paddingY={1}
    >
      <Box marginBottom={1}>
        <Text bold>
          {'> '}Resume {providerName} Session
        </Text>
      </Box>

      <BaseSelectionList
        items={items}
        initialIndex={0}
        isFocused={true}
        showNumbers={false}
        wrapAround={false}
        onSelect={(session: ExternalSessionInfo) => {
          onSelect(session);
        }}
        renderItem={(itemWrapper: {
          key: string;
          value: ExternalSessionInfo;
        }) => {
          const session = itemWrapper.value;
          const prompt =
            session.firstPrompt.length > MAX_PROMPT_LENGTH
              ? session.firstPrompt.slice(0, MAX_PROMPT_LENGTH) + '...'
              : session.firstPrompt;
          const timeAgo = formatTimeAgo(session.timestamp);
          const shortId = session.sessionId.slice(0, 8);
          const sizeKB = Math.round(session.fileSize / 1024);

          return (
            <Box flexDirection="column">
              <Text>{prompt}</Text>
              <Box>
                <Text color={theme.text.secondary}>{timeAgo}</Text>
                <Text color={theme.text.secondary}>{' · '}</Text>
                <Text color={theme.text.secondary}>{sizeKB}KB</Text>
                <Text color={theme.text.secondary}>{' · '}</Text>
                <Text dimColor>{shortId}</Text>
              </Box>
            </Box>
          );
        }}
      />

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>Enter to resume, Esc to cancel</Text>
      </Box>
    </Box>
  );
};
