/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  IdeClient,
  type File,
  logIdeConnection,
  IdeConnectionEvent,
  IdeConnectionType,
  t,
  getIdeInstaller,
  IDEConnectionStatus,
  ideContextStore,
  GEMINI_CLI_COMPANION_EXTENSION_NAME,
  
  IDE_DEFINITIONS,
} from '@thacio/auditaria-cli-core';
import path from 'node:path';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
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
      const context = ideContextStore.get();
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

async function setIdeModeAndSyncConnection(
  config: Config,
  value: boolean,
): Promise<void> {
  config.setIdeMode(value);
  const ideClient = await IdeClient.getInstance();
  if (value) {
    await ideClient.connect();
    logIdeConnection(config, new IdeConnectionEvent(IdeConnectionType.SESSION));
  } else {
    await ideClient.disconnect();
  }
}

export const ideCommand = async (): Promise<SlashCommand> => {
  const ideClient = await IdeClient.getInstance();
  const currentIDE = ideClient.getCurrentIde();
  if (!currentIDE) {
    return {
      name: 'ide',
      get description() {
        return t('commands.ide.description', 'Manage IDE integration');
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
              supportedIDEs: Object.values(IDE_DEFINITIONS)
                .map((ide) => ide.displayName)
                .join(', '),
            },
          ),
        }) as const,
    };
  }

  const ideSlashCommand: SlashCommand = {
    name: 'ide',
    get description() {
      return t('commands.ide.description', 'Manage IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    subCommands: [],
  };

  const statusCommand: SlashCommand = {
    name: 'status',
    get description() {
      return t('commands.ide.status.description', 'Check status of IDE integration');
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
      return t('commands.ide.install.description', 'Install required IDE companion for {ide}', { ide: ideClient.getDetectedIdeDisplayName() || 'IDE' });
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
              `No installer is available for {ide}. Please install the '${GEMINI_CLI_COMPANION_EXTENSION_NAME}' extension manually from the marketplace.`,
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
      context.ui.addItem(
        {
          type: result.success ? 'info' : 'error',
          text: result.message,
        },
        Date.now(),
      );
      if (result.success) {
        context.services.settings.setValue(
          SettingScope.User,
          'ide.enabled',
          true,
        );
        // Poll for up to 5 seconds for the extension to activate.
        for (let i = 0; i < 10; i++) {
          await setIdeModeAndSyncConnection(context.services.config!, true);
          if (
            ideClient.getConnectionStatus().status ===
            IDEConnectionStatus.Connected
          ) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        const { messageType, content } = getIdeStatusMessage(ideClient);
        if (messageType === 'error') {
          context.ui.addItem(
            {
              type: messageType,
              text: t('commands.ide.install.auto_enable_failed', 'Failed to automatically enable IDE integration. To fix this, run the CLI in a new terminal window.'),
            },
            Date.now(),
          );
        } else {
          context.ui.addItem(
            {
              type: messageType,
              text: content,
            },
            Date.now(),
          );
        }
      }
    },
  };

  const enableCommand: SlashCommand = {
    name: 'enable',
    get description() {
      return t('commands.ide.enable.description', 'Enable IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (context: CommandContext) => {
      context.services.settings.setValue(
        SettingScope.User,
        'ide.enabled',
        true,
      );
      await setIdeModeAndSyncConnection(context.services.config!, true);
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
      return t('commands.ide.disable.description', 'Disable IDE integration');
    },
    kind: CommandKind.BUILT_IN,
    action: async (context: CommandContext) => {
      context.services.settings.setValue(
        SettingScope.User,
        'ide.enabled',
        false,
      );
      await setIdeModeAndSyncConnection(context.services.config!, false);
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

  const { status } = ideClient.getConnectionStatus();
  const isConnected = status === IDEConnectionStatus.Connected;

  if (isConnected) {
    ideSlashCommand.subCommands = [statusCommand, disableCommand];
  } else {
    ideSlashCommand.subCommands = [
      enableCommand,
      statusCommand,
      installCommand,
    ];
  }

  return ideSlashCommand;
};
