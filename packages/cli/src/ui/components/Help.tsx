/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import { t } from '@thacio/auditaria-cli-core';

import type React from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../colors.js';
import type { SlashCommand } from '../commands/types.js';

interface Help {
  commands: readonly SlashCommand[];
}

export const Help: React.FC<Help> = ({ commands }) => (
  <Box
    flexDirection="column"
    marginBottom={1}
    borderColor={Colors.Gray}
    borderStyle="round"
    padding={1}
  >
    {/* Basics */}
    <Text bold color={Colors.Foreground}>
      {t('help.section_basics', 'Basics:')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.add_context', 'Add context')}
      </Text>
      : {t('help.add_context_help', 'Use {symbol} to specify files for context (e.g., {example}) to target specific files or folders.', {
        symbol: '@',
        example: '@src/myFile.ts'
      })}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
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
    <Text bold color={Colors.Foreground}>
      {t('help.section_commands', 'Commands:')}
    </Text>
    {commands
      .filter((command) => command.description)
      .map((command: SlashCommand) => (
        <Box key={command.name} flexDirection="column">
          <Text color={Colors.Foreground}>
            <Text bold color={Colors.AccentPurple}>
              {' '}
              /{command.name}
            </Text>
            {command.description && ' - ' + command.description}
          </Text>
          {command.subCommands &&
            command.subCommands.map((subCommand) => (
              <Text key={subCommand.name} color={Colors.Foreground}>
                <Text bold color={Colors.AccentPurple}>
                  {'   '}
                  {subCommand.name}
                </Text>
                {subCommand.description && ' - ' + subCommand.description}
              </Text>
            ))}
        </Box>
      ))}
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {' '}
        !{' '}
      </Text>
      - {t('help.shell_command', 'shell command')}
    </Text>

    <Box height={1} />

    {/* Shortcuts */}
    <Text bold color={Colors.Foreground}>
      {t('help.section_shortcuts', 'Keyboard Shortcuts:')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.alt_left_right', 'Alt+Left/Right')}
      </Text>{' '}
      - {t('help.shortcuts.jump_words', 'Jump through words in the input')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.ctrl_c', 'Ctrl+C')}
      </Text>{' '}
      - {t('help.shortcuts.quit', 'Quit application')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {process.platform === 'win32' ? t('help.keys.ctrl_enter', 'Ctrl+Enter') : t('help.keys.ctrl_j', 'Ctrl+J')}
      </Text>{' '}
      - {process.platform === 'linux'
        ? t('help.shortcuts.new_line_linux', 'New line (Alt+Enter works for certain linux distros)')
        : t('help.shortcuts.new_line_win', 'New line')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.ctrl_l', 'Ctrl+L')}
      </Text>{' '}
      - {t('help.shortcuts.clear_screen', 'Clear the screen')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {process.platform === 'darwin' ? t('help.keys.ctrl_x_meta', 'Ctrl+X / Meta+Enter') : t('help.keys.ctrl_x', 'Ctrl+X')}
      </Text>{' '}
      - {t('help.shortcuts.external_editor', 'Open input in external editor')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.ctrl_y', 'Ctrl+Y')}
      </Text>{' '}
      - {t('help.shortcuts.toggle_yolo', 'Toggle YOLO mode')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.enter', 'Enter')}
      </Text>{' '}
      - {t('help.shortcuts.enter', 'Send message')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.esc', 'Esc')}
      </Text>{' '}
      - {t('help.shortcuts.cancel_clear', 'Cancel operation / Clear input (double press)')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.shift_tab', 'Shift+Tab')}
      </Text>{' '}
      - {t('help.shortcuts.toggle_auto_accept', 'Toggle auto-accepting edits')}
    </Text>
    <Text color={Colors.Foreground}>
      <Text bold color={Colors.AccentPurple}>
        {t('help.keys.up_down', 'Up/Down')}
      </Text>{' '}
      - {t('help.shortcuts.cycle_history', 'Cycle through your prompt history')}
    </Text>
    <Box height={1} />
    <Text color={Colors.Foreground}>
      {t('help.shortcuts.full_shortcuts_intro', 'For a full list of shortcuts, see')}{' '}
      <Text bold color={Colors.AccentPurple}>
        {t('help.shortcuts.docs_path', 'docs/keyboard-shortcuts.md')}
      </Text>
    </Text>
  </Box>
);
