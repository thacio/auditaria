/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import {
  type ConversationRecord,
  type MessageRecord,
  partToString,
  type FileCheckpointManager, // AUDITARIA_REWIND
} from '@google/gemini-cli-core';
import { BaseSelectionList } from './shared/BaseSelectionList.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useRewind } from '../hooks/useRewind.js';
import { RewindConfirmation, RewindOutcome } from './RewindConfirmation.js';
import { stripReferenceContent } from '../utils/formatters.js';
import { Command } from '../key/keyMatchers.js';
import { CliSpinner } from './CliSpinner.js';
import { ExpandableText } from './shared/ExpandableText.js';
import { useKeyMatchers } from '../hooks/useKeyMatchers.js';

interface RewindViewerProps {
  conversation: ConversationRecord;
  onExit: () => void;
  onRewind: (
    messageId: string,
    newText: string,
    outcome: RewindOutcome,
  ) => Promise<void>;
  forceShowRevert?: boolean; // AUDITARIA_REWIND: Show revert options for external providers
  fileCheckpointManager?: FileCheckpointManager; // AUDITARIA_REWIND: Provides file stats for external providers
}

const MAX_LINES_PER_BOX = 2;

const getCleanedRewindText = (userPrompt: MessageRecord): string => {
  const contentToUse = userPrompt.displayContent || userPrompt.content;
  const originalUserText = contentToUse ? partToString(contentToUse) : '';
  return userPrompt.displayContent
    ? originalUserText
    : stripReferenceContent(originalUserText);
};

