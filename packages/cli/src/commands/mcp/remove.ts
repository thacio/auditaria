/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'gemini mcp remove' command
import type { CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { t } from '@google/gemini-cli-core';

async function removeMcpServer(
  name: string,
  options: {
    scope: string;
  },
) {
  const { scope } = options;
  const settingsScope =
    scope === 'user' ? SettingScope.User : SettingScope.Workspace;
  const settings = loadSettings(process.cwd());

  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};

  if (!mcpServers[name]) {
    console.log(t('commands.mcp.manage.remove.not_found', `Server "${name}" not found in ${scope} settings.`, { name, scope }));
    return;
  }

  delete mcpServers[name];

  settings.setValue(settingsScope, 'mcpServers', mcpServers);

  console.log(t('commands.mcp.manage.remove.removed', `Server "${name}" removed from ${scope} settings.`, { name, scope }));
}

export const removeCommand: CommandModule = {
  command: 'remove <name>',
  describe: t('commands.mcp.manage.remove.description', 'Remove a server'),
  builder: (yargs) =>
    yargs
      .usage(t('commands.mcp.manage.remove.usage', 'Usage: auditaria mcp remove [options] <name>'))
      .positional('name', {
        describe: t('commands.mcp.manage.remove.name_description', 'Name of the server'),
        type: 'string',
        demandOption: true,
      })
      .option('scope', {
        alias: 's',
        describe: t('commands.mcp.manage.remove.scope_description', 'Configuration scope (user or project)'),
        type: 'string',
        default: 'project',
        choices: ['user', 'project'],
      }),
  handler: async (argv) => {
    await removeMcpServer(argv['name'] as string, {
      scope: argv['scope'] as string,
    });
  },
};
