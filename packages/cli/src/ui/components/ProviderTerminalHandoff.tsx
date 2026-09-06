/**
 * @license
 * Copyright 2026 Thacio
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUDITARIA_CLAUDE_PROVIDER: In-CLI hand-off to the provider TUI for users
 * without a web client. Shows the live screen (plain text, refreshed a few
 * times per second) and forwards every keystroke to the provider PTY, so a
 * trust dialog, a permission prompt, an AskUserQuestion picker or the /mcp
 * menu can be answered right here. Ctrl+Q returns to the chat; Esc goes to
 * the provider (its own cancel key).
 */

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeypress } from '../hooks/useKeypress.js';

const REFRESH_MS = 120;
// Ctrl+Q: unbound elsewhere in the CLI (Ctrl+] opens the latest artifact,
// Ctrl+G the external editor, Ctrl+[ is Escape).
const RETURN_TO_CHAT = '\x11';

export interface ProviderTerminalHandoffProps {
  getScreen: () => Promise<string>;
  sendInput: (bytes: string) => Promise<void>;
  onClose: () => void;
}

export function ProviderTerminalHandoff({
  getScreen,
  sendInput,
  onClose,
}: ProviderTerminalHandoffProps) {
  const [screen, setScreen] = useState('Opening the provider terminal…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      getScreen()
        .then((value) => {
          if (alive) setScreen(value.replace(/\s+$/, ''));
        })
        .catch((e: unknown) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [getScreen]);

  useKeypress(
    (key) => {
      if (key.sequence === RETURN_TO_CHAT || (key.ctrl && key.name === 'q')) {
        onClose();
        return true;
      }
      if (key.sequence) {
        sendInput(key.sequence).catch((e: unknown) =>
          setError(e instanceof Error ? e.message : String(e)),
        );
      }
      return true;
    },
    { isActive: true, priority: true },
  );

  return (
    <Box flexDirection="column">
      <Text bold>
        Provider terminal · Ctrl+Q returns to chat · Esc goes to the provider
      </Text>
      <Text>{screen}</Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
