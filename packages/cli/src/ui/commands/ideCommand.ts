/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Config,
  t,
  DetectedIde,
  IDEConnectionStatus,
  getIdeInfo,
  getIdeInstaller,
  IdeClient,
  type File,
  ideContext,
} from '@thacio/auditaria-cli-core';
import path from 'node:path';
import {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { SettingScope } from '../../config/settings.js';

function getIdeStatusMessage(ideClient: IdeClient): {
  messageType: 'info' | 'error';
  content: string;
} {
  const connection = ideClient.getConnectionStatus();
  switch (connection.status) {
    case IDEConnectionStatus.Connected:
      return {
        messageType: 'info',
        content: t('commands.ide.status.connected_to', '🟢 Connected to {ide}', { ide: ideClient.getDetectedIdeDisplayName() || 'IDE' }),
      };
    case IDEConnectionStatus.Connecting:
      return {
        messageType: 'info',
        content: t('commands.ide.status.connecting', '🟡 Connecting...'),
      };
    default: {
      let content = t('commands.ide.status.disconnected', '🔴 Disconnected');
      if (connection?.details) {
        content += `: ${connection.details}`;
      }
      return {
        messageType: 'error',
        content,
      };
    }
  }
}

function formatFileList(openFiles: File[]): string {
  const basenameCounts = new Map<string, number>();
  for (const file of openFiles) {
    const basename = path.basename(file.path);
    basenameCounts.set(basename, (basenameCounts.get(basename) || 0) + 1);
  }

  const fileList = openFiles
    .map((file: File) => {
      const basename = path.basename(file.path);
      const isDuplicate = (basenameCounts.get(basename) || 0) > 1;
      const parentDir = path.basename(path.dirname(file.path));
      const displayName = isDuplicate
        ? `${basename} (/${parentDir})`
        : basename;

      return `  - ${displayName}${file.isActive ? t('ide_context.active_file', ' (active)') : ''}`;
    })
    .join('\n');

  const infoMessage = t(
    'ide_context.file_list_note',
    '\n(Note: The file list is limited to a number of recently accessed files within your workspace and only includes local files on disk)'
  );

  return `\n\n${t('ide_context.open_files', 'Open files:')}\n${fileList}${infoMessage}`;
}

async function getIdeStatusMessageWithFiles(ideClient: IdeClient): Promise<{
  messageType: 'info' | 'error';
  content: string;
}> {
  const connection = ideClient.getConnectionStatus();
  switch (connection.status) {
    case IDEConnectionStatus.Connected: {
      let content = t('commands.ide.status.connected_to', '🟢 Connected to {ide}', { ide: ideClient.getDetectedIdeDisplayName() || 'IDE' });
      const context = ideContext.getIdeContext();
      const openFiles = context?.workspaceState?.openFiles;
      if (openFiles && openFiles.length > 0) {
        content += formatFileList(openFiles);
      }
      return {
        messageType: 'info',
        content,
      };
    }
    case IDEConnectionStatus.Connecting:
      return {
        messageType: 'info',
        content: t('commands.ide.status.connecting', '🟡 Connecting...'),
      };
    default: {
      let content = t('commands.ide.status.disconnected', '🔴 Disconnected');
      if (connection?.details) {
        content += `: ${connection.details}`;
      }
      return {
        messageType: 'error',
        content,
      };
    }
  }
}

export const ideCommand = (config: Config | null): SlashCommand | null => {
  if (!config || !config.getIdeModeFeature()) {
    return null;
  }
  const ideClient = config.getIdeClient();
  const currentIDE = ideClient.getCurrentIde();
  if (!currentIDE || !ideClient.getDetectedIdeDisplayName()) {
    return {
      name: 'ide',
      get description() {
        return t('commands.ide.description', 'manage IDE integration');
      },
      kind: CommandKind.BUILT_IN,
      action: (): SlashCommandActionReturn =>
        ({
          type: 'message',
          messageType: 'error',
          content: t(
            'ide.errors.not_supported',
            'IDE integration is not supported in your current environment. To use this feature, run Auditaria CLI in one of these supported IDEs: {supportedIDEs}',
            {
              supportedIDEs: Object.values(DetectedIde)
                .map((ide) => getIdeInfo(ide).displayName)
                .join(', '),
            },
          ),
        }) as const,
    };
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
    action: async (): Promise<SlashCommandActionReturn> => {
      const { messageType, content } =
        await getIdeStatusMessageWithFiles(ideClient);
      return {
        type: 'message',
        messageType,
        content,
      } as const;
    },
  };

  const installCommand: SlashCommand = {
    name: 'install',
    get description() {
      return t('commands.ide.install.description', 'install required IDE companion for {ide}', { ide: ideClient.getDetectedIdeDisplayName() || 'IDE' });
    },
    kind: CommandKind.BUILT_IN,
    action: async (context) => {
      const installer = getIdeInstaller(currentIDE);
      if (!installer) {
        context.ui.addItem(
          {
            type: 'error',
            text: t(
              'commands.ide.install.no_installer_with_ide',
              'No installer is available for {ide}. Please install the IDE companion manually from its marketplace.',
              { ide: ideClient.getDetectedIdeDisplayName() || 'IDE' },
            ),
          },
          Date.now(),
        );
        return;
      }

      context.ui.addItem(
        {
          type: 'info',
          text: t('commands.ide.install.installing', 'Installing IDE companion...'),
        },
        Date.now(),
      );

      const result = await installer.install();
      if (result.success) {
        config.setIdeMode(true);
        context.services.settings.setValue(SettingScope.User, 'ideMode', true);
      }
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
      await config.setIdeModeAndSyncConnection(true);
      const { messageType, content } = getIdeStatusMessage(ideClient);
      context.ui.addItem(
        {
          type: messageType,
          text: content,
        },
        Date.now(),
      );
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
      await config.setIdeModeAndSyncConnection(false);
      const { messageType, content } = getIdeStatusMessage(ideClient);
      context.ui.addItem(
        {
          type: messageType,
          text: content,
        },
        Date.now(),
      );
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
