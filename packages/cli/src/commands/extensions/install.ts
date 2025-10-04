/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  installExtension,
  requestConsentNonInteractive,
} from '../../config/extension.js';
import type { ExtensionInstallMetadata } from '@thacio/auditaria-cli-core';
import { t } from '@thacio/auditaria-cli-core';

import { getErrorMessage } from '../../utils/errors.js';

interface InstallArgs {
  source?: string;
  path?: string;
  ref?: string;
  autoUpdate?: boolean;
}

export async function handleInstall(args: InstallArgs) {
  try {
    let installMetadata: ExtensionInstallMetadata;
    if (args.source) {
      const { source } = args;
      if (
        source.startsWith('http://') ||
        source.startsWith('https://') ||
        source.startsWith('git@') ||
        source.startsWith('sso://')
      ) {
        installMetadata = {
          source,
          type: 'git',
          ref: args.ref,
          autoUpdate: args.autoUpdate,
        };
      } else {
        throw new Error(
          t(
            'commands.extensions.install.invalid_source_format',
            `The source "${source}" is not a valid URL format.`,
            { source },
          ),
        );
      }
    } else if (args.path) {
      installMetadata = {
        source: args.path,
        type: 'local',
        autoUpdate: args.autoUpdate,
      };
    } else {
      // This should not be reached due to the yargs check.
      throw new Error('Either --source or --path must be provided.');
    }

    const name = await installExtension(
      installMetadata,
      requestConsentNonInteractive,
    );
    console.log(
      t(
        'commands.extensions.install.success',
        `Extension "${name}" installed successfully and enabled.`,
        { name },
      ),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install [<source>] [--path] [--ref] [--auto-update]',
  describe: t(
    'commands.extensions.install.description',
    'Installs an extension from a git repository URL or a local path.',
  ),
  builder: (yargs) =>
    yargs
      .positional('source', {
        describe: t(
          'commands.extensions.install.source_description',
          'The git URL of the extension to install.',
        ),
        type: 'string',
      })
      .option('path', {
        describe: t(
          'commands.extensions.install.path_description',
          'Path to a local extension directory.',
        ),
        type: 'string',
      })
      .option('ref', {
        describe: t(
          'commands.extensions.install.ref_description',
          'The git ref to install from.',
        ),
        type: 'string',
      })
      .option('auto-update', {
        describe: 'Enable auto-update for this extension.',
        type: 'boolean',
      })
      .conflicts('source', 'path')
      .conflicts('path', 'ref')
      .conflicts('path', 'auto-update')
      .check((argv) => {
        if (!argv.source && !argv.path) {
          throw new Error(
            t(
              'commands.extensions.install.missing_source_or_path',
              'Either source or --path must be provided.',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string | undefined,
      path: argv['path'] as string | undefined,
      ref: argv['ref'] as string | undefined,
      autoUpdate: argv['auto-update'] as boolean | undefined,
    });
  },
};
