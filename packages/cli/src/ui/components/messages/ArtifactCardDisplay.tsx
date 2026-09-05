/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 */

// AUDITARIA_ARTIFACTS: This entire file is part of the artifacts feature.

import type React from 'react';
import { Box, Text } from 'ink';
import type { ArtifactDisplayData } from '@google/gemini-cli-core';
import { theme } from '../../semantic-colors.js';

/** Terminal hyperlink (OSC 8); terminals without support show the text. */
export function terminalLink(url: string, text: string = url): string {
  return `\u001b]8;;${url}\u0007${text}\u001b]8;;\u0007`;
}

/**
 * The publish result card, mirroring Claude Code's dim
 * `Published ✻ <url>` line: verb, favicon, title, version, the link, and a
 * hint when the page is stored but not reachable.
 */
export const ArtifactCardDisplay: React.FC<{ data: ArtifactDisplayData }> = ({
  data,
}) => {
  const { artifact } = data;
  const verb = artifact.created ? 'Published' : 'Updated';
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={theme.text.secondary}>{verb} </Text>
        <Text color={theme.text.accent}>✻ </Text>
        <Text color={theme.text.primary}>
          {artifact.favicon} {artifact.title}
        </Text>
        <Text color={theme.text.secondary}> · v{artifact.version}</Text>
      </Box>
      {artifact.url ? (
        <Text color={theme.text.link}>{terminalLink(artifact.url)}</Text>
      ) : (
        <Text color={theme.status.warning}>
          Stored, but the web interface is not running — run /web to open it.
        </Text>
      )}
      {artifact.description ? (
        <Text color={theme.text.secondary}>{artifact.description}</Text>
      ) : null}
    </Box>
  );
};
