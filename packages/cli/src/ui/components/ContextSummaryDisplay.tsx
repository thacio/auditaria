/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import { type IdeContext, type MCPServerConfig } from '@thacio/auditaria-cli-core';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

interface ContextSummaryDisplayProps {
  geminiMdFileCount: number;
  contextFileNames: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  blockedMcpServers?: Array<{ name: string; extensionName: string }>;
  showToolDescriptions?: boolean;
  ideContext?: IdeContext;
}

export const ContextSummaryDisplay: React.FC<ContextSummaryDisplayProps> = ({
  geminiMdFileCount,
  contextFileNames,
  mcpServers,
  blockedMcpServers,
  showToolDescriptions,
  ideContext,
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);
  const mcpServerCount = Object.keys(mcpServers || {}).length;
  const blockedMcpServerCount = blockedMcpServers?.length || 0;
  const openFileCount = ideContext?.workspaceState?.openFiles?.length ?? 0;

  if (
    geminiMdFileCount === 0 &&
    mcpServerCount === 0 &&
    blockedMcpServerCount === 0 &&
    openFileCount === 0
  ) {
    return <Text> </Text>; // Render an empty space to reserve height
  }

  const openFilesText = (() => {
    if (openFileCount === 0) {
      return '';
    }
    return t('ide_context.open_files_count', '{count} open file{plural} (ctrl+g to view)', {
      count: openFileCount,
      plural: openFileCount > 1 ? 's' : ''
    });
  })();

  const geminiMdText = (() => {
    if (geminiMdFileCount === 0) {
      return '';
    }
    const allNamesTheSame = new Set(contextFileNames).size < 2;
    const name = allNamesTheSame ? contextFileNames[0] : 'context';
    return t('context_summary.context_files', '{count} {name} file{plural}', {
      count: geminiMdFileCount,
      name,
      plural: geminiMdFileCount > 1 ? 's' : ''
    });
  })();

  const mcpText = (() => {
    if (mcpServerCount === 0 && blockedMcpServerCount === 0) {
      return '';
    }

    const parts = [];
    if (mcpServerCount > 0) {
      parts.push(
        t('context_summary.mcp_servers', '{count} MCP server{plural}', {
          count: mcpServerCount,
          plural: mcpServerCount > 1 ? 's' : ''
        })
      );
    }

    if (blockedMcpServerCount > 0) {
      let blockedText = `${blockedMcpServerCount} Blocked`;
      if (mcpServerCount === 0) {
        blockedText += ` MCP server${blockedMcpServerCount > 1 ? 's' : ''}`;
      }
      parts.push(blockedText);
    }
    let text = parts.join(', ');
    // Add ctrl+t hint when MCP servers are available
    if (mcpServers && Object.keys(mcpServers).length > 0) {
      if (showToolDescriptions) {
        text += t('context_summary.ctrl_t_toggle', ' (ctrl+t to toggle)');
      } else {
        text += t('context_summary.ctrl_t_view', ' (ctrl+t to view)');
      }
    }
    return text;
  })();

  const summaryParts = [openFilesText, geminiMdText, mcpText].filter(Boolean);

  if (isNarrow) {
    return (
      <Box flexDirection="column">
        <Text color={Colors.Gray}>{t('context_summary.using_label', 'Using:')}</Text>
        {summaryParts.map((part, index) => (
          <Text key={index} color={Colors.Gray}>
            {t('context_summary.list_item_prefix', '  - ')}{part}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box>
      <Text color={Colors.Gray}>{t('context_summary.using', 'Using: ')}{summaryParts.join(' | ')}</Text>
    </Box>
  );
};