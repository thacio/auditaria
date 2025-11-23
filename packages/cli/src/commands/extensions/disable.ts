/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { getErrorMessage } from '../../utils/errors.js';
import { debugLogger, t } from '@google/gemini-cli-core';
import { ExtensionManager } from '../../config/extension-manager.js';
import { requestConsentNonInteractive } from '../../config/extensions/consent.js';
import { promptForSetting } from '../../config/extensions/extensionSettings.js';

interface DisableArgs {
  name: string;
  scope?: string;
}

export async function handleDisable(args: DisableArgs) {
  const workspaceDir = process.cwd();
  const extensionManager = new ExtensionManager({
    workspaceDir,
    requestConsent: requestConsentNonInteractive,
    requestSetting: promptForSetting,
    settings: loadSettings(workspaceDir).merged,
  });
  await extensionManager.loadExtensions();

  try {
    if (args.scope?.toLowerCase() === 'workspace') {
      await extensionManager.disableExtension(
        args.name,
        SettingScope.Workspace,
      );
    } else {
      await extensionManager.disableExtension(args.name, SettingScope.User);
    }
    debugLogger.log(
      t(
        'commands.extensions.disable.success',
        `Extension "${args.name}" successfully disabled for scope "${args.scope}".`,
        { name: args.name, scope: args.scope || 'user' },
      ),
    );
  } catch (error) {
    debugLogger.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const disableCommand: CommandModule = {
  command: 'disable [--scope] <name>',
  describe: t(
    'commands.extensions.disable.description',
    'Disables an extension.',
  ),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t(
          'commands.extensions.disable.name_description',
          'The name of the extension to disable.',
        ),
        type: 'string',
      })
      .option('scope', {
        describe: t(
          'commands.extensions.disable.scope_description',
          'The scope to disable the extension in.',
        ),
        type: 'string',
        default: SettingScope.User,
      })
      .check((argv) => {
        if (
          argv.scope &&
          !Object.values(SettingScope)
            .map((s) => s.toLowerCase())
            .includes((argv.scope as string).toLowerCase())
        ) {
          throw new Error(
            `Invalid scope: ${argv.scope}. Please use one of ${Object.values(
              SettingScope,
            )
              .map((s) => s.toLowerCase())
              .join(', ')}.`,
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleDisable({
      name: argv['name'] as string,
      scope: argv['scope'] as string,
    });
  },
};
