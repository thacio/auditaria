/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { type SlashCommand, CommandKind } from '../commands/types.js';

interface Help {
  commands: readonly SlashCommand[];
}

export const Help: React.FC<Help> = ({ commands }) => (
  <Box
    flexDirection="column"
    marginBottom={1}
    borderColor={theme.border.default}
    borderStyle="round"
    padding={1}
  >
    {/* Basics */}
    <Text bold color={theme.text.primary}>
      {t('help.section_basics', 'Basics:')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.add_context', 'Add context')}
      </Text>
      : {t('help.add_context_help', 'Use {symbol} to specify files for context (e.g., {example}) to target specific files or folders.', {
        symbol: '@',
        example: '@src/myFile.ts'
      })}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.shell_mode', 'Shell mode')}
      </Text>
      : {t('help.shell_mode_help', 'Execute shell commands via {symbol} (e.g., {example}) or use natural language (e.g. {natural_example}).', {
        symbol: '!',
        example: '!npm run start',
        natural_example: 'start server'
      })}
    </Text>

    <Box height={1} />

    {/* Commands */}
    <Text bold color={theme.text.primary}>
      {t('help.section_commands', 'Commands:')}
    </Text>
    {commands
      .filter((command) => command.description && !command.hidden)
      .map((command: SlashCommand) => (
        <Box key={command.name} flexDirection="column">
          <Text color={theme.text.primary}>
            <Text bold color={theme.text.accent}>
              {' '}
              /{command.name}
            </Text>
            {command.kind === CommandKind.MCP_PROMPT && (
              <Text color={theme.text.secondary}> [MCP]</Text>
            )}
            {command.description && ' - ' + command.description}
          </Text>
          {command.subCommands &&
            command.subCommands
              .filter((subCommand) => !subCommand.hidden)
              .map((subCommand) => (
                <Text key={subCommand.name} color={theme.text.primary}>
                  <Text bold color={theme.text.accent}>
                    {'   '}
                    {subCommand.name}
                  </Text>
                  {subCommand.description && ' - ' + subCommand.description}
                </Text>
              ))}
        </Box>
      ))}
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {' '}
        !{' '}
      </Text>
      - {t('help.shell_command', 'shell command')}
    </Text>
    <Text color={theme.text.primary}>
      <Text color={theme.text.secondary}>[MCP]</Text> - {t('help.mcp_command', 'Model Context Protocol command (from external servers)')}
    </Text>

    <Box height={1} />

    {/* Shortcuts */}
    <Text bold color={theme.text.primary}>
      {t('help.section_shortcuts', 'Keyboard Shortcuts:')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.alt_left_right', 'Alt+Left/Right')}
      </Text>{' '}
      - {t('help.shortcuts.jump_words', 'Jump through words in the input')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.ctrl_c', 'Ctrl+C')}
      </Text>{' '}
      - {t('help.shortcuts.quit', 'Quit application')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {process.platform === 'win32' ? t('help.keys.ctrl_enter', 'Ctrl+Enter') : t('help.keys.ctrl_j', 'Ctrl+J')}
      </Text>{' '}
      - {process.platform === 'linux'
        ? t('help.shortcuts.new_line_linux', 'New line (Alt+Enter works for certain linux distros)')
        : t('help.shortcuts.new_line_win', 'New line')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.ctrl_l', 'Ctrl+L')}
      </Text>{' '}
      - {t('help.shortcuts.clear_screen', 'Clear the screen')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {process.platform === 'darwin' ? t('help.keys.ctrl_x_meta', 'Ctrl+X / Meta+Enter') : t('help.keys.ctrl_x', 'Ctrl+X')}
      </Text>{' '}
      - {t('help.shortcuts.external_editor', 'Open input in external editor')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.ctrl_y', 'Ctrl+Y')}
      </Text>{' '}
      - {t('help.shortcuts.toggle_yolo', 'Toggle YOLO mode')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.enter', 'Enter')}
      </Text>{' '}
      - {t('help.shortcuts.enter', 'Send message')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.esc', 'Esc')}
      </Text>{' '}
      - {t('help.shortcuts.cancel_clear', 'Cancel operation / Clear input (double press)')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.shift_tab', 'Shift+Tab')}
      </Text>{' '}
      - {t('help.shortcuts.toggle_auto_accept', 'Toggle auto-accepting edits')}
    </Text>
    <Text color={theme.text.primary}>
      <Text bold color={theme.text.accent}>
        {t('help.keys.up_down', 'Up/Down')}
      </Text>{' '}
      - {t('help.shortcuts.cycle_history', 'Cycle through your prompt history')}
    </Text>
    <Box height={1} />
    <Text color={theme.text.primary}>
      {t('help.shortcuts.full_shortcuts_intro', 'For a full list of shortcuts, see')}{' '}
      <Text bold color={theme.text.accent}>
        {t('help.shortcuts.docs_path', 'docs/cli/keyboard-shortcuts.md')}
      </Text>
    </Text>
  </Box>
);
