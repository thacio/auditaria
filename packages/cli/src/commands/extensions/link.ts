/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  debugLogger,
  t,
  type ExtensionInstallMetadata,
} from '@thacio/auditaria-cli-core';

import { getErrorMessage } from '../../utils/errors.js';
import { requestConsentNonInteractive } from '../../config/extensions/consent.js';
import { ExtensionManager } from '../../config/extension-manager.js';
import { loadSettings } from '../../config/settings.js';
import { promptForSetting } from '../../config/extensions/extensionSettings.js';

interface InstallArgs {
  path: string;
}

export async function handleLink(args: InstallArgs) {
  try {
    const installMetadata: ExtensionInstallMetadata = {
      source: args.path,
      type: 'link',
    };
    const workspaceDir = process.cwd();
    const extensionManager = new ExtensionManager({
      workspaceDir,
      requestConsent: requestConsentNonInteractive,
      requestSetting: promptForSetting,
      settings: loadSettings(workspaceDir).merged,
    });
    await extensionManager.loadExtensions();
    const extensionName: string =
      await extensionManager.installOrUpdateExtension(installMetadata);
    debugLogger.log(
      t(
        'commands.extensions.link.success',
        'Extension "{extensionName}" linked successfully and enabled.',
        { extensionName: extensionName as string },
      ),
    );
  } catch (error) {
    debugLogger.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const linkCommand: CommandModule = {
  command: 'link <path>',
  describe: t(
    'commands.extensions.link.description',
    'Links an extension from a local path. Updates made to the local path will always be reflected.',
  ),
  builder: (yargs) =>
    yargs
      .positional('path', {
        describe: t(
          'commands.extensions.link.path_description',
          'The name of the extension to link.',
        ),
        type: 'string',
      })
      .check((_) => true),
  handler: async (argv) => {
    await handleLink({
      path: argv['path'] as string,
    });
  },
};
