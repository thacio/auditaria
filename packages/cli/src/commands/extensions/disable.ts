/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandModule } from 'yargs';
import { disableExtension } from '../../config/extension.js';
import { SettingScope } from '../../config/settings.js';
import { getErrorMessage } from '../../utils/errors.js';
import { t } from '@thacio/auditaria-cli-core';

interface DisableArgs {
  name: string;
  scope: SettingScope;
}

export function handleDisable(args: DisableArgs) {
  try {
    disableExtension(args.name, args.scope);
    console.log(
      t('commands.extensions.disable.success', `Extension "${args.name}" successfully disabled for scope "${args.scope}".`, { name: args.name, scope: args.scope }),
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exit(1);
  }
}

export const disableCommand: CommandModule = {
  command: 'disable [--scope] <name>',
  describe: t('commands.extensions.disable.description', 'Disables an extension.'),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('commands.extensions.disable.name_description', 'The name of the extension to disable.'),
        type: 'string',
      })
      .option('scope', {
        describe: t('commands.extensions.disable.scope_description', 'The scope to disable the extension in.'),
        type: 'string',
        default: SettingScope.User,
        choices: [SettingScope.User, SettingScope.Workspace],
      })
      .check((_argv) => true),
  handler: (argv) => {
    handleDisable({
      name: argv['name'] as string,
      scope: argv['scope'] as SettingScope,
    });
  },
};
