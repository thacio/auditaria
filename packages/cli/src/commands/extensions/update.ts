/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import {
  updateExtensionByName,
  updateAllUpdatableExtensions,
  type ExtensionUpdateInfo,
} from '../../config/extension.js';
import { t } from '@thacio/auditaria-cli-core';
import { getErrorMessage } from '../../utils/errors.js';

interface UpdateArgs {
  name?: string;
  all?: boolean;
}

const updateOutput = (info: ExtensionUpdateInfo) =>
  t(
    'commands.extensions.update.success',
    `Extension "${info.name}" successfully updated: ${info.originalVersion} → ${info.updatedVersion}.`,
    {
      name: info.name,
      originalVersion: info.originalVersion,
      updatedVersion: info.updatedVersion,
    },
  );

export async function handleUpdate(args: UpdateArgs) {
  if (args.all) {
    try {
      const updateInfos = await updateAllUpdatableExtensions();
      if (updateInfos.length === 0) {
        console.log(
          t(
            'commands.extensions.update.no_extensions',
            'No extensions to update.',
          ),
        );
        return;
      }
      console.log(updateInfos.map((info) => updateOutput(info)).join('\n'));
    } catch (error) {
      console.error(getErrorMessage(error));
    }
  }
  if (args.name)
    try {
      // TODO(chrstnb): we should list extensions if the requested extension is not installed.
      const updatedExtensionInfo = await updateExtensionByName(args.name);
      console.log(
        t(
          'commands.extensions.update.success',
          `Extension "${args.name}" successfully updated: ${updatedExtensionInfo.originalVersion} → ${updatedExtensionInfo.updatedVersion}.`,
          {
            name: args.name,
            originalVersion: updatedExtensionInfo.originalVersion,
            updatedVersion: updatedExtensionInfo.updatedVersion,
          },
        ),
      );
    } catch (error) {
      console.error(getErrorMessage(error));
    }
}

export const updateCommand: CommandModule = {
  command: 'update [--all] [name]',
  describe: t(
    'commands.extensions.update.description',
    'Updates all extensions or a named extension to the latest version.',
  ),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t(
          'commands.extensions.update.name_description',
          'The name of the extension to update.',
        ),
        type: 'string',
      })
      .option('all', {
        describe: t(
          'commands.extensions.update.all_description',
          'Update all extensions.',
        ),
        type: 'boolean',
      })
      .conflicts('name', 'all')
      .check((argv) => {
        if (!argv.all && !argv.name) {
          throw new Error(
            t(
              'commands.extensions.update.missing_argument',
              'Either an extension name or --all must be provided',
            ),
          );
        }
        return true;
      }),
  handler: async (argv) => {
    await handleUpdate({
      name: argv['name'] as string | undefined,
      all: argv['all'] as boolean | undefined,
    });
  },
};