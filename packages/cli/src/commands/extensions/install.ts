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
import { stat } from 'node:fs/promises';

interface InstallArgs {
  source: string;
  ref?: string;
  autoUpdate?: boolean;
}

export async function handleInstall(args: InstallArgs) {
  try {
    let installMetadata: ExtensionInstallMetadata;
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
      if (args.ref || args.autoUpdate) {
        throw new Error(
          t(
            'commands.extensions.install.local_no_ref_auto_update',
            '--ref and --auto-update are not applicable for local extensions.',
          ),
        );
      }
      try {
        await stat(source);
        installMetadata = {
          source,
          type: 'local',
        };
      } catch {
        throw new Error(
          t(
            'commands.extensions.install.source_not_found',
            'Install source not found.',
          ),
        );
      }
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
  command: 'install <source>',
  describe: t(
    'commands.extensions.install.description',
    'Installs an extension from a git repository URL or a local path.',
  ),
  builder: (yargs) =>
    yargs
      .positional('source', {
        describe: t(
          'commands.extensions.install.source_description',
          'The github URL or local path of the extension to install.',
        ),
        type: 'string',
        demandOption: true,
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
      .check((argv) => {
        if (!argv.source) {
          throw new Error(
            t(
              'commands.extensions.install.source_required',
              'The source argument must be provided.',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string,
      ref: argv['ref'] as string | undefined,
      autoUpdate: argv['auto-update'] as boolean | undefined,
    });
  },
};