export const RewindViewer: React.FC<RewindViewerProps> = ({
  conversation,
  onExit,
  onRewind,
  forceShowRevert, // AUDITARIA_REWIND
  fileCheckpointManager, // AUDITARIA_REWIND
}) => {
  const keyMatchers = useKeyMatchers();
  const [isRewinding, setIsRewinding] = useState(false);
  const { terminalWidth, terminalHeight } = useUIState();
  const isScreenReaderEnabled = useIsScreenReaderEnabled();
  const {
    selectedMessageId,
    getStats,
    confirmationStats,
    selectMessage,
    clearSelection,
  } = useRewind(conversation);

  // AUDITARIA_REWIND_START: Precompute checkpoint stats for all user messages by turn index
  const [checkpointStatsMap, setCheckpointStatsMap] = useState<
    Map<string, { fileCount: number; insertions: number; deletions: number }>
  >(new Map());
  useEffect(() => {
    if (!fileCheckpointManager) return;
    const snapshotCount = fileCheckpointManager.getSnapshotCount();
    if (snapshotCount === 0) return;

    const userMessages = conversation.messages.filter((m) => m.type === 'user');
    Promise.all(
      userMessages.map(async (msg, idx) => {
        // Each user message at index idx maps to snapshot at index idx
        if (idx >= snapshotCount) return null;
        const stats = await fileCheckpointManager.getDiffStatsForTurn(idx);
        return stats ? ([msg.id, { fileCount: stats.fileCount, insertions: stats.insertions, deletions: stats.deletions }] as const) : null;
      }),
    ).then((results) => {
      const map = new Map<string, { fileCount: number; insertions: number; deletions: number }>();
      for (const r of results) {
        if (r) map.set(r[0], r[1]);
      }
      setCheckpointStatsMap(map);
    }).catch(() => {});
  }, [fileCheckpointManager, conversation.messages]);
  // AUDITARIA_REWIND_END

  const [highlightedMessageId, setHighlightedMessageId] = useState<
    string | null
  >(null);
  const [expandedMessageId, setExpandedMessageId] = useState<string | null>(
    null,
  );

  const interactions = useMemo(
    () => conversation.messages.filter((msg) => msg.type === 'user'),
    [conversation.messages],
  );

  const items = useMemo(() => {
    const interactionItems = interactions.map((msg, idx) => ({
      key: `${msg.id || 'msg'}-${idx}`,
      value: msg,
      index: idx,
    }));

    // Add "Current Position" as the last item
    return [
      ...interactionItems,
      {
        key: 'current-position',
        value: {
          id: 'current-position',
          type: 'user',
          content: 'Stay at current position',
          timestamp: new Date().toISOString(),
        } as MessageRecord,
        index: interactionItems.length,
      },
    ];
  }, [interactions]);

  useKeypress(
    (key) => {
      if (!selectedMessageId) {
        if (keyMatchers[Command.ESCAPE](key)) {
          onExit();
          return true;
        }
        if (keyMatchers[Command.EXPAND_SUGGESTION](key)) {
          if (
            highlightedMessageId &&
            highlightedMessageId !== 'current-position'
          ) {
            setExpandedMessageId(highlightedMessageId);
            return true;
          }
        }
        if (keyMatchers[Command.COLLAPSE_SUGGESTION](key)) {
          setExpandedMessageId(null);
          return true;
        }
      }
      return false;
    },
    { isActive: true },
  );

  // Height constraint calculations
  const DIALOG_PADDING = 2; // Top/bottom padding
  const HEADER_HEIGHT = 2; // Title + margin
  const CONTROLS_HEIGHT = 2; // Controls text + margin

  const listHeight = Math.max(
    5,
    terminalHeight - DIALOG_PADDING - HEADER_HEIGHT - CONTROLS_HEIGHT - 2,
  );
  const maxItemsToShow = Math.max(1, Math.floor(listHeight / 4));

  if (selectedMessageId) {
    if (isRewinding) {
      return (
        <Box
          borderStyle="round"
          borderColor={theme.border.default}
          padding={1}
          width={terminalWidth}
          flexDirection="row"
        >
          <Box>
            <CliSpinner />
          </Box>
          <Text>Rewinding...</Text>
        </Box>
      );
    }

    if (selectedMessageId === 'current-position') {
      onExit();
      return null;
    }

    const selectedMessage = interactions.find(
      (m) => m.id === selectedMessageId,
    );
    // AUDITARIA_REWIND_START: Use checkpoint stats as fallback for confirmation
    let effectiveConfirmationStats = confirmationStats;
    if (!effectiveConfirmationStats && selectedMessageId) {
      const cpStats = checkpointStatsMap.get(selectedMessageId);
      if (cpStats) {
        effectiveConfirmationStats = {
          addedLines: cpStats.insertions,
          removedLines: cpStats.deletions,
          fileCount: cpStats.fileCount,
        };
      }
    }
    // AUDITARIA_REWIND_END
    return (
      <RewindConfirmation
        stats={effectiveConfirmationStats}
        forceShowRevert={forceShowRevert}
        terminalWidth={terminalWidth}
        timestamp={selectedMessage?.timestamp}
        onConfirm={(outcome) => {
          if (outcome === RewindOutcome.Cancel) {
            clearSelection();
          } else {
            void (async () => {
              const userPrompt = interactions.find(
                (m) => m.id === selectedMessageId,
              );
              if (userPrompt) {
                const cleanedText = getCleanedRewindText(userPrompt);
                setIsRewinding(true);
                await onRewind(selectedMessageId, cleanedText, outcome);
              }
            })();
          }
        }}
      />
    );
  }

  if (isScreenReaderEnabled) {
    return (
      <Box flexDirection="column" width={terminalWidth}>
        <Text bold>Rewind - Select a conversation point:</Text>
        <BaseSelectionList
          items={items}
          initialIndex={items.length - 1}
          isFocused={true}
          showNumbers={true}
          wrapAround={false}
          onSelect={(item: MessageRecord) => {
            if (item?.id) {
              if (item.id === 'current-position') {
                onExit();
              } else {
                selectMessage(item.id);
              }
            }
          }}
          renderItem={(itemWrapper) => {
            const item = itemWrapper.value;
            const text =
              item.id === 'current-position'
                ? 'Stay at current position'
                : getCleanedRewindText(item);
            return <Text>{text}</Text>;
          }}
        />
        <Text color={theme.text.secondary}>
          Press Esc to exit, Enter to select, arrow keys to navigate.
        </Text>
      </Box>
    );
  }

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
        <Text bold>{'> '}Rewind</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        <BaseSelectionList
          items={items}
          initialIndex={items.length - 1}
          isFocused={true}
          showNumbers={false}
          wrapAround={false}
          onSelect={(item: MessageRecord) => {
            const userPrompt = item;
            if (userPrompt && userPrompt.id) {
              if (userPrompt.id === 'current-position') {
                onExit();
              } else {
                selectMessage(userPrompt.id);
              }
            }
          }}
          onHighlight={(item: MessageRecord) => {
            if (item.id) {
              setHighlightedMessageId(item.id);
              // Collapse when moving selection
              setExpandedMessageId(null);
            }
          }}
          maxItemsToShow={maxItemsToShow}
          renderItem={(itemWrapper, { isSelected }) => {
            const userPrompt = itemWrapper.value;

            if (userPrompt.id === 'current-position') {
              return (
                <Box flexDirection="column" marginBottom={1}>
                  <Text
                    color={
                      isSelected ? theme.status.success : theme.text.primary
                    }
                  >
                    {partToString(
                      userPrompt.displayContent || userPrompt.content,
                    )}
                  </Text>
                  <Text color={theme.text.secondary}>
                    Cancel rewind and stay here
                  </Text>
                </Box>
              );
            }

            // AUDITARIA_REWIND_START: Use checkpoint stats as fallback for external providers
            let stats = getStats(userPrompt);
            if (!stats) {
              const cpStats = checkpointStatsMap.get(userPrompt.id);
              if (cpStats) {
                stats = {
                  addedLines: cpStats.insertions,
                  removedLines: cpStats.deletions,
                  fileCount: cpStats.fileCount,
                };
              }
            }
            // AUDITARIA_REWIND_END
            const firstFileName = stats?.details?.at(0)?.fileName;
            const cleanedText = getCleanedRewindText(userPrompt);

            return (
              <Box flexDirection="column" marginBottom={1}>
                <Box>
                  <ExpandableText
                    label={cleanedText}
                    isExpanded={expandedMessageId === userPrompt.id}
                    textColor={
                      isSelected ? theme.status.success : theme.text.primary
                    }
                    maxWidth={(terminalWidth - 4) * MAX_LINES_PER_BOX}
                    maxLines={MAX_LINES_PER_BOX}
                  />
                </Box>
                {stats ? (
                  <Box flexDirection="row">
                    <Text color={theme.text.secondary}>
                      {stats.fileCount === 1
                        ? firstFileName
                          ? firstFileName
                          : '1 file changed'
                        : `${stats.fileCount} files changed`}{' '}
                    </Text>
                    {stats.addedLines > 0 && (
                      <Text color="green">+{stats.addedLines} </Text>
                    )}
                    {stats.removedLines > 0 && (
                      <Text color="red">-{stats.removedLines}</Text>
                    )}
                  </Box>
                ) : (
                  <Text color={theme.text.secondary}>
                    No files have been changed
                  </Text>
                )}
              </Box>
            );
          }}
        />
      </Box>

      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          (Use Enter to select a message, Esc to close, Right/Left to
          expand/collapse)
        </Text>
      </Box>
    </Box>
  );
};
