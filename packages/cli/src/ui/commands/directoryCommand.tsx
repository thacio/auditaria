/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isFolderTrustEnabled,
  isWorkspaceTrusted,
  loadTrustedFolders,
} from '../../config/trustedFolders.js';
import { MultiFolderTrustDialog } from '../components/MultiFolderTrustDialog.js';
import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { MessageType, type HistoryItem } from '../types.js';
import { t, refreshServerHierarchicalMemory } from '@thacio/auditaria-cli-core';
import { expandHomeDir } from '../utils/directoryUtils.js';
import type { Config } from '@thacio/auditaria-cli-core';

async function finishAddingDirectories(
  config: Config,
  addItem: (itemData: Omit<HistoryItem, 'id'>, baseTimestamp: number) => number,
  added: string[],
  errors: string[],
) {
  if (!config) {
    addItem(
      {
        type: MessageType.ERROR,
        text: t(
          'commands.directory.config_not_available',
          'Configuration is not available.',
        ),
      },
      Date.now(),
    );
    return;
  }

  try {
    if (config.shouldLoadMemoryFromIncludeDirectories()) {
      await refreshServerHierarchicalMemory(config);
    }
    addItem(
      {
        type: MessageType.INFO,
        text: t(
          'commands.directory.add.memory_files_added',
          'Successfully added GEMINI.md files from the following directories if there are:\n- {directories}',
          { directories: added.join('\n- ') },
        ),
      },
      Date.now(),
    );
  } catch (error) {
    errors.push(
      t(
        'commands.directory.add.memory_refresh_error',
        'Error refreshing memory: {error}',
        { error: (error as Error).message },
      ),
    );
  }

  if (added.length > 0) {
    const gemini = config.getGeminiClient();
    if (gemini) {
      await gemini.addDirectoryContext();
    }
    addItem(
      {
        type: MessageType.INFO,
        text: t(
          'commands.directory.add.success',
          'Successfully added directories:\n- {directories}',
          { directories: added.join('\n- ') },
        ),
      },
      Date.now(),
    );
  }

  if (errors.length > 0) {
    addItem({ type: MessageType.ERROR, text: errors.join('\n') }, Date.now());
  }
}

export const directoryCommand: SlashCommand = {
  name: 'directory',
  altNames: ['dir'],
  get description() {
    return t('commands.directory.description', 'Manage workspace directories');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'add',
      get description() {
        return t(
          'commands.directory.add.description',
          'Add directories to the workspace. Use comma to separate multiple paths',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext, args: string) => {
        const {
          ui: { addItem },
          services: { config, settings },
        } = context;
        const [...rest] = args.split(' ');

        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'commands.directory.config_not_available',
                'Configuration is not available.',
              ),
            },
            Date.now(),
          );
          return;
        }

        if (config.isRestrictiveSandbox()) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: t(
              'commands.directory.add.restrictive_sandbox',
              'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.',
            ),
          };
        }

        const pathsToAdd = rest
          .join(' ')
          .split(',')
          .filter((p) => p);
        if (pathsToAdd.length === 0) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'commands.directory.add.provide_path',
                'Please provide at least one path to add.',
              ),
            },
            Date.now(),
          );
          return;
        }

        const added: string[] = [];
        const errors: string[] = [];
        const alreadyAdded: string[] = [];

        const workspaceContext = config.getWorkspaceContext();
        const currentWorkspaceDirs = workspaceContext.getDirectories();
        const pathsToProcess: string[] = [];

        for (const pathToAdd of pathsToAdd) {
          const expandedPath = expandHomeDir(pathToAdd.trim());
          if (currentWorkspaceDirs.includes(expandedPath)) {
            alreadyAdded.push(pathToAdd.trim());
          } else {
            pathsToProcess.push(pathToAdd.trim());
          }
        }

        if (alreadyAdded.length > 0) {
          addItem(
            {
              type: MessageType.INFO,
              text: t(
                'commands.directory.add.already_added',
                'The following directories are already in the workspace:\n- {directories}',
                { directories: alreadyAdded.join('\n- ') },
              ),
            },
            Date.now(),
          );
        }

        if (pathsToProcess.length === 0) {
          return;
        }

        if (
          isFolderTrustEnabled(settings.merged) &&
          isWorkspaceTrusted(settings.merged).isTrusted
        ) {
          const trustedFolders = loadTrustedFolders();
          const untrustedDirs: string[] = [];
          const undefinedTrustDirs: string[] = [];
          const trustedDirs: string[] = [];

          for (const pathToAdd of pathsToProcess) {
            const expandedPath = expandHomeDir(pathToAdd.trim());
            const isTrusted = trustedFolders.isPathTrusted(expandedPath);
            if (isTrusted === false) {
              untrustedDirs.push(pathToAdd.trim());
            } else if (isTrusted === undefined) {
              undefinedTrustDirs.push(pathToAdd.trim());
            } else {
              trustedDirs.push(pathToAdd.trim());
            }
          }

          if (untrustedDirs.length > 0) {
            errors.push(
              t(
                'commands.directory.add.untrusted_dirs',
                'The following directories are explicitly untrusted and cannot be added to a trusted workspace:\n- {directories}\nPlease use the permissions command to modify their trust level.',
                { directories: untrustedDirs.join('\n- ') },
              ),
            );
          }

          for (const pathToAdd of trustedDirs) {
            try {
              workspaceContext.addDirectory(expandHomeDir(pathToAdd));
              added.push(pathToAdd);
            } catch (e) {
              const error = e as Error;
              errors.push(
                t(
                  'commands.directory.add.error_adding',
                  `Error adding '{path}': {error}`,
                  { path: pathToAdd, error: error.message },
                ),
              );
            }
          }

          if (undefinedTrustDirs.length > 0) {
            return {
              type: 'custom_dialog',
              component: (
                <MultiFolderTrustDialog
                  folders={undefinedTrustDirs}
                  onComplete={context.ui.removeComponent}
                  trustedDirs={added}
                  errors={errors}
                  finishAddingDirectories={finishAddingDirectories}
                  config={config}
                  addItem={addItem}
                />
              ),
            };
          }
        } else {
          for (const pathToAdd of pathsToProcess) {
            try {
              workspaceContext.addDirectory(expandHomeDir(pathToAdd.trim()));
              added.push(pathToAdd.trim());
            } catch (e) {
              const error = e as Error;
              errors.push(
                t(
                  'commands.directory.add.error_adding',
                  `Error adding '{path}': {error}`,
                  { path: pathToAdd.trim(), error: error.message },
                ),
              );
            }
          }
        }

        await finishAddingDirectories(config, addItem, added, errors);
        return;
      },
    },
    {
      name: 'show',
      get description() {
        return t(
          'commands.directory.show.description',
          'Show all directories in the workspace',
        );
      },
      kind: CommandKind.BUILT_IN,
      action: async (context: CommandContext) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;
        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'commands.directory.config_not_available',
                'Configuration is not available.',
              ),
            },
            Date.now(),
          );
          return;
        }
        const workspaceContext = config.getWorkspaceContext();
        const directories = workspaceContext.getDirectories();
        const directoryList = directories.map((dir) => `- ${dir}`).join('\n');
        addItem(
          {
            type: MessageType.INFO,
            text: t(
              'commands.directory.show.current_directories',
              'Current workspace directories:\n{directories}',
              { directories: directoryList },
            ),
          },
          Date.now(),
        );
      },
    },
  ],
};
