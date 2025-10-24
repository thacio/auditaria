/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { debugLogger, t } from '@thacio/auditaria-cli-core';
import { requestConsentNonInteractive } from '../../config/extensions/consent.js';
import { ExtensionManager } from '../../config/extension-manager.js';
import { loadSettings } from '../../config/settings.js';
import { promptForSetting } from '../../config/extensions/extensionSettings.js';

interface UninstallArgs {
  name: string; // can be extension name or source URL.
}

export async function handleUninstall(args: UninstallArgs) {
  try {
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      requestConsent: requestConsentNonInteractive,
      requestSetting: promptForSetting,
      loadedSettings: loadSettings(workspaceDir),
    });
    await extensionManager.uninstallExtension(args.name, false);
    debugLogger.log(
      t(
        'commands.extensions.uninstall.success',
        `Extension "${args.name}" successfully uninstalled.`,
        { name: args.name },
      ),
    );
  } catch (error) {
    debugLogger.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const uninstallCommand: CommandModule = {
  command: 'uninstall <name>',
  describe: t(
    'commands.extensions.uninstall.description',
    'Uninstalls an extension.',
  ),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t(
          'commands.extensions.uninstall.name_description',
          'The name or source path of the extension to uninstall.',
        ),
        type: 'string',
      })
      .check((argv) => {
        if (!argv.name) {
          throw new Error(
            t(
              'commands.extensions.uninstall.missing_name',
              'Please include the name of the extension to uninstall as a positional argument.',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleUninstall({
      name: argv['name'] as string,
    });
  },
};
