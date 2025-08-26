/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  installExtension,
  type ExtensionInstallMetadata,
} from '../../config/extension.js';
import { t } from '@thacio/auditaria-cli-core';

interface InstallArgs {
  source?: string;
  path?: string;
}

export async function handleInstall(args: InstallArgs) {
  try {
    const installMetadata: ExtensionInstallMetadata = {
      source: (args.source || args.path) as string,
      type: args.source ? 'git' : 'local',
    };
    const extensionName = await installExtension(installMetadata);
    console.log(
      t('commands.extensions.install.success', `Extension "${extensionName}" installed successfully and enabled.`, { extensionName }),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install [--source | --path ]',
  describe: t('commands.extensions.install.description', 'Installs an extension from a git repository or a local path.'),
  builder: (yargs) =>
    yargs
      .option('source', {
        describe: t('commands.extensions.install.source_description', 'The git URL of the extension to install.'),
        type: 'string',
      })
      .option('path', {
        describe: t('commands.extensions.install.path_description', 'Path to a local extension directory.'),
        type: 'string',
      })
      .conflicts('source', 'path')
      .check((argv) => {
        if (!argv.source && !argv.path) {
          throw new Error(
            t('commands.extensions.install.missing_source_or_path', 'Either a git URL --source or a --path must be provided.'),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string | undefined,
      path: argv['path'] as string | undefined,
    });
  },
};
