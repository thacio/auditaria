/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type CommandModule } from 'yargs';
import { FatalConfigError, getErrorMessage, t } from '@thacio/auditaria-cli-core';
import { enableExtension } from '../../config/extension.js';
import { SettingScope } from '../../config/settings.js';

interface EnableArgs {
  name: string;
  scope?: SettingScope;
}

export function handleEnable(args: EnableArgs) {
  try {
    const scope = args.scope ? args.scope : SettingScope.User;
    enableExtension(args.name, scope);
    if (args.scope) {
      console.log(
        t('commands.extensions.enable.success_with_scope', `Extension "${args.name}" successfully enabled for scope "${args.scope}".`, {
          name: args.name,
          scope: args.scope,
        }),
      );
    } else {
      console.log(
        t('commands.extensions.enable.success_all_scopes', `Extension "${args.name}" successfully enabled in all scopes.`, {
          name: args.name,
        }),
      );
    }
  } catch (error) {
    throw new FatalConfigError(getErrorMessage(error));
  }
}

export const enableCommand: CommandModule = {
  command: 'enable [--scope] <name>',
  describe: t('commands.extensions.enable.description', 'Enables an extension.'),
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: t('commands.extensions.enable.name_description', 'The name of the extension to enable.'),
        type: 'string',
      })
      .option('scope', {
        describe: t('commands.extensions.enable.scope_description', 'The scope to enable the extension in. If not set, will be enabled in all scopes.'),
        type: 'string',
        choices: [SettingScope.User, SettingScope.Workspace],
      })
      .check((_argv) => true),
  handler: (argv) => {
    handleEnable({
      name: argv['name'] as string,
      scope: argv['scope'] as SettingScope,
    });
  },
};
