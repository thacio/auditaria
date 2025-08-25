/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandModule } from 'yargs';
import { t } from '@thacio/auditaria-cli-core';
import { updateExtension } from '../../config/extension.js';

interface UpdateArgs {
  name: string;
}

export async function handleUpdate(args: UpdateArgs) {
  try {
    // TODO(chrstnb): we should list extensions if the requested extension is not installed.
    const updatedExtensionInfo = await updateExtension(args.name);
    if (!updatedExtensionInfo) {
      console.log(t('commands.extensions.update.failed', `Extension "${args.name}" failed to update.`, { name: args.name }));
      return;
    }
    console.log(
      t('commands.extensions.update.success', `Extension "${args.name}" successfully updated: ${updatedExtensionInfo.originalVersion} → ${updatedExtensionInfo.updatedVersion}.`, { name: args.name, originalVersion: updatedExtensionInfo.originalVersion, updatedVersion: updatedExtensionInfo.updatedVersion }),
    );
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

export const updateCommand: CommandModule = {
  command: 'update <name>',
  describe: t('commands.extensions.update.description', 'Updates an extension.'),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('commands.extensions.update.name_description', 'The name of the extension to update.'),
        type: 'string',
      })
      .check((_argv) => true),
  handler: async (argv) => {
    await handleUpdate({
      name: argv['name'] as string,
    });
  },
};
