/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  t,
  IDEConnectionStatus,
  getIdeDisplayName,
  getIdeInstaller,
} from '@thacio/auditaria-cli-core';
import {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { SettingScope } from '../../config/settings.js';

export const ideCommand = (config: Config | null): SlashCommand | null => {
  if (!config?.getIdeModeFeature()) {
    return null;
  }
  const currentIDE = config.getIdeClient().getCurrentIde();
  if (!currentIDE) {
    return null;
  }

  const ideSlashCommand: SlashCommand = {
    name: 'ide',
    get description() {
      return t('commands.ide.description', 'manage IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    subCommands: [],
  };

  const statusCommand: SlashCommand = {
    name: 'status',
    get description() {
      return t('commands.ide.status.description', 'check status of IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: (_context: CommandContext): SlashCommandActionReturn => {
      const connection = config.getIdeClient().getConnectionStatus();
      switch (connection?.status) {
        case IDEConnectionStatus.Connected:
          return {
            type: 'message',
            messageType: 'info',
            content: t('commands.ide.status.connected', '🟢 Connected'),
          } as const;
        case IDEConnectionStatus.Connecting:
          return {
            type: 'message',
            messageType: 'info',
            content: t('commands.ide.status.connecting', '🟡 Connecting...'),
          } as const;
        default: {
          let content = t('commands.ide.status.disconnected', '🔴 Disconnected');
          if (connection?.details) {
            content += `: ${connection.details}`;
          }
          return {
            type: 'message',
            messageType: 'error',
            content,
          } as const;
        }
      }
    },
  };

  const installCommand: SlashCommand = {
    name: 'install',
    get description() {
      return t('commands.ide.install.description', 'install required IDE companion {ide} extension', { ide: getIdeDisplayName(currentIDE) });
    },
    kind: CommandKind.BUILT_IN,
    action: async (context) => {
      const installer = getIdeInstaller(currentIDE);
      if (!installer) {
        context.ui.addItem(
          {
            type: 'error',
            text: t('commands.ide.install.no_installer', 'No installer available for your configured IDE.'),
          },
          Date.now(),
        );
        return;
      }

      context.ui.addItem(
        {
          type: 'info',
          text: t('commands.ide.install.installing', 'Installing IDE companion extension...'),
        },
        Date.now(),
      );

      const result = await installer.install();
      context.ui.addItem(
        {
          type: result.success ? 'info' : 'error',
          text: result.message,
        },
        Date.now(),
      );
    },
  };

  const enableCommand: SlashCommand = {
    name: 'enable',
    get description() {
      return t('commands.ide.enable.description', 'enable IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (context: CommandContext) => {
      context.services.settings.setValue(SettingScope.User, 'ideMode', true);
      config.setIdeMode(true);
      config.setIdeClientConnected();
    },
  };

  const disableCommand: SlashCommand = {
    name: 'disable',
    get description() {
      return t('commands.ide.disable.description', 'disable IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (context: CommandContext) => {
      context.services.settings.setValue(SettingScope.User, 'ideMode', false);
      config.setIdeMode(false);
      config.setIdeClientDisconnected();
    },
  };

  const ideModeEnabled = config.getIdeMode();
  if (ideModeEnabled) {
    ideSlashCommand.subCommands = [
      disableCommand,
      statusCommand,
      installCommand,
    ];
  } else {
    ideSlashCommand.subCommands = [
      enableCommand,
      statusCommand,
      installCommand,
    ];
  }

  return ideSlashCommand;
};
