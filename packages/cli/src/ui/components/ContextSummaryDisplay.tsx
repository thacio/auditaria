/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { type IdeContext, type MCPServerConfig } from '@google/gemini-cli-core';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';

interface ContextSummaryDisplayProps {
  geminiMdFileCount: number;
  contextFileNames: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  blockedMcpServers?: Array<{ name: string; extensionName: string }>;
  ideContext?: IdeContext;
  skillCount: number;
}

export const ContextSummaryDisplay: React.FC<ContextSummaryDisplayProps> = ({
  geminiMdFileCount,
  contextFileNames,
  mcpServers,
  blockedMcpServers,
  ideContext,
  skillCount,
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
    openFileCount === 0 &&
    skillCount === 0
  ) {
    return <Text> </Text>; // Render an empty space to reserve height
  }

  const openFilesText = (() => {
    if (openFileCount === 0) {
      return '';
    }
    return `${openFileCount} open file${
      openFileCount > 1 ? 's' : ''
    } (ctrl+g to view)`;
  })();

  const geminiMdText = (() => {
    if (geminiMdFileCount === 0) {
      return '';
    }

    // AUDITARIA_FEATURE_START: Show breakdown by file type (e.g., "1 AUDITARIA.md, 1 GEMINI.md")
    // Group files by their basename
    const fileTypeCounts: Record<string, number> = {};
    for (const fileName of contextFileNames) {
      fileTypeCounts[fileName] = (fileTypeCounts[fileName] || 0) + 1;
    }

    const fileTypes = Object.keys(fileTypeCounts);

    // If all files have the same name, show simple format
    if (fileTypes.length === 1) {
      const name = fileTypes[0];
      const count = fileTypeCounts[name];
      return `${count} ${name}${count > 1 ? ' files' : ''}`;
    }

    // Show breakdown by file type
    const parts = fileTypes.map((name) => {
      const count = fileTypeCounts[name];
      return `${count} ${name}`;
    });
    return parts.join(', ');
    // AUDITARIA_FEATURE_END
  })();

  const mcpText = (() => {
    if (mcpServerCount === 0 && blockedMcpServerCount === 0) {
      return '';
    }

    const parts = [];
    if (mcpServerCount > 0) {
      parts.push(
        `${mcpServerCount} MCP server${mcpServerCount > 1 ? 's' : ''}`,
      );
    }

    if (blockedMcpServerCount > 0) {
      let blockedText = `${blockedMcpServerCount} Blocked`;
      if (mcpServerCount === 0) {
        blockedText += ` MCP server${blockedMcpServerCount > 1 ? 's' : ''}`;
      }
      parts.push(blockedText);
    }
    return parts.join(', ');
  })();

  const skillText = (() => {
    if (skillCount === 0) {
      return '';
    }
    return `${skillCount} skill${skillCount > 1 ? 's' : ''}`;
  })();

  const summaryParts = [openFilesText, geminiMdText, mcpText, skillText].filter(
    Boolean,
  );

  if (isNarrow) {
    return (
      <Box flexDirection="column" paddingX={1}>
        {summaryParts.map((part, index) => (
          <Text key={index} color={theme.text.secondary}>
            - {part}
          </Text>
        ))}
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.text.secondary}>{summaryParts.join(' | ')}</Text>
    </Box>
  );
};
