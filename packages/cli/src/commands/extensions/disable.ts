/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandModule } from 'yargs';
import { disableExtension } from '../../config/extension.js';
import { SettingScope } from '../../config/settings.js';
import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionEnablementManager } from '../../config/extensions/extensionEnablement.js';
import { debugLogger, t } from '@thacio/auditaria-cli-core';

interface DisableArgs {
  name: string;
  scope?: string;
}

export function handleDisable(args: DisableArgs) {
  const extensionEnablementManager = new ExtensionEnablementManager();
  try {
    const scope =
      args.scope?.toLowerCase() === 'workspace'
        ? SettingScope.Workspace
        : SettingScope.User;
    disableExtension(args.name, scope, extensionEnablementManager);
    debugLogger.log(
      t(
        'commands.extensions.disable.success',
        `Extension "${args.name}" successfully disabled for scope "${args.scope ?? scope}".`,
        { name: args.name, scope: args.scope ?? scope },
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
  handler: (argv) => {
    handleDisable({
      name: argv['name'] as string,
      scope: argv['scope'] as string,
    });
  },
};
