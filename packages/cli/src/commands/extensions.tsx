/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandModule } from 'yargs';
import { t } from '@thacio/auditaria-cli-core';
import { installCommand } from './extensions/install.js';
import { uninstallCommand } from './extensions/uninstall.js';

export const extensionsCommand: CommandModule = {
  command: 'extensions <command>',
  describe: t('commands.extensions.manage.description', 'Manage Auditaria CLI extensions.'),
  builder: (yargs) =>
    yargs
      .command(installCommand)
      .command(uninstallCommand)
      .demandCommand(1, t('commands.extensions.manage.need_command', 'You need at least one command before continuing.'))
      .version(false),
  handler: () => {
    // This handler is not called when a subcommand is provided.
    // Yargs will show the help menu.
  },
};
